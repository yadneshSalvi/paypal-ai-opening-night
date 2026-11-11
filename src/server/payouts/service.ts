import { randomUUID } from "node:crypto";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { requireCrewPerson } from "@/domain/crew/policy";
import { digest } from "@/domain/hash";
import { payoutEnvelopeSchema, type PayoutData, type PayoutEnvelope, type PayoutRecord, type PayoutState, type PersonalPayoutData, type PayoutCommandResponse } from "@/domain/payouts/contracts";
import { PAYOUT_AUTHORITY_MS, payoutGrant, payoutGrantView, payoutPeople, payoutPersonDigest, payoutRecords, payoutReview } from "@/domain/payouts/policy";
import type { SettlementState } from "@/domain/settlement/contracts";
import { enqueueJob } from "../jobs";
import { assertSettlementAuthority, readState, type SettlementAuthority } from "../settlement/service";
import { payoutCapability } from "./provider";
import { appendPayoutRecord, payoutRequestHash, payoutShow, payoutTransaction, readPayoutState, type PayoutPayload } from "./store";

function denied(code: string, message: string): never { throw new DomainError(code, message, 409); }
export const payoutReceipt = (record: PayoutRecord) => ({ id: record.id, commandId: record.commandId, requestDigest: record.requestDigest, actorId: record.actorId!, kind: record.kind, recordedAt: record.recordedAt, digest: digest(record) });
export function payoutData(show: ShowSnapshot, settlement: SettlementState, state: PayoutState, authority: SettlementAuthority): PayoutData {
  const { capability, admissions } = payoutCapability(show), people = payoutPeople(show, settlement, state, admissions, capability.merchantFingerprint), grants = payoutRecords(state, "grant").map(grant => payoutGrantView(show, state, grant));
  const items = grants.flatMap(grant => grant.items);
  return { schemaVersion: 1, scope: "production", actorId: authority.actor.id, tenantId: show.tenantId, revision: state.revision, settlementRevision: settlement.revision, productionRevision: show.revision, serverAt: new Date().toISOString(), capability, admissions, people, grants, receipts: state.records.filter(record => record.actorId !== null).map(payoutReceipt), totals: {
    approvedLiabilityMinor: people.reduce((sum, person) => sum + person.liabilityMinor, 0), reservedMinor: items.filter(item => item.status !== "SUCCESS").reduce((sum, item) => sum + item.reservedMinor, 0), currentPaidMinor: items.filter(item => item.currentVerified && item.status === "SUCCESS").reduce((sum, item) => sum + item.amountMinor, 0), historicalPaidMinor: items.filter(item => item.historicalSuccess).reduce((sum, item) => sum + item.amountMinor, 0), observedFeeMinor: items.reduce((sum, item) => sum + (item.feeMinor ?? 0), 0), feesUnknown: items.filter(item => !["REVOKED", "NOT_SENT"].includes(item.status) && item.feeMinor === null).length,
  } };
}
function producer(authority: SettlementAuthority) { if (authority.scope !== "production") throw new DomainError("PAYOUT_SCOPE_DENIED", "Payout instructions require the current producer access.", 403); }
export async function readPayouts(authority: SettlementAuthority): Promise<PayoutData> {
  producer(authority);
  return payoutTransaction(async db => { const show = await payoutShow(db, authority.actor.tenantId); await assertSettlementAuthority(db, authority, show); return payoutData(show, await readState(db, show), await readPayoutState(db, show), authority); });
}
export async function readPersonalPayouts(authority: SettlementAuthority): Promise<PersonalPayoutData> {
  if (authority.scope !== "personal") throw new DomainError("PAYOUT_SCOPE_DENIED", "Open this person's exact personal access.", 403);
  return payoutTransaction(async db => {
    const show = await payoutShow(db, authority.actor.tenantId); await assertSettlementAuthority(db, authority, show); const person = requireCrewPerson(show, authority.actor), state = await readPayoutState(db, show);
    return { schemaVersion: 1, scope: "personal", actorId: authority.actor.id, personId: person.id, serverAt: new Date().toISOString(), items: payoutRecords(state, "grant").flatMap(grant => payoutGrantView(show, state, grant).items.filter(item => item.personId === person.id).map(item => ({ ...item, grantId: grant.id, createdAt: grant.recordedAt }))) };
  });
}
export async function readPayoutReview(authority: SettlementAuthority, personIds: string[]) {
  producer(authority);
  return payoutTransaction(async db => { const show = await payoutShow(db, authority.actor.tenantId); await assertSettlementAuthority(db, authority, show); const settlement = await readState(db, show), state = await readPayoutState(db, show), data = payoutData(show, settlement, state, authority); return { data, review: payoutReview(show, settlement, state, data.people, personIds, data.capability.merchantFingerprint) }; });
}
export async function executePayout(authority: SettlementAuthority, raw: PayoutEnvelope): Promise<PayoutCommandResponse> {
  producer(authority); const envelope = payoutEnvelopeSchema.parse(raw), requestHash = payoutRequestHash(authority.actor.id, authority.sessionHash, envelope);
  return payoutTransaction(async db => {
    const show = await payoutShow(db, authority.actor.tenantId, true); await assertSettlementAuthority(db, authority, show);
    const state = await readPayoutState(db, show), settlement = await readState(db, show);
    const previous = (await db.query<{ payload_hash: string }>("SELECT payload_hash FROM on_commands WHERE tenant_id=$1 AND command_id=$2", [show.tenantId, envelope.idempotencyKey])).rows[0];
    if (previous) {
      if (previous.payload_hash !== requestHash) denied("IDEMPOTENCY_CONFLICT", "This saved identity belongs to different payout instructions or access. Check its original receipt.");
      const record = state.records.find(item => item.commandId === envelope.idempotencyKey);
      if (!record) throw new DomainError("PAYOUT_RECEIPT_UNAVAILABLE", "The original payout receipt cannot be verified. No replacement instruction was created.", 503);
      return { data: payoutData(show, settlement, state, authority), receipt: payoutReceipt(record), replayed: true };
    }
    if (envelope.expectedRevision !== state.revision || envelope.expectedSettlementRevision !== settlement.revision || envelope.expectedShowRevision !== show.revision) denied("PAYOUT_REVIEW_STALE", "The production, reported work or payout history changed. Refresh and review its exact current balance and recipients.");
    const data = payoutData(show, settlement, state, authority), command = envelope.command, id = randomUUID(), expiresAt = new Date(Date.now() + PAYOUT_AUTHORITY_MS).toISOString();
    let payload: PayoutPayload, work: { kind: "payout_batch" | "payout_cancel"; grantId: string; cancellationId?: string } | undefined;
    switch (command.type) {
      case "approve_recipient": {
        const person = show.resources.find(item => item.id === command.personId && item.kind === "person"), prior = payoutRecords(state, "recipient").filter(item => item.personId === command.personId).at(-1);
        const admission = data.admissions.find(item => item.id === command.admissionId && item.digest === command.admissionDigest && item.personId === command.personId && Date.parse(item.expiresAt) > Date.now());
        if (!person || !admission || admission.merchantFingerprint !== data.capability.merchantFingerprint || (prior?.id ?? null) !== command.previousId) denied("PAYOUT_RECIPIENT_CHANGED", "The exact admitted account, roster or preceding recipient version changed. Review the current admission.");
        payload = { kind: "recipient", personId: person.id, personName: person.name, personDigest: payoutPersonDigest(person), version: (prior?.version ?? 0) + 1, previousId: prior?.id ?? null, admission, detail: command.detail }; break;
      }
      case "revoke_recipient": {
        const recipient = payoutRecords(state, "recipient").find(item => item.id === command.recipientId);
        if (!recipient || payoutRecords(state, "recipient_revoked").some(item => item.recipientId === recipient.id)) denied("PAYOUT_RECIPIENT_CHANGED", "This recipient version is absent or already revoked.");
        payload = { kind: "recipient_revoked", recipientId: recipient.id, detail: command.detail }; break;
      }
      case "approve_payout": {
        const review = payoutReview(show, settlement, state, data.people, command.personIds, data.capability.merchantFingerprint);
        if (review.blockers.length || command.reviewDigest !== review.digest) denied("PAYOUT_REVIEW_CHANGED", "The exact liability, credits, recipient or earlier payment evidence no longer matches this review. Refresh before authorizing.");
        const items = review.items.map(item => ({ ...item, senderItemId: randomUUID() }));
        payload = { kind: "grant", merchantFingerprint: review.merchantFingerprint, expiresAt, settlementRevision: settlement.revision, reviewDigest: review.digest, detail: command.detail, authority: { actor: authority.actor, sessionHash: authority.sessionHash }, items, request: { senderBatchId: "opening-night-" + id, requestId: id, items: items.map(item => ({ senderItemId: item.senderItemId, recipientType: item.recipientType, receiver: item.receiver, money: item.money })) } };
        work = { kind: "payout_batch", grantId: id }; break;
      }
      default: {
        const grant = payoutGrant(state, command.grantId), view = payoutGrantView(show, state, grant);
        if (command.type === "revoke_payout") {
          if (!view.canRevoke) denied("PAYOUT_ALREADY_CLAIMED", "This instruction was already claimed or revoked. Read its original provider items; revocation cannot undo a transfer.");
          payload = { kind: "grant_revoked", grantId: grant.id, detail: command.detail };
        } else if (command.type === "refresh_payout") {
          if (!payoutRecords(state, "dispatch").some(item => item.grantId === grant.id)) denied("PAYOUT_NOT_DISPATCHED", "This instruction has not reached dispatch. Continue its saved work or revoke it before a new review.");
          payload = { kind: "refresh", grantId: grant.id }; work = { kind: "payout_batch", grantId: grant.id };
        } else if (command.type === "locate_original") {
          if (!view.canLocate) denied("PAYOUT_ORIGINAL_ALREADY_BOUND", "The original provider identity is already known or this instruction was never dispatched.");
          payload = { kind: "locate", grantId: grant.id, batchId: command.batchId, detail: command.detail }; work = { kind: "payout_batch", grantId: grant.id };
        } else {
          const item = view.items.find(item => item.senderItemId === command.senderItemId);
          if (!item?.providerItemId || !item.cancelReviewDigest || item.cancelReviewDigest !== command.reviewDigest) denied("PAYOUT_CANCEL_REVIEW_CHANGED", "Only this exact currently verified unclaimed item can be reviewed for cancellation. Refresh the original item first.");
          payload = { kind: "cancel_request", grantId: grant.id, senderItemId: item.senderItemId, itemId: item.providerItemId, reviewDigest: command.reviewDigest, detail: command.detail, expiresAt, authority: { actor: authority.actor, sessionHash: authority.sessionHash } }; work = { kind: "payout_cancel", grantId: grant.id, cancellationId: id };
        }
      }
    }
    const result = await appendPayoutRecord(db, show, state, payload, { request: envelope, authority, commandId: envelope.idempotencyKey, id });
    if (work) await enqueueJob(db, { tenantId: show.tenantId, kind: work.kind, semanticKey: id, payload: { grantId: work.grantId, ...(work.cancellationId ? { cancellationId: work.cancellationId } : {}) } });
    return { data: payoutData(result.show, settlement, result.state, authority), receipt: payoutReceipt(result.record), replayed: false };
  });
}
