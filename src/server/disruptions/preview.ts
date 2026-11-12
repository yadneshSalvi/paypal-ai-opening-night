import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { currentActual, financialSummary, uniqueActual } from "@/domain/finance";
import { disruptionDigest, refundAllocation, type DisruptionMode } from "@/domain/disruptions";
import { digest } from "@/domain/hash";
import type { PaymentIntent } from "@/domain/payment-authority";
import { ownedResources, paymentStore } from "../payment-store";
import type { CancellationPreview, PreparedCancellation } from "./contracts";
import type { Reader } from "./store";

export function retainedObligations(show: ShowSnapshot): CancellationPreview["obligations"] {
  const finance = financialSummary(show);
  const paid = finance.rentalCapturedMinor;
  return [
    { label: "Supplier commitment", detail: paid ? "Captured rental fees remain actual costs. Any supplier refund needs a separate agreed allocation against its original capture." : "An uncaptured authorization can be cancelled only through its original rental execution after current provider readback.", amountMinor: paid || finance.remainingRentalAuthorizationMinor || null, href: "/execution" },
    { label: "Crew obligations", detail: "Published calls, duty records, approved settlement lines and payout instructions remain in their original ledgers. A performance cancellation does not erase earned work or promise a revised finish.", amountMinor: null, href: "/crew" },
    { label: "House and audience", detail: "This publishes an internal operating notice. Audience delivery, venue closeout and any physical safety action require their own attributed evidence.", amountMinor: null, href: "/wrap" },
    { label: "Original payment history", detail: "Gross captures and every prior refund remain visible. New remedies cover only the reviewed remaining admission and perk allocation.", amountMinor: finance.grossCapturedMinor, href: "/box-office" },
  ];
}

