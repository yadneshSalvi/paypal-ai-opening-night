import type { ProviderResource } from "@fracture/paypal-core";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { currentActual } from "@/domain/finance";
import { digest } from "@/domain/hash";
import { assertPaymentAuthority, type PaymentIntent } from "@/domain/payment-authority";
import { rentalExecutionDigest } from "@/domain/rental-closeout";
import { paymentStore, paymentTransaction, readIntent } from "../payment-store";
import { originalRental, acceptedDelivery } from "./preview";
import { readCloseoutGrant, readReturn, requireCloseoutAuthority, type Reader } from "./store";

export async function assertRentalCloseoutIntent(db: Reader, show: ShowSnapshot, intent: PaymentIntent, preparing = false) {
  if (!intent.rentalCloseoutId || intent.purpose !== "rental_release") throw new DomainError("RENTAL_CLOSEOUT_REQUIRED", "This instruction needs an exact original-rental closure review.", 403);
  const { grant, progress, stoppedAt } = await readCloseoutGrant(intent.tenantId, intent.rentalCloseoutId, db), action = intent.command.action;
  assertPaymentAuthority(show, intent);
  if (stoppedAt || Date.parse(grant.expiresAt) <= Date.now()) throw new DomainError("RENTAL_CLOSEOUT_AUTHORITY_ENDED", "This approval cannot start another write. Its original outcome remains available for readback.", 403);
  await requireCloseoutAuthority(db, { actor: grant.actor, sessionHash: grant.sessionHash }, "producer");
  const { execution, delivery } = await originalRental({ db, authority: { actor: grant.actor, sessionHash: grant.sessionHash }, show }, grant.executionId);
  const returned = await readReturn(show.tenantId, grant.returnId, db), root = await readIntent(show.tenantId, grant.rootIntentId, db), capture = await readIntent(show.tenantId, grant.captureIntentId, db);
  const captureAction = capture.command.action;
  if (grant.tenantId !== intent.tenantId || grant.sessionHash !== intent.approvedSessionHash || digest(grant.actor) !== digest(intent.approvedActor) || grant.actor.id !== intent.approvedBy || grant.executionId !== intent.executionId || grant.executionDigest !== intent.rentalExecutionDigest || grant.executionDigest !== rentalExecutionDigest(execution) || grant.originalPlanVersion !== intent.planVersion || grant.originalPlanDigest !== intent.planDigest || grant.quoteId !== execution.quoteId || grant.quoteDigest !== execution.quoteDigest || grant.returnId !== intent.rentalReturnId || grant.returnId !== execution.returnInspection?.id || grant.returnDigest !== execution.returnInspection.digest || grant.returnDigest !== digest(returned) || returned.condition !== "undamaged" || returned.deliveryDigest !== digest(delivery) || !acceptedDelivery(execution, delivery) || progress.intentId && progress.intentId !== intent.id || !preparing && progress.intentId !== intent.id || grant.expiresAt !== intent.command.approval.expiresAt || grant.rootIntentId !== intent.parentId || action.kind !== "void_authorization" || action.orderId !== grant.orderId || action.authorizationId !== grant.authorizationId || action.money.minor !== grant.authorizationMinor || intent.feeMinor !== grant.feeMinor || intent.depositMinor !== grant.residualMinor || grant.authorizationMinor !== grant.feeMinor + grant.residualMinor) throw new DomainError("RENTAL_CLOSEOUT_TERMS_CHANGED", "The original unit, return or producer-approved hold terms changed. No new void is authorized.", 403);
  if (root.purpose !== "rental_order" || root.seller !== "brightline" || root.parentId || root.executionId !== execution.id || root.planVersion !== execution.planVersion || root.planDigest !== execution.planDigest || root.command.action.kind !== "create_order" || root.command.action.intent !== "AUTHORIZE" || root.command.action.money.minor !== grant.authorizationMinor || capture.purpose !== "rental_fee" || capture.seller !== "brightline" || capture.parentId !== root.id || capture.executionId !== execution.id || capture.planVersion !== execution.planVersion || capture.planDigest !== execution.planDigest || captureAction.kind !== "capture_authorization" || captureAction.orderId !== grant.orderId || captureAction.authorizationId !== grant.authorizationId || captureAction.money.minor !== grant.feeMinor || captureAction.finalCapture !== false || !currentActual(show).some(value => value.kind === "capture" && value.purpose === "rental" && value.operationId === grant.captureIntentId && value.providerResourceId === grant.captureId && value.parentId === grant.authorizationId && value.amountMinor === grant.feeMinor && value.planVersion === grant.originalPlanVersion)) throw new DomainError("ORIGINAL_RENTAL_FEE_REQUIRED", "The original accepted-fee evidence needs reconciliation before its remaining hold can close.", 403);
  return { grant, progress };
}
export async function linkRentalCloseoutIntent(db: Reader, show: ShowSnapshot, intent: PaymentIntent) {
  await assertRentalCloseoutIntent(db, show, intent, true);
  await db.query("UPDATE on_rental_closeout_progress SET intent_id=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND grant_id=$2 AND (intent_id IS NULL OR intent_id=$3)", [intent.tenantId, intent.rentalCloseoutId, intent.id]);
}
/** Called after async provider reads, immediately before the existing core dispatch boundary. */
export async function authorizeRentalCloseout(intent: PaymentIntent) {
  const operation = await (await paymentStore()).get(intent.command.scope, intent.id);
  await paymentTransaction(async db => {
    const { grant } = await readCloseoutGrant(intent.tenantId, intent.rentalCloseoutId!, db);
    await requireCloseoutAuthority(db, { actor: grant.actor, sessionHash: grant.sessionHash }, "producer");
    const show = (await db.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR SHARE", [intent.tenantId])).rows[0]?.snapshot;
    if (!show) throw new DomainError("SHOW_NOT_FOUND", "This production is unavailable.", 404);
    await assertRentalCloseoutIntent(db, show, intent);
    if (operation?.status === "claimed") await db.query("UPDATE on_rental_closeout_progress SET dispatch_authorized_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND grant_id=$2", [intent.tenantId, intent.rentalCloseoutId]);
  });
}
/** The order must corroborate one exact fee both before void and before importing a residual release. */
export async function assertCloseoutProviderState(intent: PaymentIntent, order: ProviderResource[], authorization: ProviderResource[], capture: ProviderResource[], phase: "before" | "after") {
  const { grant } = await readCloseoutGrant(intent.tenantId, intent.rentalCloseoutId!);
  const orderRows = order.filter(value => value.kind === "order"), authorizations = order.filter(value => value.kind === "authorization"), fees = order.filter(value => value.kind === "capture" && !["FAILED", "CANCELLED", "DECLINED", "DENIED"].includes(value.status));
  const refunds = order.filter(value => value.kind === "refund" && !["FAILED", "CANCELLED", "DECLINED", "DENIED"].includes(value.status));
  const expectedStatus = phase === "before" ? "PARTIALLY_CAPTURED" : "VOIDED", auth = authorization[0], fee = capture[0];
  const money = (resource: ProviderResource | undefined, minor: number) => resource?.source === "live_sandbox" && resource.money?.currency === "USD" && resource.money.minor === minor;
  if (orderRows.length !== 1 || orderRows[0]?.id !== grant.orderId || authorizations.length !== 1 || authorizations[0]?.id !== grant.authorizationId || authorizations[0]?.parentId !== grant.orderId || authorizations[0]?.status !== expectedStatus || !money(authorizations[0], grant.authorizationMinor) || authorization.length !== 1 || auth?.kind !== "authorization" || auth.id !== grant.authorizationId || auth.status !== expectedStatus || !money(auth, grant.authorizationMinor) || fees.length !== 1 || fees[0]?.id !== grant.captureId || fees[0]?.parentId !== grant.orderId || fees[0]?.status !== "COMPLETED" || !money(fees[0], grant.feeMinor) || capture.length !== 1 || fee?.kind !== "capture" || fee.id !== grant.captureId || fee.status !== "COMPLETED" || !money(fee, grant.feeMinor) || refunds.length || grant.authorizationMinor - grant.feeMinor !== grant.residualMinor) throw new DomainError(phase === "before" ? "RENTAL_HOLD_BUDGET_CHANGED" : "RENTAL_HOLD_CLOSURE_UNPROVEN", phase === "before" ? "The original authorization, accepted fee or remaining amount changed. No new hold closure was sent." : "The original void needs further reconciliation. The expected remaining hold is not counted as released.");
}
