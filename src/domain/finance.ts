import { DomainError, type FinancialEvidence, type ShowSnapshot, type Ticket } from "./contracts";

export const isActual = (entry: FinancialEvidence) => entry.verified && entry.source === "live_sandbox" && entry.status === "completed" && Boolean(entry.providerResourceId);
export function uniqueActual(show: ShowSnapshot): FinancialEvidence[] {
  const seen = new Set<string>();
  return show.financialEvidence.filter(e => {
    const key = `${e.kind}:${e.providerResourceId}`;
    if (!isActual(e) || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
/** Historical receipts remain immutable; current adverse reads can withdraw readiness. */
export function currentActual(show: ShowSnapshot): FinancialEvidence[] {
  const actual = uniqueActual(show);
  return actual.filter(entry => {
    if (entry.kind === "authorization" && actual.some(item => item.kind === "void" && item.purpose === "rental_cancel" && item.parentId === entry.providerResourceId)) return false;
    const seller = ["rental", "deposit", "rental_cancel"].includes(entry.purpose) ? "brightline" : "venue";
    const kind = entry.kind === "void" ? "authorization" : entry.kind;
    const parentKind = entry.kind === "refund" ? "capture" : entry.kind === "void" || entry.kind === "capture" && entry.purpose === "rental" ? "authorization" : "order";
    if (show.financialChecks?.some(check => check.transport === "paypal_https" && check.seller === seller && check.status === "pending" && check.resources.some(resource => resource.kind === kind && resource.id === entry.providerResourceId || resource.kind === parentKind && resource.id === entry.parentId))) return false;
    const observation = (show.financialObservations ?? []).filter(read => read.transport === "paypal_https" && read.seller === seller && read.kind === kind && read.providerResourceId === entry.providerResourceId && Date.parse(read.observedAt) >= Date.parse(entry.recordedAt)).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    if (!observation) return true;
    if (entry.kind === "void") return observation.status === "VOIDED";
    if (observation.currency !== entry.currency || observation.amountMinor !== entry.amountMinor) return false;
    if (entry.kind === "capture") return ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(observation.status);
    if (entry.kind === "refund") return observation.status === "COMPLETED";
    if (entry.kind === "authorization") {
      if (["CREATED", "PARTIALLY_CAPTURED", "CAPTURED"].includes(observation.status)) return true;
      // An authorized, captured and correctly released rental is still historically secured.
      return observation.status === "VOIDED" && actual.some(e => e.kind === "capture" && e.purpose === "rental" && e.parentId === entry.providerResourceId && e.amountMinor === 48000) && actual.some(e => e.kind === "void" && e.purpose === "deposit" && e.parentId === entry.providerResourceId && e.amountMinor === 30000);
    }
    return true;
  });
}
export function financialSummary(show: ShowSnapshot) {
  const actual = uniqueActual(show);
  const current = currentActual(show); const currentIds = new Set(current.map(e => e.id));
  const captures = actual.filter(e => e.kind === "capture" && e.purpose === "ticket");
  const qualifyingRefunds = actual.filter(e => {
    const ticket = show.tickets.find(t => t.id === e.ticketId);
    const observedCapture = (show.financialObservations ?? []).filter(read => read.transport === "paypal_https" && read.seller === "venue" && read.kind === "capture" && read.providerResourceId === ticket?.captureId && Date.parse(read.observedAt) >= Date.parse(e.recordedAt)).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    const exactRemedy = !observedCapture || observedCapture.refundedMinor === undefined || observedCapture.refundedMinor === 1500;
    return exactRemedy && currentIds.has(e.id) && e.kind === "refund" && e.purpose === "vip_remedy" && e.amountMinor === 1500 && ticket?.tier === "vip" && ticket.admissionMinor === 3500 && ticket.perkMinor === 1500 && ticket.source === "live_sandbox" && ticket.captureId === e.parentId && captures.some(c => currentIds.has(c.id) && c.providerResourceId === ticket.captureId && c.ticketId === ticket.id && c.amountMinor === 5000);
  });
  const refundedTickets = new Set(qualifyingRefunds.filter(e => actual.filter(other => other.kind === "refund" && other.parentId === e.parentId).reduce((total, other) => total + other.amountMinor, 0) === 1500).map(e => e.ticketId));
  const sum = (entries: FinancialEvidence[]) => entries.reduce((total, e) => total + e.amountMinor, 0);
  const ticketRefunds = actual.filter(entry => entry.kind === "refund" && captures.some(capture => capture.providerResourceId === entry.parentId));
  const rentalAuthorizations = current.filter(entry => entry.kind === "authorization" && entry.purpose === "rental");
  const remainingRentalAuthorizationMinor = rentalAuthorizations.reduce((total, authorization) => {
    const released = actual.filter(entry => entry.kind === "void" && entry.parentId === authorization.providerResourceId);
    const captured = actual.filter(entry => entry.kind === "capture" && entry.parentId === authorization.providerResourceId);
    return total + Math.max(0, authorization.amountMinor - sum(captured) - sum(released));
  }, 0);
  return {
    grossCapturedMinor: sum(captures), capturedTickets: new Set(captures.map(e => e.ticketId).filter(Boolean)).size,
    ledgerTicketNetMinor: sum(captures) - sum(ticketRefunds), settledTicketRefundMinor: sum(ticketRefunds),
    vipRemedyMinor: sum(qualifyingRefunds), refundedVipCount: refundedTickets.size,
    rentalCapturedMinor: sum(actual.filter(e => e.kind === "capture" && e.purpose === "rental")),
    authorizedMinor: sum(actual.filter(e => e.kind === "authorization" && e.purpose === "rental")),
    releasedMinor: sum(actual.filter(e => e.kind === "void" && e.purpose === "deposit")),
    cancelledAuthorizationMinor: sum(actual.filter(e => e.kind === "void" && e.purpose === "rental_cancel")),
    remainingRentalAuthorizationMinor,
    crewPaidMinor: sum(actual.filter(e => e.kind === "payout" && e.purpose === "crew")),
    pendingCount: show.financialEvidence.filter(e => e.status === "pending").length,
    disputedEvidenceCount: actual.length - current.length,
    evidenceIds: qualifyingRefunds.map(e => e.id),
  };
}
export function assertPerkRefund(ticket: Ticket, amountMinor: number, providerRefundableMinor: number, reservedMinor = 0) {
  if (ticket.source !== "live_sandbox" || !ticket.captureId || !["captured", "partially_refunded"].includes(ticket.status)) throw new DomainError("CAPTURE_REQUIRED", "A verified original capture is required for a remedy.");
  if (ticket.tier !== "vip" || ticket.perkMinor !== 1500) throw new DomainError("PERK_NOT_ELIGIBLE", "This ticket does not contain the canceled $15 soundcheck perk.");
  if (![amountMinor, providerRefundableMinor, reservedMinor, ticket.refundedMinor].every(Number.isSafeInteger) || amountMinor <= 0 || reservedMinor < 0 || providerRefundableMinor < 0) throw new DomainError("INVALID_AMOUNT", "Refund amounts must be positive integer cents.", 400);
  if (amountMinor > ticket.perkMinor - ticket.refundedMinor - reservedMinor || amountMinor > providerRefundableMinor) throw new DomainError("REFUND_EXCEEDS_AUTHORITY", "The remedy would exceed the unrefunded perk or the provider’s current refundable balance.");
}
