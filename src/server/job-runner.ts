import { PaymentError, ProviderError } from "@fracture/paypal-core";
import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { claimJob, finishJob, type Job, type JobResult } from "./jobs";
import { listIntents, paymentTransaction, readIntent } from "./payment-store";
import { pool } from "./store";
import { observeOwnedPayment } from "./payment-observations";
import type { DeliveryTransport } from "./payment-webhooks";

const paymentPayload = z.object({ intentId: z.uuid() }).strict();
const webhookPayload = z.object({ seller: z.enum(["venue", "brightline"]), eventId: z.string().min(3).max(128), rootIntentId: z.uuid() }).strict();
export async function handleJob(job: Job, signal: AbortSignal): Promise<JobResult> {
  const { reconcilePaymentIntent, providers } = await import("./payment-service");
  if (job.kind === "payment_reconcile") {
    const parsed = paymentPayload.safeParse(job.payload); if (!parsed.success) return { status: "needs_attention", code: "INVALID_JOB_PAYLOAD" };
    return reconcilePaymentIntent(job.tenantId, parsed.data.intentId, signal, true);
  }
  const parsed = webhookPayload.safeParse(job.payload); if (!parsed.success) return { status: "needs_attention", code: "INVALID_JOB_PAYLOAD" };
  const payload = parsed.data;
  const inbox = await pool.query<{ transport: DeliveryTransport }>("SELECT transport FROM on_webhook_inbox WHERE tenant_id=$1 AND seller=$2 AND event_id=$3 AND root_intent_id=$4 AND status='queued'", [job.tenantId, payload.seller, payload.eventId, payload.rootIntentId]);
  if (!inbox.rows[0]) return { status: "needs_attention", code: "WEBHOOK_OWNERSHIP_CHANGED" };
  const root = await readIntent(job.tenantId, payload.rootIntentId);
  if (root.seller !== payload.seller || root.parentId) return { status: "needs_attention", code: "WEBHOOK_OWNERSHIP_CHANGED" };
  const intents = (await listIntents(job.tenantId)).filter(intent => intent.seller === root.seller && (intent.id === root.id || intent.parentId === root.id));
  let unresolved: JobResult | undefined;
  for (const intent of intents) {
    // Webhooks cannot turn buyer approval or a suggested action into permission to pay.
    const result = await reconcilePaymentIntent(job.tenantId, intent.id, signal, false);
    if (result.status === "waiting") unresolved = result;
  }
  try { await observeOwnedPayment(root, providers[root.seller], signal, inbox.rows[0].transport); }
  catch (error) { if (error instanceof DomainError && error.code === "RESOURCE_BINDING_REQUIRED") return unresolved ?? { status: "waiting", code: "RESOURCE_BINDING_REQUIRED" }; throw error; }
  return unresolved ?? { status: "complete" };
}

function failure(error: unknown): JobResult {
  if (error instanceof DomainError) return { status: "needs_attention", code: /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : "AUTHORITY_CHECK_FAILED" };
  if (error instanceof PaymentError) return { status: error.httpStatus >= 500 || error.code === "OPERATION_CHANGED" ? "waiting" : "needs_attention", code: /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : "PAYMENT_CHECK_FAILED" };
  if (error instanceof ProviderError) return { status: "waiting", code: "PROVIDER_" + error.kind.toUpperCase() };
  return { status: "waiting", code: "WORK_INTERRUPTED" };
}
export async function runJobTick(options: { tenantId?: string; limit?: number; budgetMs?: number; handler?: typeof handleJob } = {}) {
  const budget = Math.max(1000, Math.min(options.budgetMs ?? 45000, 50000));
  const limit = Math.max(1, Math.min(options.limit ?? 4, 8)); const until = Date.now() + budget;
  const results: { id: string; kind: Job["kind"]; status: JobResult["status"] | "lease_lost" }[] = [];
  for (let index = 0; index < limit && Date.now() < until - 500; index++) {
    const job = await claimJob(options.tenantId); if (!job) break;
    const signal = AbortSignal.timeout(Math.max(1, until - Date.now())); let result: JobResult;
    try { result = await (options.handler ?? handleJob)(job, signal); }
    catch (error) { result = failure(error); }
    const completed = await paymentTransaction(async client => {
      const claimed = await finishJob(job, result, client);
      const terminal = result.status !== "waiting" || job.attempts >= job.maxAttempts;
      if (claimed && terminal && job.kind === "webhook_reconcile") {
        const parsed = webhookPayload.safeParse(job.payload);
        if (parsed.success) await client.query(`UPDATE on_webhook_inbox SET status=$4,processed_at=now(),last_code=$5
          WHERE tenant_id=$1 AND seller=$2 AND event_id=$3 AND root_intent_id=$6 AND status='queued'`, [job.tenantId, parsed.data.seller, parsed.data.eventId, result.status === "complete" ? "processed" : "needs_attention", result.status === "complete" ? null : result.status === "waiting" ? "ATTEMPT_LIMIT" : result.code, parsed.data.rootIntentId]);
      }
      return claimed;
    });
    results.push({ id: job.id, kind: job.kind, status: completed ? result.status === "waiting" && job.attempts >= job.maxAttempts ? "needs_attention" : result.status : "lease_lost" });
  }
  return { processed: results.length, results };
}
