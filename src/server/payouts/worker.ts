import type { OwnedPayoutItem, PayoutBatchObservation, PayoutItemObservation } from "@fracture/paypal-core";
import type { PoolClient } from "pg";
import { DomainError } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { PayoutGrant, PayoutResult, PayoutState } from "@/domain/payouts/contracts";
import { knownPayoutBatch, latestBatchRead, payoutGrant, payoutGrantView, payoutPeople, payoutRecords, provenNoPayout, validatePayoutBatch, validatePayoutItem } from "@/domain/payouts/policy";
import { withCommerceLock } from "../commerce-locks";
import { enqueueJob, type JobResult } from "../jobs";
import { assertSettlementAuthority, readState } from "../settlement/service";
import { interruptedPayout, payoutCapability, payoutGateway, payoutResult } from "./provider";
import { appendPayoutRecord, bindPayoutResource, payoutShow, payoutTransaction, readPayoutState } from "./store";

export const payoutJobKinds = ["payout_batch", "payout_item", "payout_cancel"] as const;
const complete = { status: "complete" } as const;
const hold = (code: string): JobResult => ({ status: "needs_attention", code });
const waiting = (code: string): JobResult => ({ status: "waiting", code });
const safeCode = (error: unknown) => error instanceof DomainError ? error.code : "PAYOUT_AUTHORITY_UNVERIFIED";
async function readOriginal(tenantId: string, grantId: string) { return payoutTransaction(async db => { const show = await payoutShow(db, tenantId), state = await readPayoutState(db, show); return { show, state, grant: payoutGrant(state, grantId) }; }); }
async function bindBatch(db: PoolClient, tenantId: string, grant: PayoutGrant, batch: PayoutBatchObservation) {
  await bindPayoutResource(db, { merchant: grant.merchantFingerprint, kind: "batch", providerId: batch.id, tenantId, grantId: grant.id });
  for (const item of batch.items) await bindPayoutResource(db, { merchant: grant.merchantFingerprint, kind: "item", providerId: item.id, tenantId, grantId: grant.id, senderItemId: item.senderItemId });
}
function transitionProblem(state: PayoutState, grantId: string, senderItemId: string, current: PayoutItemObservation) {
  const earlier = state.records.filter(record => (record.kind === "item_read" || record.kind === "cancel_result") && record.grantId === grantId && record.senderItemId === senderItemId && record.verified && record.result.outcome === "succeeded");
  const previous = earlier.at(-1);
  if (!previous || !("result" in previous) || previous.result.outcome !== "succeeded") return null;
  const before = previous.result.value as PayoutItemObservation;
  if (before.status === "SUCCESS" && !["SUCCESS", "RETURNED", "REFUNDED", "REVERSED"].includes(current.status) || ["FAILED", "RETURNED", "REFUNDED", "REVERSED"].includes(before.status) && current.status !== before.status) return "PAYOUT_STATUS_REGRESSION";
  return null;
}

