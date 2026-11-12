import { DomainError } from "@/domain/contracts";
import { currentActual } from "@/domain/finance";
import { preparePaymentIntent } from "../payment-intents";
import { paymentStore, readIntent } from "../payment-store";
import { getShow, pool } from "../store";
import { env } from "../env";
import type { JobResult } from "../jobs";
import { assertDecisionInventory, disruptionTransaction, readDecision, readRemedyItem, requireDisruptionAuthority } from "./store";

export async function runEventRemedy(tenantId: string, decisionId: string, itemId: string, signal: AbortSignal, retryIntentId?: string): Promise<JobResult> {
  await paymentStore();
  const original = await readRemedyItem(tenantId, itemId), record = await readDecision(tenantId, decisionId);
  if (original.allocation.decisionId !== decisionId) throw new DomainError("EVENT_REMEDY_OWNERSHIP", "This refund item belongs to another cancellation.", 403);
  const show = await getShow(tenantId);
  const confirmed = currentActual(show).find(entry => entry.kind === "refund" && entry.purpose === "event_remedy" && entry.operationId === original.progress.intentId && entry.allocation?.decisionId === decisionId && entry.parentId === original.allocation.captureId && entry.amountMinor === original.allocation.amountMinor);
  if (confirmed) return { status: "complete" };
  if (env.controlledQa) return { status: "needs_attention", code: "PROVIDER_QA_DISABLED" };
  let intentId = original.progress.intentId;
  if (!intentId) {
    if (retryIntentId) throw new DomainError("ORIGINAL_INTENT_REQUIRED", "A retry must name the original prepared instruction.");
    if (show.cancellationDecision?.id !== decisionId || show.cancellationDecision.remediesStoppedAt || Date.parse(record.decision.expiresAt) <= Date.now()) return { status: "needs_attention", code: "EVENT_REMEDY_AUTHORITY_ENDED" };
    intentId = await disruptionTransaction({ actor: record.actor, sessionHash: record.sessionHash }, true, async context => {
      await requireDisruptionAuthority(context.db, context.authority, true);
      await assertDecisionInventory(context.db, record);
      const current = await readRemedyItem(tenantId, itemId, context.db);
      if (current.progress.intentId) return current.progress.intentId;
      const item = current.allocation;
      const prepared = await preparePaymentIntent(context.db, record.actor, { purpose: "event_refund", semanticKey: `event:${decisionId}:ticket:${item.ticketId}`, seller: "venue", parentId: item.rootIntentId, ticketId: item.ticketId, tier: item.tier, resourceIds: [item.orderId, item.captureId], eventDecisionId: decisionId, eventRemedyItemId: item.id, eventApprovedPlan: { version: record.planVersion, digest: record.planDigest }, approvedSessionHash: record.sessionHash, approvalExpiresAt: record.decision.expiresAt, refundAllocation: { admissionMinor: item.admissionMinor, perkMinor: item.perkMinor }, build: () => ({ kind: "refund_capture", money: { currency: "USD", minor: item.amountMinor }, captureId: item.captureId, orderId: item.orderId }) }, context.show);
      return prepared.intent.id;
    });
  }
  const intent = await readIntent(tenantId, intentId);
  const { reconcilePaymentIntent, handlePayment } = await import("../payment-service");
  let result: JobResult;
  if (retryIntentId) {
    if (retryIntentId !== intentId) throw new DomainError("ORIGINAL_INTENT_REQUIRED", "This retry names a different original payment identity.");
    // The same current grant is checked by the core immediately before any re-dispatch.
    const operation = await handlePayment(record.actor, { type: "retry_refused", intentId }, process.env.APP_BASE_URL ?? "http://localhost:4105");
    result = operation.status === "succeeded" ? { status: "complete" } : ["refused", "not_sent"].includes(operation.status) ? { status: "needs_attention", code: "EXPLICIT_RETRY_REQUIRED" } : { status: "waiting", code: "PROVIDER_OUTCOME_UNKNOWN" };
  } else {
    const existing = await (await paymentStore()).get(intent.command.scope, intentId);
    // A stopped decision can still read an in-flight original operation; it cannot create or retry a write.
    const current = await getShow(tenantId);
    const canStart = current.cancellationDecision?.id === decisionId && !current.cancellationDecision.remediesStoppedAt && Date.parse(record.decision.expiresAt) > Date.now();
    if (!canStart && (!existing || ["claimed", "not_sent", "refused"].includes(existing.status))) result = { status: "needs_attention", code: "EVENT_REMEDY_AUTHORITY_ENDED" };
    else result = await reconcilePaymentIntent(tenantId, intentId, signal, canStart);
  }
  await pool.query("UPDATE on_event_remedy_progress SET last_code=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND item_id=$2", [tenantId, itemId, result.status === "complete" ? null : result.code]);
  return result;
}
