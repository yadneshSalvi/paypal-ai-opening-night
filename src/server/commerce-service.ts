import { z } from "zod";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import type { CommerceOverview } from "@/domain/commerce-contracts";
import { currentActual } from "@/domain/finance";
import { assertProducer } from "./supplier-storage";
import { getShow, pool } from "./store";
import { paymentStore, readIntent } from "./payment-store";
import { observeOwnedPayment } from "./payment-observations";
import { providers } from "./paypal-providers";
import { readCohortTicket, readRemedyItem } from "./commerce-storage";
import { beginWalletSetup, retryWallet, runWalletSetup, stopWalletSetup, walletOverview, walletReturn } from "./wallet-service";
import { approveCohort, cohortOverview, draftCohort, resumeCohort, retryCohortTicket, revokeCohort, runCohortTicket, startIndividualCohortTicket, verifiedCohortCapture } from "./cohort-service";
import { approveRemedyBatch, remedyBatchOverview, remedyPreview, retryRemedyItem, revokeRemedyBatch, runRemedyItem } from "./remedy-service";
import type { JobKind, JobResult } from "./jobs";

const revision = z.number().int().positive(), identity = z.uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const commerceRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wallet_start"), idempotencyKey: identity, expectedRevision: revision, saveOnly: z.literal(true) }).strict(),
  z.object({ type: z.literal("wallet_check"), setupId: identity }).strict(),
  z.object({ type: z.literal("wallet_retry"), setupId: identity }).strict(),
  z.object({ type: z.literal("wallet_stop"), setupId: identity }).strict(),
  z.object({ type: z.literal("wallet_return"), setupId: identity, state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), cancel: z.boolean() }).strict(),
  z.object({ type: z.literal("cohort_draft"), mode: z.enum(["saved_wallet", "buyer_present"]), walletId: identity.nullable(), expectedRevision: revision }).strict(),
  z.object({ type: z.literal("cohort_approve"), cohortId: identity, digest, expectedRevision: revision, maximumMinor: z.literal(337000), maximumTickets: z.literal(80), oneControlledBuyer: z.literal(true), separatePurchases: z.literal(true) }).strict(),
  z.object({ type: z.literal("cohort_stop"), cohortId: identity }).strict(),
  z.object({ type: z.literal("cohort_resume"), cohortId: identity }).strict(),
  z.object({ type: z.literal("ticket_start"), cohortId: identity, ticketId: identity }).strict(),
  z.object({ type: z.literal("ticket_check"), cohortId: identity, ticketId: identity }).strict(),
  z.object({ type: z.literal("ticket_retry"), cohortId: identity, ticketId: identity }).strict(),
  z.object({ type: z.literal("remedy_approve"), digest, expectedRevision: revision, maximumMinor: z.literal(57000), perCaptureMinor: z.literal(1500), preserveAdmission: z.literal(true) }).strict(),
  z.object({ type: z.literal("remedy_check"), batchId: identity, itemId: identity }).strict(),
  z.object({ type: z.literal("remedy_retry"), batchId: identity, itemId: identity }).strict(),
  z.object({ type: z.literal("remedy_stop"), batchId: identity }).strict(),
]);
export type CommerceRequest = z.infer<typeof commerceRequest>;

