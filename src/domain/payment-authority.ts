import type { PaymentCommand, ProviderResource, PaymentOperation } from "@fracture/paypal-core";
import { DomainError, type ShowSnapshot, type FinancialEvidence } from "./contracts";
import { digest } from "./hash";
import { atVenue, compareInstants } from "./time";

export type PaymentSeller = "venue" | "brightline";
export type PaymentPurpose = "rental_order" | "rental_authorize" | "rental_fee" | "rental_release" | "ticket_order" | "ticket_capture" | "vip_refund";
export interface PaymentIntent {
  id: string; tenantId: string; seller: PaymentSeller; purpose: PaymentPurpose; semanticKey: string;
  planVersion: number; planDigest: string | null; parentId: string | null; ticketId: string | null;
  resourceIds: string[]; approvedBy: string; createdAt: string; command: PaymentCommand;
  feeMinor: number; depositMinor: number; tier: "standard" | "vip" | null;
}
export interface PublicPayment {
  id: string; purpose: PaymentPurpose; seller: PaymentSeller; amountMinor: number; planVersion: number;
  status: PaymentOperation["status"] | "prepared"; approvalUrl: string | null; error: string | null;
  resources: { kind: string; reference: string; status: string; amountMinor: number | null }[];
  updatedAt: string; ticketId: string | null;
}

export function approvedRental(show: ShowSnapshot) {
  const plan = show.approvedPlan;
  if (!plan) throw new DomainError("PLAN_APPROVAL_REQUIRED", "Review and approve a recovery plan before committing money.");
  const candidate = show.runs.flatMap(r => r.candidates).find(c => c.id === plan.candidateId && c.digest === plan.digest);
  const offer = show.offers.find(o => o.id === candidate?.patch.offerId);
  if (!candidate || !offer || candidate.patch.offerRevision !== offer.revision) throw new DomainError("OFFER_CHANGED", "The approved offer changed. Review the recovery plan again.");
  return { plan, candidate, offer };
}

/** Every value comes from our approved set, before a provider claim can be made. */
export function assertPaymentAuthority(show: ShowSnapshot, intent: PaymentIntent, command = intent.command) {
  if (intent.tenantId !== show.tenantId || command.scope.tenantId !== show.tenantId || command.scope.projectId !== "opening-night:" + intent.seller || command.intentId !== intent.id || digest(command) !== digest(intent.command)) throw new DomainError("PAYMENT_OWNERSHIP", "This payment is outside the current production’s approved set.", 403);
  const action = command.action;
  if (action.money.currency !== "USD" || !Number.isSafeInteger(action.money.minor) || action.money.minor <= 0) throw new DomainError("PAYMENT_AMOUNT", "Payment authority requires an exact positive USD amount.", 400);
  const resourceIds = ["orderId" in action ? action.orderId : null, "authorizationId" in action ? action.authorizationId : null, "captureId" in action ? action.captureId : null].filter((id): id is string => Boolean(id));
  if (resourceIds.some(id => !intent.resourceIds.includes(id))) throw new DomainError("PAYMENT_RESOURCE", "The payment resource is not owned by this execution.", 403);
  if (intent.purpose.startsWith("rental_")) {
    const { plan, offer } = approvedRental(show);
    if (intent.planVersion !== show.planVersion || intent.planDigest !== plan.digest) throw new DomainError("STALE_PAYMENT_PLAN", "The approved recovery changed. This payment cannot execute under its old terms.", 403);
    if (intent.seller !== "brightline" || offer.supplierId !== "brightline" || intent.feeMinor !== offer.feeMinor || intent.depositMinor !== offer.depositMinor || plan.commercialCapMinor !== offer.feeMinor + offer.depositMinor) throw new DomainError("SELLER_NOT_QUALIFIED", "This offer does not have a matching qualified supplier payment adapter.", 403);
    const expectedKind = { rental_order: "create_order", rental_authorize: "authorize_order", rental_fee: "capture_authorization", rental_release: "void_authorization" }[intent.purpose as "rental_order" | "rental_authorize" | "rental_fee" | "rental_release"];
    const expectedAmount = intent.purpose === "rental_fee" ? offer.feeMinor : plan.commercialCapMinor;
    if (action.kind !== expectedKind || action.money.minor !== expectedAmount) throw new DomainError("PAYMENT_AMOUNT", "The payment instruction differs from the exact approved rental terms.", 403);
    if (intent.purpose === "rental_order" && (action.kind !== "create_order" || action.intent !== "AUTHORIZE")) throw new DomainError("AUTHORIZATION_REQUIRED", "The rental begins with an authorization, preserving the deposit hold.", 403);
    if (["rental_order", "rental_authorize"].includes(intent.purpose) && compareInstants(show.clock, offer.expiresAt) >= 0) throw new DomainError("QUOTE_EXPIRED", "The supplier quote expired. Reconfirm capacity before authorizing payment.");
    if (intent.purpose === "rental_fee") {
      if (action.kind !== "capture_authorization" || action.finalCapture !== false) throw new DomainError("HOLD_MUST_REMAIN", "The fee capture must preserve the remaining damage hold.", 403);
      if (!show.facts.some(f => f.kind === "supplier_confirmed" && f.planVersion === show.planVersion) || !show.facts.some(f => f.kind === "delivery_accepted" && f.planVersion === show.planVersion)) throw new DomainError("DELIVERY_ACCEPTANCE_REQUIRED", "Supplier confirmation and department acceptance must precede the rental fee capture.");
      if (compareInstants(show.clock, atVenue("17:20")) < 0) throw new DomainError("CAPTURE_TOO_EARLY", "Advance the labeled fixture to the 17:20 fee-capture step after accepted delivery.");
    }
    if (intent.purpose === "rental_release") {
      if (!show.facts.some(f => f.kind === "return_accepted" && f.planVersion === show.planVersion)) throw new DomainError("RETURN_ACCEPTANCE_REQUIRED", "Record an attributed undamaged return before releasing the remaining hold.");
      if (action.kind !== "void_authorization" || !show.financialEvidence.some(e => e.kind === "capture" && e.purpose === "rental" && e.source === "live_sandbox" && e.verified && e.status === "completed" && e.planVersion === show.planVersion && e.parentId === action.authorizationId && e.amountMinor === intent.feeMinor)) throw new DomainError("RENTAL_FEE_REQUIRED", "Verify the accepted rental fee before closing its remaining damage hold.");
    }
  } else if (intent.purpose === "vip_refund") {
    const { candidate, plan } = approvedRental(show);
    const ticket = show.tickets.find(t => t.id === intent.ticketId);
    if (intent.planDigest !== plan.digest || intent.planVersion !== show.planVersion || !candidate.patch.canceledPerk || intent.seller !== "venue" || action.kind !== "refund_capture" || action.money.minor !== 1500 || !ticket || ticket.tier !== "vip" || ticket.captureId !== action.captureId || ticket.source !== "live_sandbox" || ticket.admissionMinor !== 3500 || ticket.perkMinor !== 1500) throw new DomainError("REMEDY_NOT_APPROVED", "This exact original capture does not have a current $15 perk remedy approval.", 403);
  } else {
    const expectedAmount = intent.tier === "vip" ? 5000 : 3500;
    const expectedKind = intent.purpose === "ticket_order" ? "create_order" : "capture_order";
    if (intent.seller !== "venue" || !intent.ticketId || !intent.tier || action.money.minor !== expectedAmount || action.kind !== expectedKind || (action.kind === "create_order" && action.intent !== "CAPTURE")) throw new DomainError("TICKET_NOT_APPROVED", "The ticket instruction does not match its owned admission and perk allocation.", 403);
  }
}

