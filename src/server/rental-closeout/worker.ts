import { DomainError } from "@/domain/contracts";
import { env } from "../env";
import type { JobResult } from "../jobs";
import { readIntent } from "../payment-store";
import { pool } from "../store";
import { readCloseoutGrant } from "./store";
export async function runRentalCloseoutWork(tenantId: string, intentId: string, signal: AbortSignal, mode: "dispatch" | "readback" | "retry" = "readback", retryGrantId?: string): Promise<JobResult> {
  const intent = await readIntent(tenantId, intentId);
  if (!intent.executionId || !["rental_release", "rental_fee"].includes(intent.purpose)) throw new DomainError("ORIGINAL_RENTAL_INSTRUCTION_REQUIRED", "Readback belongs to an original rental fee or hold closure.", 403);
  if (env.controlledQa) return { status: "needs_attention", code: "PROVIDER_QA_DISABLED" };
  const { reconcilePaymentIntent, retryOriginalRentalCloseout } = await import("../payment-service");
  let result: JobResult;
  if (mode !== "readback" && !intent.rentalCloseoutId || mode === "retry" && !retryGrantId) throw new DomainError("RENTAL_CLOSEOUT_REQUIRED", "Only an exact retained hold-closure approval can dispatch or retry.", 403);
  if (mode === "retry" && retryGrantId) {
    const { progress } = await readCloseoutGrant(tenantId, retryGrantId);
    if (intent.rentalCloseoutId !== retryGrantId || progress.intentId !== intent.id) throw new DomainError("ORIGINAL_RENTAL_RETRY_UNPROVEN", "The retry does not match its original retained approval.", 403);
    const operation = await retryOriginalRentalCloseout(tenantId, intentId);
    result = operation.status === "succeeded" ? { status: "complete" } : ["refused", "not_sent"].includes(operation.status) ? { status: "needs_attention", code: "EXPLICIT_RETRY_REQUIRED" } : { status: "waiting", code: "PROVIDER_OUTCOME_UNKNOWN" };
  } else result = await reconcilePaymentIntent(tenantId, intentId, signal, mode === "dispatch");
  if (intent.rentalCloseoutId) await pool.query("UPDATE on_rental_closeout_progress SET last_code=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND grant_id=$2", [tenantId, intent.rentalCloseoutId, result.status === "complete" ? null : result.code]);
  return result;
}