/** Reads owned ledgers only. Dispatch independently reads the provider's current budget. */
export async function cancellationPreview(db: Reader, show: ShowSnapshot, mode: DisruptionMode, admissionRefundMinor: number): Promise<PreparedCancellation> {
  if (!Number.isInteger(admissionRefundMinor) || admissionRefundMinor < 0 || admissionRefundMinor > 3500 || mode === "cancel_show" && admissionRefundMinor !== 3500) throw new DomainError("CANCELLATION_AMOUNT", "A full show cancellation returns the $35 admission allocation. A support-only remedy must state an exact amount from $0 to $35.", 400);
  const blockers: string[] = [], items: PreparedCancellation["items"] = [], targets: PreparedCancellation["targets"] = [];
  const actual = uniqueActual(show), current = currentActual(show), currentIds = new Set(current.map(item => item.id));
  const intents = (await db.query<{ document: PaymentIntent }>("SELECT document FROM on_payment_intents WHERE tenant_id=$1 ORDER BY id", [show.tenantId])).rows.map(row => row.document);
  const core = await paymentStore(), operations = await core.list({ tenantId: show.tenantId, projectId: "opening-night:venue" });
  const operationsById = new Map(operations.map(operation => [operation.command.intentId, operation]));
  const ticketIntents = intents.filter(intent => intent.seller === "venue" && Boolean(intent.ticketId));
  if (ticketIntents.some(intent => { const operation = operationsById.get(intent.id); return operation && ["claimed", "dispatching", "pending_reconciliation"].includes(operation.status); })) blockers.push("An original ticket or refund instruction has an unresolved provider outcome. Reconcile that identity before reviewing a new allocation.");
  if (show.financialChecks?.some(check => check.transport === "paypal_https" && check.seller === "venue" && check.status === "pending")) blockers.push("A current venue payment observation is still pending. Reconcile it before approving these amounts.");
  const tickets = show.tickets.filter(ticket => ticket.source === "live_sandbox" && ticket.captureId).sort((a, b) => a.id.localeCompare(b.id));
  if (tickets.length > 500) throw new DomainError("CANCELLATION_INVENTORY_LIMIT", "Review this production's larger capture inventory in separate bounded allocations.");
  if (new Set(tickets.map(ticket => ticket.id)).size !== tickets.length || new Set(tickets.map(ticket => ticket.captureId)).size !== tickets.length) blockers.push("The ticket inventory contains a duplicate logical ticket or capture. Original ownership must be reconciled.");
  let alreadyRefundedMinor = 0, preservedAdmissionMinor = 0;
  const lines: CancellationPreview["lines"] = [];
  for (const ticket of tickets) {
    const capturedMinor = ticket.admissionMinor + ticket.perkMinor;
    const roots = intents.filter(intent => intent.purpose === "ticket_order" && intent.seller === "venue" && intent.ticketId === ticket.id && intent.parentId === null);
    const captureEvidence = actual.filter(item => item.kind === "capture" && item.purpose === "ticket" && item.ticketId === ticket.id && item.providerResourceId === ticket.captureId && item.amountMinor === capturedMinor);
    const root = roots[0], captured = captureEvidence[0];
    const resources = root ? await ownedResources(show.tenantId, "venue", root.id, db) : [];
    const orders = resources.filter(resource => resource.kind === "order"), captures = resources.filter(resource => resource.kind === "capture");
    if (ticket.admissionMinor !== 3500 || ticket.perkMinor !== (ticket.tier === "vip" ? 1500 : 0) || roots.length !== 1 || root?.command.action.money.minor !== capturedMinor || captureEvidence.length !== 1 || !captured || !currentIds.has(captured.id) || orders.length !== 1 || captures.length !== 1 || captures[0]!.id !== ticket.captureId || captured.parentId !== orders[0]!.id) { blockers.push("One or more tickets lack a currently verified, uniquely owned original order and capture. No replacement identity will be created."); continue; }
    const prior = refundAllocation(show, ticket.id);
    if (prior.unallocatedMinor || prior.admissionMinor > ticket.admissionMinor || prior.perkMinor > ticket.perkMinor || prior.totalMinor !== ticket.refundedMinor || prior.entries.some(entry => !currentIds.has(entry.id)) || prior.admissionMinor > admissionRefundMinor) { blockers.push("A prior refund allocation is incomplete, disputed, or larger than this proposed admission remedy. Reconcile the original allocation first."); continue; }
    const admissionMinor = admissionRefundMinor - prior.admissionMinor, perkMinor = ticket.perkMinor - prior.perkMinor;
    const amountMinor = admissionMinor + perkMinor;
    targets.push({ ticketId: ticket.id, admissionMinor: admissionRefundMinor, perkMinor: ticket.perkMinor });
    alreadyRefundedMinor += prior.totalMinor; preservedAdmissionMinor += ticket.admissionMinor - admissionRefundMinor;
    lines.push({ ticketId: ticket.id, tier: ticket.tier, captureReference: "••••" + ticket.captureId!.slice(-6), priorRefundMinor: prior.totalMinor, admissionMinor, perkMinor, amountMinor });
    if (amountMinor > 0) items.push({ tenantId: show.tenantId, ticketId: ticket.id, tier: ticket.tier, rootIntentId: root!.id, orderId: orders[0]!.id, captureId: ticket.captureId!, captureMinor: capturedMinor, admissionMinor, perkMinor, amountMinor, priorRefunds: prior.entries.map(entry => ({ id: entry.providerResourceId, amountMinor: entry.amountMinor })).sort((a, b) => a.id.localeCompare(b.id)) });
  }
  // A succeeded core receipt awaiting import must not disappear from the reviewed inventory.
  const unimported = operations.some(operation => operation.status === "succeeded" && operation.receipt?.resources.some(resource => resource.kind === "capture" && ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(resource.status) && !tickets.some(ticket => ticket.captureId === resource.id)));
  if (unimported) blockers.push("A completed original capture has not yet been imported into the ticket ledger. Reconcile that receipt first.");
  if (!show.supplierDisruptions?.length) blockers.push("Record the attributed disruption before reviewing a cancellation.");
  if (show.cancellationDecision?.mode === "cancel_show") blockers.push("This show already has a full cancellation decision. Resume its original instructions and retained obligations.");
  const uniqueBlockers = [...new Set(blockers)];
  const basis = { tenantId: show.tenantId, revision: show.revision, disruptionDigest: disruptionDigest(show), mode, admissionRefundMinor, items, targets, blockers: uniqueBlockers, currentDecisionId: show.cancellationDecision?.id ?? null };
  return { items, targets, preview: { digest: digest(basis), revision: show.revision, mode, admissionRefundMinor, ready: uniqueBlockers.length === 0, capturedTickets: tickets.length, admissionMinor: items.reduce((sum, item) => sum + item.admissionMinor, 0), perkMinor: items.reduce((sum, item) => sum + item.perkMinor, 0), newRefundMinor: items.reduce((sum, item) => sum + item.amountMinor, 0), alreadyRefundedMinor, preservedAdmissionMinor, blockers: uniqueBlockers, lines, obligations: retainedObligations(show) } };
}