async function batchJob(tenantId: string, grantId: string, signal: AbortSignal): Promise<JobResult> {
  const claim = await payoutTransaction(async db => {
    const show = await payoutShow(db, tenantId, true), state = await readPayoutState(db, show), grant = payoutGrant(state, grantId);
    if (payoutRecords(state, "grant_revoked").some(record => record.grantId === grantId)) return { grant, dispatch: false, done: true };
    if (payoutRecords(state, "dispatch").some(record => record.grantId === grantId)) return { grant, dispatch: false, done: false };
    if (payoutRecords(state, "dispatch_held").some(record => record.grantId === grantId)) return { grant, dispatch: false, done: false, problem: "PAYOUT_REVIEW_REQUIRED" };
    let problem: string | null = null;
    try {
      signal.throwIfAborted();
      await assertSettlementAuthority(db, { ...grant.authority, scope: "production" }, show);
      if (Date.now() >= Date.parse(grant.expiresAt)) throw new DomainError("PAYOUT_AUTHORITY_EXPIRED", "The original payout authority expired.");
      if (show.revision !== grant.productionRevision || (show.settlementVersion ?? 0) !== grant.settlementRevision) throw new DomainError("PAYOUT_PRODUCTION_CHANGED", "The production or reported liability changed after review.");
      const settlement = await readState(db, show), { capability, admissions } = payoutCapability(show);
      if (!capability.configured || capability.merchantFingerprint !== grant.merchantFingerprint) throw new DomainError("PAYOUT_MERCHANT_CHANGED", "The isolated merchant no longer matches this review.");
      const people = payoutPeople(show, settlement, state, admissions, capability.merchantFingerprint, Date.now(), grant.id);
      for (const allocation of grant.items) {
        const { senderItemId: ignored, ...wanted } = allocation; void ignored;
        if (digest(people.find(person => person.person.id === allocation.personId)?.preview ?? null) !== digest(wanted)) throw new DomainError("PAYOUT_ALLOCATION_CHANGED", "The exact payee, liability or earlier payment evidence changed.");
      }
      payoutGateway(grant.merchantFingerprint);
    } catch (error) { problem = safeCode(error); }
    if (problem) { await appendPayoutRecord(db, show, state, { kind: "dispatch_held", grantId, code: problem }, { request: { grantId, reviewDigest: grant.reviewDigest }, semanticKey: grantId }); return { grant, dispatch: false, done: false, problem }; }
    await appendPayoutRecord(db, show, state, { kind: "dispatch", grantId, providerRequestDigest: digest(grant.request) }, { request: grant.request, semanticKey: grantId });
    return { grant, dispatch: true, done: false };
  });
  if (claim.done) return complete;
  if (claim.problem) return hold(claim.problem);
  if (claim.dispatch) {
    const { gateway, transport } = payoutGateway(claim.grant.merchantFingerprint);
    let result: PayoutResult<PayoutBatchObservation>;
    try { result = payoutResult(await gateway.createPayout(claim.grant.request, signal), transport); }
    catch { result = interruptedPayout(transport); }
    await payoutTransaction(async db => { const show = await payoutShow(db, tenantId, true), state = await readPayoutState(db, show); await appendPayoutRecord(db, show, state, { kind: "dispatch_result", grantId, result }, { request: { grantId, providerRequestDigest: digest(claim.grant.request) }, semanticKey: grantId }); });
    if (provenNoPayout(result)) return complete;
    return result.outcome === "succeeded" || result.originalPayoutBatchId ? { status: "waiting", code: "PAYOUT_ORIGINAL_READ_REQUIRED", delaySeconds: 1 } : hold("PAYOUT_ORIGINAL_ID_REQUIRED");
  }
  // Once a durable dispatch exists, every continuation is an original-resource GET.
  const original = await readOriginal(tenantId, grantId), creation = payoutRecords(original.state, "dispatch_result").find(record => record.grantId === grantId)?.result;
  if (creation && provenNoPayout(creation)) return complete;
  const batchId = knownPayoutBatch(original.state, grantId);
  if (!batchId) return hold("PAYOUT_ORIGINAL_ID_REQUIRED");
  const { gateway, transport } = payoutGateway(original.grant.merchantFingerprint);
  let result: PayoutResult<PayoutBatchObservation>;
  try { result = payoutResult(await gateway.getPayoutBatch(batchId, original.grant.request.senderBatchId, signal), transport); }
  catch { result = interruptedPayout(transport); }
  return payoutTransaction(async db => {
    const show = await payoutShow(db, tenantId, true), state = await readPayoutState(db, show), grant = payoutGrant(state, grantId);
    let problem = result.outcome === "succeeded" ? validatePayoutBatch(grant, result.value, batchId) : result.code;
    if (!problem && result.outcome === "succeeded") {
      await db.query("SAVEPOINT payout_bindings");
      try { await bindBatch(db, tenantId, grant, result.value); }
      catch (error) { await db.query("ROLLBACK TO SAVEPOINT payout_bindings"); problem = safeCode(error); }
      await db.query("RELEASE SAVEPOINT payout_bindings");
    }
    const saved = await appendPayoutRecord(db, show, state, { kind: "batch_read", grantId, result, verified: !problem, problem }, { request: { grantId, batchId, senderBatchId: grant.request.senderBatchId } });
    if (problem) return result.outcome === "succeeded" ? hold(problem) : waiting(problem);
    for (const item of grant.items) await enqueueJob(db, { tenantId, kind: "payout_item", semanticKey: `${saved.record.id}:${item.senderItemId}`, payload: { grantId, senderItemId: item.senderItemId, batchReadId: saved.record.id } });
    return complete;
  });
}

