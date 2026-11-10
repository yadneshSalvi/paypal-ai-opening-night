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
export function financialSummary(show: ShowSnapshot) {
  const actual = uniqueActual(show);
  const captures = actual.filter(e => e.kind === "capture" && e.purpose === "ticket");
  const qualifyingRefunds = actual.filter(e => {
    const ticket = show.tickets.find(t => t.id === e.ticketId);
    return e.kind === "refund" && e.purpose === "vip_remedy" && e.amountMinor === 1500 && ticket?.tier === "vip" && ticket.admissionMinor === 3500 && ticket.perkMinor === 1500 && ticket.source === "live_sandbox" && ticket.captureId === e.parentId && captures.some(c => c.providerResourceId === ticket.captureId && c.ticketId === ticket.id && c.amountMinor === 5000);
  });
  const refundedTickets = new Set(qualifyingRefunds.filter(e => actual.filter(other => other.kind === "refund" && other.parentId === e.parentId).reduce((total, other) => total + other.amountMinor, 0) === 1500).map(e => e.ticketId));
  const sum = (entries: FinancialEvidence[]) => entries.reduce((total, e) => total + e.amountMinor, 0);
  return {
    grossCapturedMinor: sum(captures), capturedTickets: new Set(captures.map(e => e.ticketId).filter(Boolean)).size,
    vipRemedyMinor: sum(qualifyingRefunds), refundedVipCount: refundedTickets.size,
    rentalCapturedMinor: sum(actual.filter(e => e.kind === "capture" && e.purpose === "rental")),
    authorizedMinor: sum(actual.filter(e => e.kind === "authorization" && e.purpose === "rental")),
    releasedMinor: sum(actual.filter(e => e.kind === "void" && e.purpose === "deposit")),
    crewPaidMinor: sum(actual.filter(e => e.kind === "payout" && e.purpose === "crew")),
    pendingCount: show.financialEvidence.filter(e => e.status === "pending").length,
    evidenceIds: qualifyingRefunds.map(e => e.id),
  };
}
export function assertPerkRefund(ticket: Ticket, amountMinor: number, providerRefundableMinor: number, reservedMinor = 0) {
  if (ticket.source !== "live_sandbox" || !ticket.captureId || !["captured", "partially_refunded"].includes(ticket.status)) throw new DomainError("CAPTURE_REQUIRED", "A verified original capture is required for a remedy.");
  if (ticket.tier !== "vip" || ticket.perkMinor !== 1500) throw new DomainError("PERK_NOT_ELIGIBLE", "This ticket does not contain the canceled $15 soundcheck perk.");
  if (![amountMinor, providerRefundableMinor, reservedMinor, ticket.refundedMinor].every(Number.isSafeInteger) || amountMinor <= 0 || reservedMinor < 0 || providerRefundableMinor < 0) throw new DomainError("INVALID_AMOUNT", "Refund amounts must be positive integer cents.", 400);
  if (amountMinor > ticket.perkMinor - ticket.refundedMinor - reservedMinor || amountMinor > providerRefundableMinor) throw new DomainError("REFUND_EXCEEDS_AUTHORITY", "The remedy would exceed the unrefunded perk or the provider’s current refundable balance.");
}
