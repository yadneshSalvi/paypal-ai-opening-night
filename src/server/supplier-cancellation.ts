import { DomainError, type Actor } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { currentActual } from "@/domain/finance";
import { ownedResources, paymentStore, readIntent } from "./payment-store";
import { preparePaymentIntent } from "./payment-intents";
import { assertProducer, assertRevision, lockSupplierShow, readRentalExecution, saveRentalExecution, saveSupplierSnapshot, supplierTransaction } from "./supplier-storage";

export async function approveRentalCancellation(actor: Actor, executionId: string, commandId: string, expectedRevision: number, detail: string) {
  assertProducer(actor); await paymentStore();
  return supplierTransaction(async client => {
    const show = await lockSupplierShow(client, actor.tenantId);
    const payloadHash = digest({ actorId: actor.id, executionId, expectedRevision, detail, action: "cancel_uncaptured_authorization" });
    const previous = await client.query<{ payload_hash: string }>("SELECT payload_hash FROM on_commands WHERE tenant_id=$1 AND command_id=$2", [actor.tenantId, commandId]);
    if (previous.rows[0]) {
      if (previous.rows[0].payload_hash !== payloadHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This cancellation key already has different instructions.");
      return show;
    }
    assertRevision(show, expectedRevision);
    const execution = await readRentalExecution(client, actor.tenantId, executionId);
    if (execution.supplierId !== "brightline" || !execution.paymentRootId || !execution.authorizationId || !["held", "awaiting_payment", "authorized", "confirmed", "expired", "reconfirmation_required", "returned_unaccepted"].includes(execution.state) || execution.acceptedAt || execution.captureIntentId || execution.state === "returned_unaccepted" && !execution.rejectedReturn) throw new DomainError("UNCAPTURED_CANCELLATION_REQUIRED", "This branch cancels only an unfulfilled or supplier-returned rejected rental with a verified original authorization and no fee instruction.");
    const auth = currentActual(show).find(item => item.kind === "authorization" && item.purpose === "rental" && item.providerResourceId === execution.authorizationId && item.planVersion === execution.planVersion && item.amountMinor === execution.feeMinor + execution.depositMinor);
    if (!auth || show.financialEvidence.some(item => item.kind === "capture" && item.parentId === execution.authorizationId && item.verified && item.source === "live_sandbox")) throw new DomainError("AUTHORIZATION_REVIEW_REQUIRED", "Verify this uncaptured authorization before approving its cancellation. Existing captures are preserved.");
    const fee = await client.query("SELECT id FROM on_payment_intents WHERE tenant_id=$1 AND document->>'parentId'=$2 AND document->>'purpose'='rental_fee' LIMIT 1", [actor.tenantId, execution.paymentRootId]);
    if (fee.rowCount) throw new DomainError("FEE_INSTRUCTION_EXISTS", "An existing fee instruction must be reconciled before considering cancellation.");
    const root = await readIntent(actor.tenantId, execution.paymentRootId, client);
    const resources = await ownedResources(actor.tenantId, "brightline", root.id, client);
    const order = resources.find(item => item.kind === "order"); const authorization = resources.find(item => item.kind === "authorization" && item.id === execution.authorizationId);
    if (!order || !authorization || root.executionId !== execution.id) throw new DomainError("ORIGINAL_RESOURCE_REQUIRED", "The original order and authorization must belong to this exact rental execution.");
    execution.state = "compensation_pending"; execution.cancellationApprovedAt = new Date().toISOString(); execution.lastCode = null;
    await saveRentalExecution(client, show, execution);
    await preparePaymentIntent(client, actor, { purpose: "rental_cancel", semanticKey: root.id + ":cancel-uncaptured", seller: "brightline", parentId: root.id, resourceIds: [authorization.id, order.id], approvedExecution: execution, runAfter: new Date(), build: () => ({ kind: "void_authorization", money: root.command.action.money, authorizationId: authorization.id, orderId: order.id }) }, show);
    await saveSupplierSnapshot(client, show, actor.id, "supplier.compensation_approved", "Producer approved cancellation of the exact uncaptured authorization: " + detail + ". Provider confirmation is pending; no refund or fee reversal is implied.");
    await client.query("INSERT INTO on_commands(tenant_id,command_id,payload_hash,result_revision) VALUES($1,$2,$3,$4)", [actor.tenantId, commandId, payloadHash, show.revision]);
    return show;
  });
}