async function itemJob(tenantId: string, grantId: string, senderItemId: string, batchReadId: string, signal: AbortSignal): Promise<JobResult> {
  const original = await readOriginal(tenantId, grantId), batch = latestBatchRead(original.state, grantId);
  // A newer batch read has its own item jobs. An obsolete one cannot restore readiness.
  if (batch?.id !== batchReadId) return complete;
  if (!batch.verified || batch.result.outcome !== "succeeded") return hold("PAYOUT_COMPLETE_BATCH_REQUIRED");
  const item = batch.result.value.items.find(value => value.senderItemId === senderItemId);
  if (!item) return hold("PAYOUT_ITEM_NOT_BOUND");
  const { gateway, transport } = payoutGateway(original.grant.merchantFingerprint);
  let result: PayoutResult<PayoutItemObservation>;
  try { result = payoutResult(await gateway.getPayoutItem(item.id, signal), transport); }
  catch { result = interruptedPayout(transport); }
  return payoutTransaction(async db => {
    const show = await payoutShow(db, tenantId, true), state = await readPayoutState(db, show), grant = payoutGrant(state, grantId), currentBatch = latestBatchRead(state, grantId);
    if (currentBatch?.id !== batchReadId || currentBatch.result.outcome !== "succeeded") return complete;
    const problem = result.outcome === "succeeded" ? validatePayoutItem(grant, senderItemId, result.value, currentBatch.result.value) ?? transitionProblem(state, grantId, senderItemId, result.value) : result.code;
    await appendPayoutRecord(db, show, state, { kind: "item_read", grantId, senderItemId, result, verified: !problem, problem }, { request: { grantId, senderItemId, itemId: item.id, batchReadId } });
    if (problem) return result.outcome === "succeeded" ? hold(problem) : waiting(problem);
    if (result.outcome === "succeeded" && ["PENDING", "ONHOLD"].includes(result.value.status)) return waiting("PAYOUT_ITEM_PENDING");
    return result.outcome === "succeeded" && result.value.status === "BLOCKED" ? hold("PAYOUT_ITEM_BLOCKED") : complete;
  });
}

