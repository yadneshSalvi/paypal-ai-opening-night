import type { FinancialEvidence, FinancialObservation, ShowSnapshot } from "@/domain/contracts";
import { payoutGrant, payoutGrantView, payoutRecords } from "@/domain/payouts/policy";
import type { PayoutRecord, PayoutState } from "@/domain/payouts/contracts";

/** Historical item receipts are immutable. A newer incomplete or adverse read withdraws current payment proof. */
export function projectPayoutEvidence(show: ShowSnapshot, state: PayoutState, record: PayoutRecord): ShowSnapshot {
  if (!["batch_read", "item_read", "cancel_result"].includes(record.kind) || !("result" in record) || !("grantId" in record) || record.result.transport !== "paypal_https" || record.result.source !== "live_sandbox") return show;
  const grant = payoutGrant(state, record.grantId), view = payoutGrantView(show, state, grant);
  const affected = record.kind === "batch_read" ? view.items : view.items.filter(item => "senderItemId" in record && item.senderItemId === record.senderItemId);
  const financialEvidence: FinancialEvidence[] = [...show.financialEvidence], financialObservations: FinancialObservation[] = [...(show.financialObservations ?? [])];
  for (const item of affected) {
    // Only an already verified original identity may enter the public financial projection.
    const bound = payoutRecords(state, "batch_read").findLast(read => read.grantId === grant.id && read.verified && read.result.outcome === "succeeded");
    const providerId = bound?.result.outcome === "succeeded" ? bound.result.value.items.find(value => value.senderItemId === item.senderItemId)?.id : null;
    if (!providerId) continue;
    if (item.currentVerified && item.status === "SUCCESS" && !financialEvidence.some(entry => entry.kind === "payout" && entry.providerResourceId === providerId)) financialEvidence.push({
      id: `payout:${providerId}`, operationId: grant.id, kind: "payout", purpose: "crew", status: "completed", amountMinor: item.amountMinor, currency: "USD", source: "live_sandbox", verified: true, planVersion: show.planVersion, providerResourceId: providerId, parentId: bound!.result.outcome === "succeeded" ? bound!.result.value.id : null, ticketId: null, recordedAt: record.result.observedAt,
    });
    financialObservations.push({ id: `${record.id}:${item.senderItemId}`, seller: "venue", kind: "payout", providerResourceId: providerId, status: item.currentVerified ? item.status : "UNVERIFIED", amountMinor: item.currentVerified ? item.amountMinor : null, currency: item.currentVerified ? "USD" : null, parentId: view.providerBatchId, observedAt: record.result.observedAt, transport: "paypal_https", readRevision: record.revision });
  }
  return { ...show, financialEvidence, financialObservations };
}
