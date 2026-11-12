import type { ProviderResource } from "@fracture/paypal-core";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { assertPaymentAuthority, type PaymentIntent } from "@/domain/payment-authority";
import { paymentStore, paymentTransaction } from "../payment-store";
import { assertDecisionInventory, readDecision, readRemedyItem, requireDisruptionAuthority, type Reader } from "./store";

export async function assertEventRemedyIntent(db: Reader, show: ShowSnapshot, intent: PaymentIntent, preparing = false) {
  if (intent.purpose !== "event_refund" || !intent.eventDecisionId || !intent.eventRemedyItemId) throw new DomainError("EVENT_REMEDY_NOT_APPROVED", "This instruction needs its exact cancellation allocation.", 403);
  const record = await readDecision(intent.tenantId, intent.eventDecisionId, db), { allocation: item, progress } = await readRemedyItem(intent.tenantId, intent.eventRemedyItemId, db);
  const action = intent.command.action;
  assertPaymentAuthority(show, intent);
  if (record.decision.id !== show.cancellationDecision?.id || record.decision.digest !== show.cancellationDecision.digest || record.sessionHash !== intent.approvedSessionHash || record.actor.id !== intent.approvedBy || record.planVersion !== intent.planVersion || record.planDigest !== intent.planDigest || item.decisionId !== record.decision.id || item.rootIntentId !== intent.parentId || item.ticketId !== intent.ticketId || item.tier !== intent.tier || action.kind !== "refund_capture" || action.captureId !== item.captureId || action.orderId !== item.orderId || action.money.minor !== item.amountMinor || digest(intent.refundAllocation) !== digest({ admissionMinor: item.admissionMinor, perkMinor: item.perkMinor }) || progress.intentId && progress.intentId !== intent.id || !preparing && progress.intentId !== intent.id) throw new DomainError("EVENT_REMEDY_LINE_MISMATCH", "This instruction differs from its immutable original-capture allocation.", 403);
  if (Date.parse(record.decision.expiresAt) <= Date.now() || (await db.query("SELECT 1 FROM on_disruption_stops WHERE tenant_id=$1 AND decision_id=$2", [intent.tenantId, record.decision.id])).rowCount) throw new DomainError("EVENT_REMEDY_AUTHORITY_ENDED", "This cancellation no longer authorizes new refunds. Existing outcomes remain reconcilable.", 403);
  await requireDisruptionAuthority(db, { actor: record.actor, sessionHash: record.sessionHash }, true);
  await assertDecisionInventory(db, record);
  return { record, item, progress };
}
export async function linkEventRemedyIntent(db: Reader, show: ShowSnapshot, intent: PaymentIntent) {
  if (intent.purpose !== "event_refund") return;
  await assertEventRemedyIntent(db, show, intent, true);
  await db.query("UPDATE on_event_remedy_progress SET intent_id=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND item_id=$2 AND (intent_id IS NULL OR intent_id=$3)", [intent.tenantId, intent.eventRemedyItemId, intent.id]);
}
export async function authorizeEventRemedy(intent: PaymentIntent) {
  const operation = await (await paymentStore()).get(intent.command.scope, intent.id);
  await paymentTransaction(async db => {
    const show = (await db.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR SHARE", [intent.tenantId])).rows[0]?.snapshot;
    if (!show) throw new DomainError("SHOW_NOT_FOUND", "This production is unavailable.", 404);
    await assertEventRemedyIntent(db, show, intent);
    if (operation?.status === "claimed") await db.query("UPDATE on_event_remedy_progress SET dispatch_authorized_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND item_id=$2", [intent.tenantId, intent.eventRemedyItemId]);
  });
}
/** A second refund is allowed only when every already-consumed cent matches its reviewed allocation. */
export async function assertEventProviderBudget(intent: PaymentIntent, resource: ProviderResource, children: ProviderResource[]) {
  const { allocation } = await readRemedyItem(intent.tenantId, intent.eventRemedyItemId!);
  const actual = children.map(child => ({ id: child.id, amountMinor: child.money?.minor ?? null })).sort((a, b) => a.id.localeCompare(b.id));
  if (resource.id !== allocation.captureId || resource.money?.currency !== "USD" || resource.money.minor !== allocation.captureMinor || children.some(child => child.status !== "COMPLETED") || digest(actual) !== digest(allocation.priorRefunds) || children.reduce((sum, child) => sum + (child.money?.minor ?? 0), 0) + allocation.amountMinor > allocation.captureMinor) throw new DomainError("EVENT_REFUND_BUDGET_CHANGED", "The original capture has a new, pending, or unattributed refund. Reconcile it before any further compensation.");
}
