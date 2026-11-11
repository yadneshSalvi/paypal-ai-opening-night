import type { PoolClient } from "pg";
import type { FinancialEvidence, ShowSnapshot } from "@/domain/contracts";
import type { PaymentIntent } from "@/domain/payment-authority";
import { DomainError } from "@/domain/contracts";
import { enqueueJob } from "./jobs";
import { readRentalExecution, saveRentalExecution } from "./supplier-storage";

/** Invoked inside the receipt transaction. Financial success never implies supplier capacity or accepted delivery. */
export async function projectRentalPayment(client: PoolClient, show: ShowSnapshot, intent: PaymentIntent, evidence: FinancialEvidence[]) {
  if (!intent.executionId) return;
  const execution = await readRentalExecution(client, show.tenantId, intent.executionId);
  if (execution.paymentRootId !== (intent.parentId ?? intent.id) || execution.planVersion !== intent.planVersion || execution.planDigest !== intent.planDigest) throw new DomainError("EXECUTION_PAYMENT_CONFLICT", "This receipt cannot be attributed to the exact original rental execution.");
  const authorization = evidence.find(item => item.kind === "authorization" && item.purpose === "rental");
  if (authorization) {
    if (execution.authorizationId && execution.authorizationId !== authorization.providerResourceId) throw new DomainError("EXECUTION_AUTHORIZATION_CONFLICT", "This rental already has a different original authorization.");
    execution.authorizationId = authorization.providerResourceId;
    if (!['confirmed', 'delivered', 'accepted', 'returned', 'compensation_pending', 'cancelled'].includes(execution.state)) {
      const expired = Date.parse(execution.holdExpiresAt) <= Date.now() || execution.state === "expired";
      execution.state = expired ? "reconfirmation_required" : "authorized";
      execution.lastCode = expired ? "HOLD_EXPIRED_DURING_APPROVAL" : null;
      if (!expired) await enqueueJob(client, { tenantId: show.tenantId, kind: "supplier_confirm", semanticKey: execution.id, payload: { executionId: execution.id, requestId: execution.id } });
    }
  }
  if (evidence.some(item => item.kind === "void" && item.purpose === "rental_cancel" && item.parentId === execution.authorizationId)) {
    execution.state = "cancelled"; execution.lastCode = null;
    await client.query("UPDATE on_resource_holds SET status='released',updated_at=now() WHERE id=$1", [execution.id]);
    await client.query("UPDATE on_delivery_receipts SET document=jsonb_set(document,'{state}','\"revoked\"'::jsonb) WHERE execution_id=$1 AND document->>'state' IN ('issued','scanned')", [execution.id]);
  }
  await saveRentalExecution(client, show, execution);
}