async function cancelJob(tenantId: string, grantId: string, cancellationId: string, signal: AbortSignal): Promise<JobResult> {
  const claim = await payoutTransaction(async db => {
    const show = await payoutShow(db, tenantId, true), state = await readPayoutState(db, show), grant = payoutGrant(state, grantId), cancel = payoutRecords(state, "cancel_request").find(record => record.id === cancellationId && record.grantId === grantId);
    if (!cancel) throw new DomainError("PAYOUT_CANCELLATION_NOT_FOUND", "The original cancellation is absent.", 404);
    const batch = latestBatchRead(state, grantId), allocation = grant.items.find(item => item.senderItemId === cancel.senderItemId), item = payoutGrantView(show, state, grant).items.find(item => item.senderItemId === cancel.senderItemId);
    if (!allocation || !item || !batch?.verified || batch.result.outcome !== "succeeded" || item.providerItemId !== cancel.itemId) return { grant, cancel, owned: null, dispatch: false, problem: "PAYOUT_COMPLETE_BATCH_REQUIRED" };
    const owned: OwnedPayoutItem = { senderItemId: allocation.senderItemId, recipientType: allocation.recipientType, receiver: allocation.receiver, money: allocation.money, id: cancel.itemId, batchId: batch.result.value.id };
    if (payoutRecords(state, "cancel_dispatch").some(record => record.cancellationId === cancellationId)) return { grant, cancel, owned, dispatch: false, problem: null };
    const prior = payoutRecords(state, "cancel_result").find(record => record.cancellationId === cancellationId);
    if (prior) return { grant, cancel, owned, dispatch: false, problem: prior.problem ?? "PAYOUT_CANCEL_REVIEW_REQUIRED" };
    let problem: string | null = null;
    try {
      signal.throwIfAborted(); await assertSettlementAuthority(db, { ...cancel.authority, scope: "production" }, show);
      if (Date.now() >= Date.parse(cancel.expiresAt) || show.revision !== cancel.productionRevision) throw new DomainError("PAYOUT_CANCEL_REVIEW_STALE", "The cancellation review changed or expired.");
      if (!item.currentVerified || item.status !== "UNCLAIMED") throw new DomainError("PAYOUT_NOT_UNCLAIMED", "The original item is no longer verified unclaimed.");
      payoutGateway(grant.merchantFingerprint);
    } catch (error) { problem = safeCode(error); }
    if (problem) {
      const capability = payoutCapability(show), transport = capability.capability.mode === "controlled_fixture" ? "local_fixture" as const : "paypal_https" as const;
      const result: PayoutResult<PayoutItemObservation> = { ...interruptedPayout(transport), outcome: "not_sent", code: problem, originalPayoutBatchId: null };
      await appendPayoutRecord(db, show, state, { kind: "cancel_result", grantId, senderItemId: cancel.senderItemId, cancellationId, result, verified: false, problem }, { request: { grantId, cancellationId, itemId: cancel.itemId }, semanticKey: cancellationId });
      return { grant, cancel, owned, dispatch: false, problem };
    }
    await appendPayoutRecord(db, show, state, { kind: "cancel_dispatch", grantId, cancellationId }, { request: { grantId, cancellationId, owned }, semanticKey: cancellationId });
    return { grant, cancel, owned, dispatch: true, problem: null };
  });
  if (claim.problem || !claim.owned) return hold(claim.problem ?? "PAYOUT_COMPLETE_BATCH_REQUIRED");
  const { gateway, transport } = payoutGateway(claim.grant.merchantFingerprint);
  let result: PayoutResult<PayoutItemObservation>;
  try { result = payoutResult(await (claim.dispatch ? gateway.cancelUnclaimedPayout(claim.owned, signal) : gateway.getPayoutItem(claim.owned.id, signal)), transport); }
  catch { result = interruptedPayout(transport); }
  return payoutTransaction(async db => {
    const show = await payoutShow(db, tenantId, true), state = await readPayoutState(db, show), batch = latestBatchRead(state, grantId);
    const problem = result.outcome !== "succeeded" ? result.code : !batch?.verified || batch.result.outcome !== "succeeded" ? "PAYOUT_COMPLETE_BATCH_REQUIRED" : validatePayoutItem(claim.grant, claim.cancel.senderItemId, result.value, batch.result.value) ?? transitionProblem(state, grantId, claim.cancel.senderItemId, result.value);
    await appendPayoutRecord(db, show, state, { kind: "cancel_result", grantId, senderItemId: claim.cancel.senderItemId, cancellationId, result, verified: !problem, problem }, { request: { grantId, cancellationId, itemId: claim.cancel.itemId, action: claim.dispatch ? "cancel" : "read_original" } });
    if (result.outcome === "not_sent" || result.outcome === "refused") return hold(problem ?? "PAYOUT_CANCEL_NOT_SENT");
    if (!problem && result.outcome === "succeeded" && result.value.status === "RETURNED") return complete;
    return waiting(problem ?? "PAYOUT_CANCELLATION_UNVERIFIED");
  });
}

export async function runPayoutJob(tenantId: string, kind: typeof payoutJobKinds[number], payload: { grantId: string; senderItemId?: string; batchReadId?: string; cancellationId?: string }, signal: AbortSignal): Promise<JobResult> {
  return withCommerceLock(`payout:${tenantId}:${payload.grantId}`, () => kind === "payout_batch" ? batchJob(tenantId, payload.grantId, signal) : kind === "payout_item" ? itemJob(tenantId, payload.grantId, payload.senderItemId!, payload.batchReadId!, signal) : cancelJob(tenantId, payload.grantId, payload.cancellationId!, signal));
}
