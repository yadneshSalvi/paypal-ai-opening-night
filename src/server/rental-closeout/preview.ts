import { DomainError } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { currentActual } from "@/domain/finance";
import type { PaymentIntent } from "@/domain/payment-authority";
import { rentalBelongsToCurrentPlan, rentalExecutionDigest, supplierLabel } from "@/domain/rental-closeout";
import type { DeliveryReceipt, RentalExecution, SupplierQuote } from "@/domain/supplier-contracts";
import { atVenue, compareInstants } from "@/domain/time";
import { env } from "../env";
import { ownedResources, paymentStore, readIntent } from "../payment-store";
import { verifySupplierQuote } from "../supplier-protocol";
import { readRentalExecution } from "../supplier-storage";
import type { PreparedCloseout } from "./contracts";
import { closeoutAccess, readReturn, type CloseoutContext, type Reader } from "./store";

export const reference = (value: string | null | undefined) => value ? "••••" + value.slice(-6) : null;
export async function originalRental(context: Pick<CloseoutContext, "show" | "authority"> & { db: Reader }, id: string) {
  const { show, db, authority } = context, execution = await readRentalExecution(db, show.tenantId, id);
  if (closeoutAccess(authority) === "supplier" && execution.supplierId !== authority.actor.supplierId) throw new DomainError("RENTAL_NOT_FOUND", "This rental is outside your supplier scope.", 404);
  const projected = show.rentalExecutions?.find(value => value.id === id);
  if (!projected || digest(projected) !== digest(execution)) throw new DomainError("RENTAL_HISTORY_MISMATCH", "The original rental history needs reconciliation before another instruction.");
  const quote = (await db.query<{ document: SupplierQuote }>("SELECT document FROM on_supplier_quotes WHERE tenant_id=$1 AND id=$2 AND supplier_id=$3", [show.tenantId, execution.quoteId, execution.supplierId])).rows[0]?.document;
  if (!quote || !verifySupplierQuote(quote) || quote.id !== execution.quoteId || quote.termsDigest !== execution.quoteDigest || quote.revision !== execution.offerRevision || quote.offer.id !== execution.offerId || quote.offer.unitId !== execution.unitId || quote.offer.feeMinor !== execution.feeMinor || quote.offer.depositMinor !== execution.depositMinor || quote.offer.deliveryAt !== execution.deliveryAt) throw new DomainError("ORIGINAL_RENTAL_TERMS_REQUIRED", "The original accepted supplier terms could not be verified.");
  let delivery: DeliveryReceipt | null = null;
  if (execution.deliveryId) delivery = (await db.query<{ document: DeliveryReceipt }>("SELECT document FROM on_delivery_receipts WHERE tenant_id=$1 AND execution_id=$2 AND id=$3", [show.tenantId, execution.id, execution.deliveryId])).rows[0]?.document ?? null;
  return { execution, quote, delivery };
}
export function acceptedDelivery(execution: RentalExecution, delivery: DeliveryReceipt | null) {
  return Boolean(execution.acceptedAt && execution.deliveryId && delivery && delivery.id === execution.deliveryId && delivery.state === "accepted" && delivery.executionId === execution.id && delivery.supplierId === execution.supplierId && delivery.unitId === execution.unitId && delivery.version === execution.deliveryVersion && delivery.planVersion === execution.planVersion && delivery.planDigest === execution.planDigest && delivery.acceptedAt === execution.acceptedAt && delivery.acceptedBy && delivery.scannedAt && delivery.scannedBy && delivery.condition?.powerOn && delivery.condition.accessories && delivery.condition.safeCondition);
}
export function returnBlocker(context: CloseoutContext, execution: RentalExecution, delivery: DeliveryReceipt | null) {
  if (!acceptedDelivery(execution, delivery)) return "The original signed handoff and assigned acceptance must be verified first.";
  if (!["accepted", "returned", "needs_attention"].includes(execution.state) || execution.state === "needs_attention" && execution.lastCode !== "SUPPLIER_DISRUPTION") return "This original rental has unresolved fulfillment state; reconcile it before a return inspection.";
  if (rentalBelongsToCurrentPlan(context.show, execution) && !context.show.cancellationDecision && compareInstants(context.show.clock, atVenue("23:30")) < 0) return "The current rental is still in use. Its scheduled return or a reviewed program cancellation is required.";
  const acceptance = context.show.facts.find(fact => fact.kind === "delivery_accepted" && fact.planVersion === execution.planVersion);
  if (!acceptance || compareInstants(context.show.clock, acceptance.fixtureAt) < 0) return "The scenario clock precedes the original attributed acceptance.";
  return null;
}
export async function prepareCloseout(context: CloseoutContext, executionId: string): Promise<PreparedCloseout> {
  const { show, db } = context, { execution, delivery } = await originalRental(context, executionId), executionDigest = rentalExecutionDigest(execution);
  const blockers: string[] = [], actual = currentActual(show);
  let root: PaymentIntent | null = null, capture: PaymentIntent | null = null, existingIntent: PaymentIntent | null = null;
  let orderId: string | null = null, captureId: string | null = null;
  if (execution.supplierId !== "brightline") blockers.push("This supplier has no qualified original-authorization closeout adapter.");
  if (!acceptedDelivery(execution, delivery)) blockers.push("The original accepted delivery has not been verified.");
  if (execution.state !== "returned") blockers.push("This exact original unit still needs its supplier's return inspection.");
  let returned = null;
  if (execution.returnInspection) {
    returned = await readReturn(show.tenantId, execution.returnInspection.id, db);
    if (returned.executionId !== execution.id || returned.executionDigest !== executionDigest || digest(returned) !== execution.returnInspection.digest || returned.deliveryDigest !== digest(delivery)) blockers.push("The original return no longer matches the accepted unit and terms.");
    if (returned.condition !== "undamaged") blockers.push("The supplier reported damage. The remaining hold requires a separate resolution; it is not cleared here.");
  } else blockers.push("Record an explicit original-unit return review before approving its remaining hold.");
  if (!execution.paymentRootId || !execution.authorizationId || !execution.captureIntentId) blockers.push("The original owned order, authorization and accepted-fee instruction are required.");
  if (execution.paymentRootId) {
    root = await readIntent(show.tenantId, execution.paymentRootId, db);
    const owned = await ownedResources(show.tenantId, "brightline", root.id, db), orders = owned.filter(value => value.kind === "order");
    const authorizations = owned.filter(value => value.kind === "authorization"), captures = owned.filter(value => value.kind === "capture");
    const auth = authorizations.find(value => value.id === execution.authorizationId);
    orderId = orders.length === 1 ? orders[0]!.id : null;
    const authEvidence = actual.filter(value => value.kind === "authorization" && value.purpose === "rental" && value.providerResourceId === execution.authorizationId && value.parentId === orderId && value.planVersion === execution.planVersion && value.currency === "USD" && value.amountMinor === execution.feeMinor + execution.depositMinor);
    if (root.purpose !== "rental_order" || root.parentId || root.seller !== "brightline" || root.executionId !== execution.id || root.planVersion !== execution.planVersion || root.planDigest !== execution.planDigest || root.feeMinor !== execution.feeMinor || root.depositMinor !== execution.depositMinor || root.command.action.kind !== "create_order" || root.command.action.intent !== "AUTHORIZE" || root.command.action.money.currency !== "USD" || root.command.action.money.minor !== execution.feeMinor + execution.depositMinor || !orderId || authorizations.length !== 1 || !auth || authEvidence.length !== 1) blockers.push("The retained order and authorization differ from this original rental.");
    const intents = (await db.query<{ document: PaymentIntent }>("SELECT document FROM on_payment_intents WHERE tenant_id=$1 AND document->>'parentId'=$2", [show.tenantId, root.id])).rows.map(row => row.document);
    const releases = intents.filter(value => value.purpose === "rental_release");
    if (releases.length) { existingIntent = releases[0]!; blockers.push("An original hold-closure instruction already exists. Recover that same instruction instead of approving another."); }
    if (releases.length > 1) blockers.push("Multiple historical closure identities require reconciliation.");
    if (intents.some(value => value.purpose === "rental_cancel")) blockers.push("This rental has a separate uncaptured-cancellation history that must be resolved.");
    const fees = intents.filter(value => value.purpose === "rental_fee");
    if (fees.length !== 1 || fees[0]?.id !== execution.captureIntentId) blockers.push("The exact original accepted-fee instruction is not unique.");
    capture = fees.find(value => value.id === execution.captureIntentId) ?? null;
    const feeEvidence = actual.filter(value => value.kind === "capture" && value.purpose === "rental" && value.operationId === execution.captureIntentId && value.planVersion === execution.planVersion && value.parentId === execution.authorizationId && value.amountMinor === execution.feeMinor && value.currency === "USD");
    captureId = feeEvidence.length === 1 ? feeEvidence[0]!.providerResourceId : null;
    const resource = captures.find(value => value.id === captureId);
    const action = capture?.command.action;
    if (!capture || capture.seller !== "brightline" || capture.executionId !== execution.id || capture.parentId !== root.id || capture.planVersion !== execution.planVersion || capture.planDigest !== execution.planDigest || action?.kind !== "capture_authorization" || action.finalCapture !== false || action.authorizationId !== execution.authorizationId || action.orderId !== orderId || action.money.minor !== execution.feeMinor || !captureId || captures.length !== 1 || !resource) blockers.push("The original nonfinal accepted-fee capture needs verified owned evidence.");
    if (capture) {
      const operation = await (await paymentStore()).get(capture.command.scope, capture.id);
      if (operation?.status !== "succeeded") blockers.push("The original fee outcome is unresolved. Reconcile its same operation before closing any hold.");
    }
  }
  if (actual.some(value => value.kind === "void" && value.parentId === execution.authorizationId)) blockers.push("A verified original authorization closure is already recorded; no new closure may be sent.");
  const grant: PreparedCloseout["grant"] = blockers.length === 0 && root && capture && orderId && captureId && execution.authorizationId && returned ? {
    tenantId: show.tenantId, executionId: execution.id, executionDigest, originalPlanVersion: execution.planVersion, originalPlanDigest: execution.planDigest,
    quoteId: execution.quoteId, quoteDigest: execution.quoteDigest, returnId: returned.id, returnDigest: digest(returned), rootIntentId: root.id,
    orderId, authorizationId: execution.authorizationId, captureIntentId: capture.id, captureId, authorizationMinor: execution.feeMinor + execution.depositMinor,
    feeMinor: execution.feeMinor, residualMinor: execution.depositMinor,
  } : null;
  const preview = {
    executionId: execution.id, executionDigest, revision: show.revision, digest: "", ready: Boolean(grant), supplier: supplierLabel(execution.supplierId), unitId: execution.unitId,
    originalPlanVersion: execution.planVersion, currentPlan: rentalBelongsToCurrentPlan(show, execution), authorizationMinor: execution.feeMinor + execution.depositMinor,
    acceptedFeeMinor: execution.feeMinor, residualMinor: execution.depositMinor, orderReference: reference(orderId), authorizationReference: reference(execution.authorizationId), captureReference: reference(captureId),
    returnId: returned?.id ?? null, returnCondition: returned?.condition ?? null, blockers: [...new Set(blockers)], existingIntentId: existingIntent?.id ?? null, providerActionsEnabled: !env.controlledQa,
  };
  preview.digest = digest({ preview, grant });
  return { preview, execution, grant, existingIntent };
}