export function safeApprovalUrl(resources: ProviderResource[]) {
  const link = resources.find(r => r.kind === "order")?.links.find(l => ["approve", "payer-action"].includes(l.rel) && l.method === "GET");
  if (!link) return null;
  try { const url = new URL(link.href); return url.protocol === "https:" && url.hostname === "www.sandbox.paypal.com" && !url.username && !url.password ? url.href : null; } catch { return null; }
}

/** Persisted receipts can be projected repeatedly without creating a second financial actual. */
export function evidenceForOperation(intent: PaymentIntent, operation: PaymentOperation): FinancialEvidence[] {
  const receipt = operation.receipt;
  if (!receipt || receipt.source !== "live_sandbox" || receipt.transport === "local_fixture" || operation.status !== "succeeded") return [];
  const action = operation.command.action;
  return receipt.resources.flatMap(resource => {
    if (!resource.id || resource.source !== "live_sandbox" || !resource.money || resource.money.currency !== "USD") return [];
    let kind: FinancialEvidence["kind"] | null = null;
    let purpose: FinancialEvidence["purpose"] = "rental";
    let amount = resource.money.minor;
    let parentId = resource.parentId;
    if (intent.purpose === "rental_authorize" && resource.kind === "authorization" && ["CREATED", "PARTIALLY_CAPTURED", "CAPTURED"].includes(resource.status) && amount === action.money.minor && action.kind === "authorize_order" && parentId === action.orderId) kind = "authorization";
    if (intent.purpose === "rental_fee" && resource.kind === "capture" && resource.status === "COMPLETED" && amount === intent.feeMinor && action.kind === "capture_authorization" && parentId === action.authorizationId) kind = "capture";
    if (intent.purpose === "rental_release" && resource.kind === "authorization" && resource.status === "VOIDED" && amount === intent.feeMinor + intent.depositMinor && action.kind === "void_authorization" && resource.id === action.authorizationId) { kind = "void"; purpose = "deposit"; amount = intent.depositMinor; parentId = resource.id; }
    if (["ticket_order", "ticket_capture"].includes(intent.purpose) && resource.kind === "capture" && ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(resource.status) && amount === action.money.minor && receipt.resources.some(r => r.kind === "order" && r.id === parentId)) { kind = "capture"; purpose = "ticket"; }
    if (intent.purpose === "vip_refund" && resource.kind === "refund" && resource.status === "COMPLETED" && amount === 1500 && action.kind === "refund_capture" && parentId === action.captureId) { kind = "refund"; purpose = "vip_remedy"; }
    return kind ? [{ id: "provider:" + intent.seller + ":" + kind + ":" + resource.id, operationId: operation.command.operationId, kind, purpose, status: "completed" as const, amountMinor: amount, currency: "USD" as const, source: "live_sandbox" as const, verified: true, planVersion: intent.planVersion, providerResourceId: resource.id, parentId, ticketId: intent.ticketId, recordedAt: receipt.observedAt }] : [];
  });
}