/** A manual result can update waiting work, but can never overwrite a worker's lease. */
async function recordManualWork(tenantId: string, kind: JobKind, key: string, work: () => Promise<JobResult>) {
  const result = await work();
  const delay = result.status === "waiting" ? Math.max(1, Math.min(result.delaySeconds ?? 30, 3600)) : 0;
  await pool.query("UPDATE on_jobs SET status=$4,last_code=$5,run_after=now()+($6*interval '1 second'),updated_at=now() WHERE tenant_id=$1 AND kind=$2 AND semantic_key=$3 AND status<>'running'",
    [tenantId, kind, key, result.status, result.status === "complete" ? null : result.code, delay]);
  return result;
}
export async function commerceOverview(actor: Actor, snapshot?: ShowSnapshot): Promise<CommerceOverview> {
  assertProducer(actor); await paymentStore(); const show = snapshot ?? await getShow(actor.tenantId);
  const [wallet, cohort, preview, remedyBatch] = await Promise.all([walletOverview(actor.tenantId), cohortOverview(actor.tenantId, show), remedyPreview(show), remedyBatchOverview(actor.tenantId, show)]);
  return { wallet, cohort, remedyPreview: preview.public, remedyBatch, serverAt: new Date().toISOString() };
}
export async function handleCommerce(actor: Actor, request: CommerceRequest, origin: string): Promise<JobResult | null> {
  assertProducer(actor); await paymentStore(); const signal = AbortSignal.timeout(45000);
  const walletWork = (id: string) => recordManualWork(actor.tenantId, "wallet_setup", id, () => runWalletSetup(actor.tenantId, id, signal));
  const ticketWork = (id: string, work: () => Promise<JobResult>) => recordManualWork(actor.tenantId, "cohort_ticket", id, work);
  const remedyWork = (batchId: string, id: string) => recordManualWork(actor.tenantId, "remedy_item", id, () => runRemedyItem(actor.tenantId, batchId, id, signal));
  switch (request.type) {
    case "wallet_start": { const setup = await beginWalletSetup(actor, request.idempotencyKey, request.expectedRevision, origin); return walletWork(setup.id); }
    case "wallet_check": return walletWork(request.setupId);
    case "wallet_retry": await retryWallet(actor, request.setupId); return walletWork(request.setupId);
    case "wallet_stop": await stopWalletSetup(actor, request.setupId); return walletWork(request.setupId);
    case "wallet_return": await walletReturn(actor, request.setupId, request.state, request.cancel); return walletWork(request.setupId);
    case "cohort_draft": await draftCohort(actor, request.mode, request.walletId, request.expectedRevision, origin); return null;
    case "cohort_approve": await approveCohort(actor, request.cohortId, request.digest, request.expectedRevision, signal); return null;
    case "cohort_stop": await revokeCohort(actor, request.cohortId); return null;
    case "cohort_resume": await resumeCohort(actor, request.cohortId); return null;
    case "ticket_start": return ticketWork(request.ticketId, () => startIndividualCohortTicket(actor, request.cohortId, request.ticketId));
    case "ticket_check": {
      const line = await readCohortTicket(actor.tenantId, request.ticketId);
      if (!line.rootIntentId || line.cohortId !== request.cohortId) throw new DomainError("COHORT_ORIGINAL_INSTRUCTION_REQUIRED", "Select a ticket that already has its original checkout instruction.", 409);
      return ticketWork(request.ticketId, async () => {
        const result = await runCohortTicket(actor.tenantId, request.cohortId, request.ticketId, signal);
        if (result.status !== "complete") return result;
        const root = await readIntent(actor.tenantId, line.rootIntentId!);
        await observeOwnedPayment(root, providers.venue, signal);
        const show = await getShow(actor.tenantId), capture = verifiedCohortCapture(show, line);
        return capture && currentActual(show).some(item => item.id === capture.id) ? { status: "complete" } : { status: "needs_attention", code: "CAPTURE_STATE_REVIEW_REQUIRED" };
      });
    }
    case "ticket_retry": return ticketWork(request.ticketId, () => retryCohortTicket(actor, request.cohortId, request.ticketId));
    case "remedy_approve": await approveRemedyBatch(actor, request.digest, request.expectedRevision); return null;
    case "remedy_check": {
      const item = await readRemedyItem(actor.tenantId, request.itemId);
      if (!item.intentId || item.batchId !== request.batchId) throw new DomainError("REMEDY_ORIGINAL_INSTRUCTION_REQUIRED", "Select a remedy that already has its original refund instruction.", 409);
      return remedyWork(request.batchId, request.itemId);
    }
    case "remedy_retry": await retryRemedyItem(actor, request.batchId, request.itemId, origin); return remedyWork(request.batchId, request.itemId);
    case "remedy_stop": await revokeRemedyBatch(actor, request.batchId); return null;
  }
}
