import { randomUUID } from "node:crypto";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import type { PublicRemedyBatch, PublicRemedyPreview, PublicCommerceLine } from "@/domain/commerce-contracts";
import { currentActual, financialSummary, uniqueActual } from "@/domain/finance";
import { approvedRental, type PaymentIntent } from "@/domain/payment-authority";
import { activeCommerceActor, readRemedyBatch, readRemedyItem, saveRemedyBatch, saveRemedyItem, type DatabaseReader, type RemedyBatchRecord, type RemedyItemRecord } from "./commerce-storage";
import { remedyAllocationDigest, type RemedyAllocation } from "./commerce-policy";
import { getShow, pool } from "./store";
import { paymentStore, paymentTransaction, readIntent } from "./payment-store";
import { preparePaymentIntent } from "./payment-intents";
import { handlePayment, reconcilePaymentIntent } from "./payment-service";
import { publicLineState } from "./cohort-service";
import { enqueueJob, type JobResult } from "./jobs";
import { observeOwnedPayment } from "./payment-observations";
import { providers } from "./paypal-providers";
import { assertProducer, assertRevision, lockSupplierShow, saveSupplierSnapshot } from "./supplier-storage";

function qualifyingRefunds(show: ShowSnapshot) {
  const allowed = new Set(financialSummary(show).evidenceIds), actual = uniqueActual(show);
  const total = new Map<string, number>();
  for (const entry of actual) if (entry.kind === "refund" && entry.parentId) total.set(entry.parentId, (total.get(entry.parentId) ?? 0) + entry.amountMinor);
  return new Map(actual.filter(entry => allowed.has(entry.id) && entry.ticketId && entry.parentId && total.get(entry.parentId) === 1500).map(entry => [entry.ticketId + ":" + entry.parentId, entry]));
}
export async function remedyPreview(show: ShowSnapshot, client: DatabaseReader = pool): Promise<{ public: PublicRemedyPreview; items: RemedyAllocation[] }> {
  const empty: PublicRemedyPreview = { digest: remedyAllocationDigest(show.tenantId, show.planVersion, show.approvedPlan?.digest ?? null, []), planVersion: show.planVersion, eligibleCount: 0, requiredCount: 38, amountMinor: 0, completedCount: 0, newAmountMinor: 0, ready: false, reason: "Approve the recovery that cancels the soundcheck visit before reviewing its precise remedy.", captureReferences: [] };
  let approved: ReturnType<typeof approvedRental>;
  try { approved = approvedRental(show); } catch (error) { if (error instanceof DomainError) return { public: { ...empty, reason: error.message }, items: [] }; throw error; }
  if (!approved.candidate.patch.canceledPerk) return { public: empty, items: [] };
  const current = currentActual(show);
  let tickets = show.tickets.filter(ticket => ticket.tier === "vip" && ticket.source === "live_sandbox" && ticket.captureId && ticket.admissionMinor === 3500 && ticket.perkMinor === 1500 && current.some(entry => entry.kind === "capture" && entry.purpose === "ticket" && entry.ticketId === ticket.id && entry.providerResourceId === ticket.captureId && entry.amountMinor === 5000));
  const cohort = await client.query<{ id: string }>("SELECT id FROM on_ticket_cohorts WHERE tenant_id=$1 AND document->>'approvedAt' IS NOT NULL", [show.tenantId]);
  if (cohort.rows[0]) {
    const owned = await client.query<{ id: string }>("SELECT id FROM on_cohort_tickets WHERE tenant_id=$1 AND cohort_id=$2 AND tier='vip'", [show.tenantId, cohort.rows[0].id]);
    const ids = new Set(owned.rows.map(row => row.id)); tickets = tickets.filter(ticket => ids.has(ticket.id));
  }
  const roots = (await client.query<{ document: PaymentIntent }>("SELECT document FROM on_payment_intents WHERE tenant_id=$1 AND seller='venue' AND document->>'purpose'='ticket_order'", [show.tenantId])).rows.map(row => row.document);
  const bindings = (await client.query<{ root_intent_id: string; kind: string; provider_id: string }>("SELECT root_intent_id,kind,provider_id FROM on_payment_bindings WHERE tenant_id=$1 AND seller='venue' AND kind IN ('capture','order')", [show.tenantId])).rows;
  const items: RemedyAllocation[] = [];
  for (const ticket of tickets.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const matches = roots.filter(root => root.ticketId === ticket.id && !root.parentId && root.tier === "vip" && root.command.action.money.minor === 5000);
    if (matches.length !== 1) return { public: { ...empty, reason: "One or more VIP tickets need their exact original checkout ownership reconciled." }, items: [] };
    const owned = bindings.filter(binding => binding.root_intent_id === matches[0]!.id), captures = owned.filter(binding => binding.kind === "capture"), orders = owned.filter(binding => binding.kind === "order");
    if (captures.length !== 1 || captures[0]!.provider_id !== ticket.captureId || orders.length !== 1 || ![0, 1500].includes(ticket.refundedMinor)) return { public: { ...empty, reason: "A VIP capture has ambiguous ownership or an unexpected prior refund. Review it before batching remedies." }, items: [] };
    items.push({ ticketId: ticket.id, rootIntentId: matches[0]!.id, orderId: orders[0]!.provider_id, captureId: ticket.captureId!, amountMinor: 1500 });
  }
  const refunds = qualifyingRefunds(show);
  const completedCount = items.filter(item => refunds.has(item.ticketId + ":" + item.captureId)).length;
  const ready = items.length === 38 && new Set(items.map(item => item.captureId)).size === 38;
  return { items, public: { digest: remedyAllocationDigest(show.tenantId, show.planVersion, approved.plan.digest, items), planVersion: show.planVersion,
    eligibleCount: items.length, requiredCount: 38, amountMinor: items.length * 1500, completedCount, newAmountMinor: (items.length - completedCount) * 1500,
    ready, reason: ready ? "Thirty-eight original VIP captures are owned and separately allocated. Each remedy preserves its $35 admission." : `${items.length} of 38 original VIP captures are currently verified. The batch becomes reviewable when all thirty-eight are owned and confirmed.`,
    captureReferences: items.map(item => "••••" + item.captureId.slice(-6)) } };
}
export async function approveRemedyBatch(actor: Actor, reviewedDigest: string, expectedRevision: number) {
  assertProducer(actor); await paymentStore();
  return paymentTransaction(async client => {
    const show = await lockSupplierShow(client, actor.tenantId);
    const prior = await client.query<{ document: RemedyBatchRecord }>("SELECT document FROM on_remedy_batches WHERE tenant_id=$1 FOR UPDATE", [actor.tenantId]);
    if (prior.rows[0]) {
      if (prior.rows[0].document.digest !== reviewedDigest || prior.rows[0].document.approvedBy !== actor.id) throw new DomainError("REMEDY_BATCH_ALREADY_APPROVED", "This production already has its original capture-specific remedy approval.");
      return prior.rows[0].document;
    }
    assertRevision(show, expectedRevision); const preview = await remedyPreview(show, client);
    if (!preview.public.ready || preview.public.digest !== reviewedDigest) throw new DomainError("REMEDY_REVIEW_CHANGED", "Review the current thirty-eight original captures before approving their remedies.");
    const { plan } = approvedRental(show); const now = Date.now();
    const batch: RemedyBatchRecord = { id: randomUUID(), tenantId: actor.tenantId, state: "approved", digest: reviewedDigest, planVersion: show.planVersion, planDigest: plan.digest,
      approvedBy: actor.id, approvedAt: new Date(now).toISOString(), expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(), revokedAt: null, pauseCode: null, pauseItemId: null };
    await activeCommerceActor(actor.tenantId, actor.id, client);
    await client.query("INSERT INTO on_remedy_batches(id,tenant_id,document) VALUES($1,$2,$3)", [batch.id, actor.tenantId, batch]);
    for (const [index, allocation] of preview.items.entries()) {
      const item: RemedyItemRecord = { ...allocation, id: randomUUID(), tenantId: actor.tenantId, batchId: batch.id, ordinal: index + 1, intentId: null, dispatchAuthorizedAt: null, lastCode: null };
      await client.query("INSERT INTO on_remedy_items(id,tenant_id,batch_id,ticket_id,capture_id,amount_minor,ordinal,document) VALUES($1,$2,$3,$4,$5,1500,$6,$7)", [item.id, item.tenantId, item.batchId, item.ticketId, item.captureId, item.ordinal, item]);
      await enqueueJob(client, { tenantId: actor.tenantId, kind: "remedy_item", semanticKey: item.id, payload: { batchId: batch.id, itemId: item.id } });
    }
    await saveSupplierSnapshot(client, show, actor.id, "remedy.batch_approved", `Approved 38 capture-specific $15 remedies, $570 total. ${preview.public.completedCount} existing completed remedies are retained; each $35 admission remains intact.`);
    return batch;
  });
}
export async function runRemedyItem(tenantId: string, batchId: string, itemId: string, signal: AbortSignal): Promise<JobResult> {
  let item = await readRemedyItem(tenantId, itemId); const batch = await readRemedyBatch(tenantId, batchId);
  if (item.batchId !== batch.id) return { status: "needs_attention", code: "REMEDY_BATCH_LINE_MISMATCH" };
  if (qualifyingRefunds(await getShow(tenantId)).has(item.ticketId + ":" + item.captureId)) return { status: "complete" };
  const permitted = batch.state === "approved" && !batch.revokedAt && Date.parse(batch.expiresAt) > Date.now();
  if (!item.intentId && !permitted) return { status: "needs_attention", code: "REMEDY_BATCH_AUTHORITY_EXPIRED" };
  let intent: PaymentIntent;
  if (item.intentId) intent = await readIntent(tenantId, item.intentId);
  else intent = await paymentTransaction(async client => {
    const show = await lockSupplierShow(client, tenantId); const currentBatch = await readRemedyBatch(tenantId, batchId, client, true); item = await readRemedyItem(tenantId, itemId, client);
    if (item.intentId) return readIntent(tenantId, item.intentId, client);
    if (currentBatch.state !== "approved" || currentBatch.revokedAt || Date.parse(currentBatch.expiresAt) <= Date.now()) throw new DomainError("REMEDY_BATCH_AUTHORITY_EXPIRED", "This remedy batch has no current permission for a new refund.", 403);
    const actor = await activeCommerceActor(tenantId, currentBatch.approvedBy, client);
    const result = await preparePaymentIntent(client, actor, { purpose: "vip_refund", semanticKey: "ticket:" + item.ticketId + ":vip-remedy", seller: "venue", parentId: item.rootIntentId,
      ticketId: item.ticketId, tier: "vip", remedyBatchId: batchId, remedyItemId: itemId, resourceIds: [item.captureId, item.orderId],
      build: () => ({ kind: "refund_capture", money: { currency: "USD", minor: 1500 }, captureId: item.captureId, orderId: item.orderId }) }, show);
    item.intentId = result.intent.id; await saveRemedyItem(client, item); return result.intent;
  });
  // A previous individual instruction keeps its own authority. Joining the batch
  // permits readback and counting it once, never a new dispatch under another grant.
  let result = await reconcilePaymentIntent(tenantId, intent.id, signal, permitted && intent.remedyBatchId === batch.id);
  if (result.status === "complete") {
    await observeOwnedPayment(await readIntent(tenantId, item.rootIntentId), providers.venue, signal);
    if (!qualifyingRefunds(await getShow(tenantId)).has(item.ticketId + ":" + item.captureId)) result = { status: "needs_attention", code: "REMEDY_CURRENT_STATE_REQUIRED" };
  }
  if (result.status !== "complete") await pool.query("UPDATE on_remedy_items SET document=jsonb_set(document,'{lastCode}',to_jsonb($3::text)) WHERE tenant_id=$1 AND id=$2", [tenantId, itemId, result.code]);
  return result;
}
export async function retryRemedyItem(actor: Actor, batchId: string, itemId: string, origin: string) {
  assertProducer(actor); const batch = await readRemedyBatch(actor.tenantId, batchId), item = await readRemedyItem(actor.tenantId, itemId);
  if (batch.approvedBy !== actor.id || item.batchId !== batchId || !item.intentId) throw new DomainError("REMEDY_BATCH_LINE_MISMATCH", "Select an original refused instruction from this remedy batch.", 403);
  const intent = await readIntent(actor.tenantId, item.intentId);
  if (intent.remedyBatchId !== batch.id) throw new DomainError("REMEDY_INDIVIDUAL_REVIEW_REQUIRED", "This refund was approved individually. Review its original instruction in the individual ticket desk.", 409);
  return handlePayment(actor, { type: "retry_refused", intentId: item.intentId }, origin);
}
export async function revokeRemedyBatch(actor: Actor, batchId: string) {
  assertProducer(actor);
  return paymentTransaction(async client => {
    const show = await lockSupplierShow(client, actor.tenantId), batch = await readRemedyBatch(actor.tenantId, batchId, client, true);
    if (batch.revokedAt) return batch;
    batch.revokedAt = new Date().toISOString(); batch.state = "revoked"; await saveRemedyBatch(client, batch);
    await saveSupplierSnapshot(client, show, actor.id, "remedy.batch_stopped", "Stopped unstarted remedies while retaining all confirmed and in-flight refund identities. A partial batch does not clear readiness.");
    return batch;
  });
}
export async function remedyBatchOverview(tenantId: string, show: ShowSnapshot): Promise<PublicRemedyBatch | null> {
  const record = await pool.query<{ document: RemedyBatchRecord }>("SELECT document FROM on_remedy_batches WHERE tenant_id=$1", [tenantId]); const batch = record.rows[0]?.document; if (!batch) return null;
  const items = (await pool.query<{ document: RemedyItemRecord }>("SELECT document FROM on_remedy_items WHERE tenant_id=$1 AND batch_id=$2 ORDER BY ordinal", [tenantId, batch.id])).rows.map(row => row.document);
  const operations = new Map((await (await paymentStore()).list({ tenantId, projectId: "opening-night:venue" })).map(operation => [operation.command.intentId, operation]));
  const refunds = qualifyingRefunds(show);
  const lines: PublicCommerceLine[] = items.map(item => {
    const refund = refunds.get(item.ticketId + ":" + item.captureId), operation = item.intentId ? operations.get(item.intentId) ?? null : null;
    return { id: item.id, ordinal: item.ordinal, tier: "vip", amountMinor: 1500, state: refund ? "refunded" : !item.intentId && (batch.revokedAt || Date.parse(batch.expiresAt) <= Date.now()) ? "stopped" : publicLineState(operation, "remedy"),
      intentId: item.intentId, captureReference: "••••" + item.captureId.slice(-6), refundReference: refund ? "••••" + refund.providerResourceId.slice(-6) : null,
      approvalUrl: null, lastCode: refund ? null : item.lastCode };
  });
  const completedCount = lines.filter(line => line.state === "refunded").length;
  return { id: batch.id, state: completedCount === 38 ? "complete" : batch.revokedAt ? "revoked" : Date.parse(batch.expiresAt) <= Date.now() ? "expired" : batch.state,
    digest: batch.digest, planVersion: batch.planVersion, approvedAt: batch.approvedAt, expiresAt: batch.expiresAt, pauseCode: batch.pauseCode,
    completedCount, refundedMinor: completedCount * 1500, preservedAdmissionMinor: completedCount * 3500, lines };
}
