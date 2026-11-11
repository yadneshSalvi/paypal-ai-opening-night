import type { PayoutBatchObservation, PayoutItemObservation, PayoutRequestItem } from "@fracture/paypal-core";
import { DomainError, type Resource, type ShowSnapshot } from "../contracts";
import { digest } from "../hash";
import { personSettlement } from "../settlement/commands";
import type { SettlementState } from "../settlement/contracts";
import type { ItemRead, ItemStatus, PayoutGrant, PayoutGrantView, PayoutItemView, PayoutPerson, PayoutRecord, PayoutResult, PayoutReview, PayoutState, RecipientAdmission } from "./contracts";

export const PAYOUT_AUTHORITY_MS = 10 * 60 * 1000;
export const PAYOUT_READ_FRESH_MS = 5 * 60 * 1000;
export const payoutPersonDigest = (person: Resource) => digest({ id: person.id, name: person.name, role: person.role, kind: person.kind, skills: [...person.skills].sort() });
export function payoutRecords<K extends PayoutRecord["kind"]>(state: PayoutState, kind: K) { return state.records.filter(record => record.kind === kind) as Extract<PayoutRecord, { kind: K }>[]; }
export function payoutGrant(state: PayoutState, id: string) { const grant = payoutRecords(state, "grant").find(item => item.id === id); if (!grant) throw new DomainError("PAYOUT_NOT_FOUND", "This payout is not part of the current production.", 404); return grant; }
const released = new Set<ItemStatus>(["FAILED", "RETURNED", "REFUNDED", "REVERSED", "REVOKED", "NOT_SENT"]);
const itemStatuses = new Set<ItemStatus>(["SUCCESS", "FAILED", "PENDING", "UNCLAIMED", "RETURNED", "ONHOLD", "BLOCKED", "REFUNDED", "REVERSED"]);
const batchStatuses = new Set(["DENIED", "PENDING", "PROCESSING", "SUCCESS", "CANCELED"]);
export function exactPayoutItem(wanted: PayoutRequestItem, actual: PayoutItemObservation) { return wanted.senderItemId === actual.senderItemId && wanted.recipientType === actual.recipientType && wanted.receiver === actual.receiver && actual.money.currency === "USD" && actual.money.minor === wanted.money.minor; }
const validMoney = (value: { currency: string; minor: number } | null) => value === null || value.currency === "USD" && Number.isSafeInteger(value.minor) && value.minor >= 0;
export function validatePayoutBatch(grant: PayoutGrant, batch: PayoutBatchObservation, expectedId: string): string | null {
  if (batch.id !== expectedId || batch.senderBatchId !== grant.request.senderBatchId || !batch.complete || !batchStatuses.has(batch.status)) return "PAYOUT_BATCH_IDENTITY_UNVERIFIED";
  if (batch.items.length !== grant.items.length || new Set(batch.items.map(item => item.id)).size !== batch.items.length || new Set(batch.items.map(item => item.senderItemId)).size !== batch.items.length) return "PAYOUT_COLLECTION_INCOMPLETE";
  if (batch.items.some(item => item.batchId !== batch.id || !itemStatuses.has(item.status as ItemStatus) || !validMoney(item.fee)) || grant.items.some(item => !batch.items.some(actual => exactPayoutItem(item, actual)))) return "PAYOUT_ITEM_IDENTITY_UNVERIFIED";
  const total = grant.items.reduce((sum, item) => sum + item.money.minor, 0);
  if (!validMoney(batch.money) || batch.money && batch.money.minor !== total || !validMoney(batch.estimatedFees)) return "PAYOUT_TOTAL_UNVERIFIED";
  return null;
}
export function validatePayoutItem(grant: PayoutGrant, senderItemId: string, item: PayoutItemObservation, batch: PayoutBatchObservation): string | null {
  const wanted = grant.items.find(value => value.senderItemId === senderItemId), bound = batch.items.find(value => value.senderItemId === senderItemId);
  if (!wanted || !bound || bound.id !== item.id || item.batchId !== batch.id || !exactPayoutItem(wanted, item)) return "PAYOUT_ITEM_IDENTITY_UNVERIFIED";
  if (!itemStatuses.has(item.status as ItemStatus) || !validMoney(item.fee) || item.processedAt !== null && !Number.isFinite(Date.parse(item.processedAt))) return "PAYOUT_ITEM_STATUS_UNVERIFIED";
  return null;
}
export function provenNoPayout(result: PayoutResult<unknown>) {
  // A generic 400/422 may conceal a duplicate with an unusable original link.
  return result.outcome === "not_sent" || result.outcome === "refused" && !result.originalPayoutBatchId && [401, 403, 429].includes(result.httpStatus ?? 0);
}
export function latestBatchRead(state: PayoutState, grantId: string) { return payoutRecords(state, "batch_read").findLast(record => record.grantId === grantId) ?? null; }
export function ownedPayoutBatch(state: PayoutState, grantId: string): string | null {
  const verified = payoutRecords(state, "batch_read").findLast(record => record.grantId === grantId && record.verified && record.result.outcome === "succeeded");
  if (verified?.result.outcome === "succeeded") return verified.result.value.id;
  const result = payoutRecords(state, "dispatch_result").find(record => record.grantId === grantId)?.result;
  if (result?.outcome === "succeeded") return result.value.id;
  if (result?.originalPayoutBatchId) return result.originalPayoutBatchId;
  return null;
}
export function knownPayoutBatch(state: PayoutState, grantId: string): string | null { return ownedPayoutBatch(state, grantId) ?? payoutRecords(state, "locate").findLast(record => record.grantId === grantId)?.batchId ?? null; }
type ItemEvidence = ItemRead | Extract<PayoutRecord, { kind: "cancel_result" }>;
const itemEvidence = (state: PayoutState, grantId: string, senderItemId: string) => state.records.filter((record): record is ItemEvidence => (record.kind === "item_read" || record.kind === "cancel_result") && record.grantId === grantId && record.senderItemId === senderItemId);
export function payoutGrantView(show: ShowSnapshot, state: PayoutState, grant: PayoutGrant, now = Date.now()): PayoutGrantView {
  const dispatched = payoutRecords(state, "dispatch").some(record => record.grantId === grant.id), revoked = payoutRecords(state, "grant_revoked").some(record => record.grantId === grant.id);
  const creation = payoutRecords(state, "dispatch_result").find(record => record.grantId === grant.id)?.result, batch = latestBatchRead(state, grant.id), batchVerified = Boolean(batch?.verified && batch.result.outcome === "succeeded");
  const hold = payoutRecords(state, "dispatch_held").findLast(record => record.grantId === grant.id), noPayout = Boolean(creation && provenNoPayout(creation));
  const items = grant.items.map((allocation): PayoutItemView => {
    const evidence = itemEvidence(state, grant.id, allocation.senderItemId), last = evidence.at(-1), success = evidence.find(record => record.verified && record.result.outcome === "succeeded" && record.result.value.status === "SUCCESS");
    const valid = Boolean(batchVerified && last?.verified && last.result.outcome === "succeeded" && last.revision > batch!.revision);
    const result = valid && last?.result.outcome === "succeeded" ? last.result : null;
    const status: ItemStatus = revoked ? "REVOKED" : noPayout ? "NOT_SENT" : !dispatched ? "RESERVED" : result ? result.value.status as ItemStatus : batchVerified && !last ? "PENDING" : "UNKNOWN";
    const recipient = payoutRecords(state, "recipient").find(value => value.id === allocation.recipientId);
    const request = payoutRecords(state, "cancel_request").findLast(value => value.grantId === grant.id && value.senderItemId === allocation.senderItemId), cancelResult = request ? payoutRecords(state, "cancel_result").findLast(value => value.cancellationId === request.id) : null;
    const cancellation: PayoutItemView["cancellation"] = !request ? null : { id: request.id, state: result?.value.status === "RETURNED" ? "returned" : cancelResult ? provenNoPayout(cancelResult.result) ? "not_sent" : "held" : payoutRecords(state, "cancel_dispatch").some(value => value.cancellationId === request.id) ? "checking" : "queued" };
    const canCancel = status === "UNCLAIMED" && result && now - Date.parse(result.observedAt) <= PAYOUT_READ_FRESH_MS && (!cancellation || cancellation.state === "not_sent");
    return { senderItemId: allocation.senderItemId, personId: allocation.personId, personName: allocation.personName, recipientId: allocation.recipientId, recipientLabel: recipient?.admission.label ?? "Approved original recipient", receiver: allocation.receiver, recipientType: allocation.recipientType, amountMinor: allocation.money.minor, status, providerItemId: result?.value.id ?? (batchVerified && batch?.result.outcome === "succeeded" ? batch.result.value.items.find(value => value.senderItemId === allocation.senderItemId)?.id ?? null : null), historicalSuccess: Boolean(success), historicalSuccessAt: success?.recordedAt ?? null, currentVerified: valid, feeMinor: result?.value.fee?.minor ?? null, observedAt: last?.result.observedAt ?? null, problem: last && !valid ? last.problem ?? "PAYOUT_CURRENT_READ_REQUIRED" : null, transport: last?.result.transport ?? null, reservedMinor: released.has(status) ? 0 : allocation.money.minor, cancellation, cancelReviewDigest: canCancel && result ? digest({ grantId: grant.id, senderItemId: allocation.senderItemId, item: result.value, payoutRevision: state.revision, productionRevision: show.revision }) : null };
  });
  const resolved = items.every(item => item.currentVerified && (item.status === "SUCCESS" || released.has(item.status)) || item.status === "NOT_SENT" || item.status === "REVOKED");
  const problem = hold?.code ?? batch?.problem ?? (creation && creation.outcome !== "succeeded" ? creation.code : null);
  return { id: grant.id, createdAt: grant.recordedAt, expiresAt: grant.expiresAt, detail: grant.detail, reviewDigest: grant.reviewDigest, status: revoked ? "revoked" : resolved ? "resolved" : hold || dispatched && !knownPayoutBatch(state, grant.id) ? "held" : dispatched ? "checking" : "queued", providerBatchId: knownPayoutBatch(state, grant.id), batchStatus: batchVerified && batch?.result.outcome === "succeeded" ? batch.result.value.status : null, batchVerified, amountMinor: grant.items.reduce((sum, item) => sum + item.money.minor, 0), items, canRevoke: !dispatched && !revoked, canLocate: dispatched && !noPayout && !ownedPayoutBatch(state, grant.id), problem };
}
export function payoutPeople(show: ShowSnapshot, settlement: SettlementState, state: PayoutState, admissions: RecipientAdmission[], merchantFingerprint: string | null, now = Date.now(), excludeGrantId?: string): PayoutPerson[] {
  const grants = payoutRecords(state, "grant").filter(grant => grant.id !== excludeGrantId).map(grant => payoutGrantView(show, state, grant, now));
  return show.resources.filter(resource => resource.kind === "person").map(resource => {
    const work = personSettlement(show, settlement, resource.id), recipients = payoutRecords(state, "recipient").filter(value => value.personId === resource.id), latest = recipients.at(-1) ?? null;
    const currentRecipient = latest && !payoutRecords(state, "recipient_revoked").some(value => value.recipientId === latest.id) ? latest : null, items = grants.flatMap(grant => grant.items).filter(item => item.personId === resource.id);
    const allocatedMinor = items.reduce((sum, item) => sum + item.reservedMinor, 0), availableMinor = Math.max(0, work.approvedBalanceMinor - allocatedMinor), blockers: string[] = [];
    if (work.pendingReports) blockers.push("A personal report or correction still needs producer review.");
    if (!currentRecipient) blockers.push("Approve an exact admitted recipient for this person.");
    else if (currentRecipient.personDigest !== payoutPersonDigest(resource) || !admissions.some(item => item.id === currentRecipient.admission.id && item.digest === currentRecipient.admission.digest && item.personId === resource.id && item.tenantId === show.tenantId && item.merchantFingerprint === merchantFingerprint && Date.parse(item.expiresAt) > now)) blockers.push("The approved recipient, admitted account, merchant or roster changed or expired.");
    if (!merchantFingerprint) blockers.push("The isolated venue payout account is not configured.");
    if (items.some(item => !released.has(item.status) && item.status !== "SUCCESS")) blockers.push("An earlier payout still reserves this person's liability. Resolve its original items first.");
    if (items.some(item => !["REVOKED", "NOT_SENT"].includes(item.status) && (!item.currentVerified || !item.observedAt || now - Date.parse(item.observedAt) > PAYOUT_READ_FRESH_MS))) blockers.push("Refresh the exact earlier provider items before authorizing another payout.");
    if (work.approvedBalanceMinor < allocatedMinor) blockers.push("Approved liability is below the amount already paid or reserved. Review this credit separately; no automatic deduction is authorized.");
    if (!availableMinor) blockers.push("No unallocated approved liability is available.");
    if (currentRecipient && availableMinor > currentRecipient.admission.maxPayoutMinor) blockers.push("The exact amount exceeds this admitted recipient's approved limit.");
    const payables = work.payables.map(item => ({ id: item.id, digest: digest(item), deltaMinor: item.deltaMinor }));
    const preview = !blockers.length && currentRecipient ? { personId: resource.id, personName: resource.name, personDigest: payoutPersonDigest(resource), recipientId: currentRecipient.id, recipientDigest: digest(currentRecipient), receiver: currentRecipient.admission.receiver, recipientType: currentRecipient.admission.recipientType, money: { currency: "USD", minor: availableMinor }, liabilityMinor: work.approvedBalanceMinor, alreadyAllocatedMinor: allocatedMinor, payables } : null;
    return { person: work.person, recipients, currentRecipient, liabilityMinor: work.approvedBalanceMinor, allocatedMinor, availableMinor, pendingReports: work.pendingReports, payables, blockers, preview };
  });
}
export function payoutReview(show: ShowSnapshot, settlement: SettlementState, state: PayoutState, people: PayoutPerson[], personIds: string[], merchantFingerprint: string | null): PayoutReview {
  const selected = [...personIds].sort(), blockers: string[] = [], items = [] as PayoutReview["items"];
  if (!selected.length || selected.length > 20 || new Set(selected).size !== selected.length) blockers.push("Choose between one and twenty distinct crew members.");
  for (const id of selected) { const person = people.find(value => value.person.id === id); if (!person) blockers.push("A selected person is not on this production."); else if (!person.preview) blockers.push(...person.blockers.map(reason => person.person.name + ": " + reason)); else items.push(person.preview); }
  const amountMinor = items.reduce((sum, item) => sum + item.money.minor, 0);
  if (!merchantFingerprint || !Number.isSafeInteger(amountMinor) || amountMinor < 1 || amountMinor > 10000000) blockers.push("The exact merchant and a positive batch of at most 100,000 USD are required.");
  const body = { personIds: selected, items, amountMinor, merchantFingerprint: merchantFingerprint ?? "", blockers };
  return { ...body, digest: digest({ ...body, productionRevision: show.revision, settlementRevision: settlement.revision, payoutRevision: state.revision }) };
}
