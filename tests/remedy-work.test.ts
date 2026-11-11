import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedDatabase } from "./isolated-database";
import { CommerceWire } from "./commerce-wire";
import { applyCommand, recordRescueRun, type Command } from "../src/domain/commands";
import { enumerateCandidates } from "../src/domain/scheduling";
import { financialSummary } from "../src/domain/finance";
import { testEngine } from "./helpers";
import type { Actor } from "../src/domain/contracts";

const database = await isolatedDatabase(), wire = new CommerceWire(database.pool); wire.immediateCapture = true;
(globalThis as typeof globalThis & { openingNightProviders?: unknown }).openingNightProviders = { venue: wire.provider(), brightline: wire.provider() };
const store = await import("../src/server/store"), payments = await import("../src/server/payment-store"), paymentService = await import("../src/server/payment-service");
const wallet = await import("../src/server/wallet-service"), walletStorage = await import("../src/server/wallet-storage");
const cohort = await import("../src/server/cohort-service"), storage = await import("../src/server/commerce-storage"), remedy = await import("../src/server/remedy-service");
const rfq = await import("../src/server/supplier-rfq"), rpc = await import("../src/app/api/enrolled-suppliers/[supplier]/rpc/route");
const supplierTransport: import("../src/server/supplier-protocol").SupplierTransport = request => rpc.POST(request, { params: Promise.resolve({ supplier: new URL(request.url).pathname.split("/").at(-2)! }) });
await payments.paymentStore(); after(async () => { await storage.closeCommerceLocks(); await database.close(); });
const signal = () => AbortSignal.timeout(10000);
const refundWrites = () => wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/refund"));
async function command(actor: Actor, action: Command) { const show = await store.getShow(actor.tenantId); return (await store.transactCommand(actor, randomUUID(), show.revision, action, current => applyCommand(current, actor, action))).show; }
async function currentPlan(actor: Actor) {
  let show = await store.getShow(actor.tenantId); if (!show.incidents.length) show = await command(actor, { type: "load_incidents" });
  if (show.offers.some(offer => !offer.serviceQuote)) {
    const rfqId = randomUUID(); await rfq.beginSupplierRfq(actor, rfqId, show.revision);
    assert.equal((await rfq.collectSupplierRfq(actor.tenantId, rfqId, signal(), supplierTransport)).status, "complete"); show = await store.getShow(actor.tenantId);
  }
  const candidates = enumerateCandidates(show); for (const candidate of candidates) candidate.report.engine = testEngine(candidate);
  show = (await store.transactCommand(actor, randomUUID(), show.revision, { type: "controlled-engine" }, current => recordRescueRun(current, actor, candidates))).show;
  const selected = candidates.find(candidate => candidate.id.startsWith("doors-brightline"))!;
  return command(actor, { type: "approve", candidateId: selected.id, candidateDigest: selected.digest, approvals: selected.approvals.map(item => item.id) });
}
async function captured(all = false) {
  const session = await store.createSession(undefined, "remedy-test:" + randomUUID()); const planned = await currentPlan(session.actor);
  const setup = await wallet.beginWalletSetup(session.actor, randomUUID(), planned.revision, "http://localhost:4105");
  await wallet.runWalletSetup(session.actor.tenantId, setup.id, signal()); const pending = await walletStorage.readWalletSetup(session.actor.tenantId, setup.id);
  wire.setups.get(pending.setupTokenId!)!.status = "APPROVED"; await wallet.runWalletSetup(session.actor.tenantId, setup.id, signal());
  const saved = await walletStorage.readWalletSetup(session.actor.tenantId, setup.id), show = await store.getShow(session.actor.tenantId);
  const draft = await cohort.draftCohort(session.actor, "saved_wallet", saved.savedWalletId, show.revision, "http://localhost:4105");
  await cohort.approveCohort(session.actor, draft.id, draft.digest, show.revision, signal());
  const lines = (await database.pool.query<{ document: import("../src/server/commerce-storage").CohortTicketRecord }>("SELECT document FROM on_cohort_tickets WHERE tenant_id=$1 ORDER BY ordinal", [session.actor.tenantId])).rows.map(row => row.document);
  for (const line of lines.filter(line => all || line.tier === "vip")) assert.equal((await cohort.runCohortTicket(session.actor.tenantId, draft.id, line.id, signal())).status, "complete");
  return { ...session, cohortId: draft.id, lines };
}
async function approve(value: Awaited<ReturnType<typeof captured>>) {
  const show = await store.getShow(value.actor.tenantId), preview = await remedy.remedyPreview(show);
  assert.equal(preview.public.ready, true); const batch = await remedy.approveRemedyBatch(value.actor, preview.public.digest, show.revision);
  const items = (await database.pool.query<{ document: import("../src/server/commerce-storage").RemedyItemRecord }>("SELECT document FROM on_remedy_items WHERE tenant_id=$1 ORDER BY ordinal", [value.actor.tenantId])).rows.map(row => row.document);
  return { ...value, batch, items };
}
async function run(value: Awaited<ReturnType<typeof approve>>, index: number) { return remedy.runRemedyItem(value.actor.tenantId, value.batch.id, value.items[index]!.id, signal()); }
async function overview(value: Awaited<ReturnType<typeof approve>>) { return (await remedy.remedyBatchOverview(value.actor.tenantId, await store.getShow(value.actor.tenantId)))!; }

test("a planned cohort and approved cancellation alone cannot create a refund batch", async () => {
  const session = await store.createSession(undefined, "empty-remedy:" + randomUUID()); const show = await currentPlan(session.actor);
  const preview = await remedy.remedyPreview(show); assert.equal(preview.public.ready, false); assert.equal(preview.public.eligibleCount, 0);
  await assert.rejects(() => remedy.approveRemedyBatch(session.actor, preview.public.digest, show.revision), /Review the current/);
  assert.equal((await payments.listIntents(session.actor.tenantId)).length, 0);
});
test("exact38 original capture remedies complete570 while preserving2800 admission and3370 gross history", async () => {
  const value = await captured(true); const show = await store.getShow(value.actor.tenantId), preview = await remedy.remedyPreview(show), before = refundWrites().length;
  assert.equal(preview.public.amountMinor, 57000); assert.equal(preview.public.newAmountMinor, 57000);
  const batches = await Promise.all([0, 1, 2].map(() => remedy.approveRemedyBatch(value.actor, preview.public.digest, show.revision)));
  assert.ok(batches.every(batch => batch.id === batches[0]!.id)); assert.equal(refundWrites().length, before);
  const approved = await approve(value); assert.equal(approved.items.length, 38); assert.equal(new Set(approved.items.map(item => item.captureId)).size, 38);
  for (let index = 0; index < 38; index++) assert.equal((await run(approved, index)).status, "complete");
  const money = financialSummary(await store.getShow(value.actor.tenantId));
  assert.equal(money.capturedTickets, 80); assert.equal(money.grossCapturedMinor, 337000); assert.equal(money.refundedVipCount, 38); assert.equal(money.vipRemedyMinor, 57000); assert.equal(money.ledgerTicketNetMinor, 280000);
  assert.equal((await overview(approved)).state, "complete"); assert.equal((await overview(approved)).preservedAdmissionMinor, 133000);
  for (const call of refundWrites().slice(before)) { assert.deepEqual(Object.keys(call.body!).sort(), ["amount", "custom_id"]); assert.deepEqual(call.body!.amount, { currency_code: "USD", value: "15.00" }); assert.ok(call.durable); }
  for (let index = 0; index < 38; index++) assert.equal((await run(approved, index)).status, "complete");
  const current = await store.getShow(value.actor.tenantId); await paymentService.handlePayment(value.actor, { type: "refund_perk", ticketId: approved.items[0]!.ticketId, expectedRevision: current.revision }, "http://localhost:4105");
  assert.equal(refundWrites().length, before + 38);
});
test("one pending remedy leaves37 confirmed and reconciles the same original refund after completion", async () => {
  const value = await approve(await captured());
  for (let index = 0; index < 37; index++) assert.equal((await run(value, index)).status, "complete");
  wire.failNext = "refund_pending"; const before = refundWrites().length;
  assert.equal((await run(value, 37)).status, "waiting"); const partial = await overview(value);
  assert.equal(partial.completedCount, 37); assert.equal(partial.refundedMinor, 55500); assert.notEqual(partial.state, "complete");
  const item = await storage.readRemedyItem(value.actor.tenantId, value.items[37]!.id); const intent = await payments.readIntent(value.actor.tenantId, item.intentId!);
  const order = wire.orders.get(item.orderId)!; const refund = order.purchase_units[0].payments.refunds.find((entry: { custom_id: string }) => entry.custom_id === intent.id); assert.ok(refund); refund.status = "COMPLETED";
  assert.equal((await run(value, 37)).status, "complete"); assert.equal((await overview(value)).completedCount, 38); assert.equal(refundWrites().length, before + 1);
});
test("a lost refund response is attributed by its original capture and durable custom ID without replay", async () => {
  const value = await approve(await captured()), before = refundWrites().length; wire.failNext = "refund_lost";
  assert.equal((await run(value, 0)).status, "complete"); assert.equal((await run(value, 0)).status, "complete"); assert.equal(refundWrites().length, before + 1);
  const publicBatch = await overview(value); assert.equal(publicBatch.completedCount, 1); assert.ok(publicBatch.lines[0]!.refundReference);
});
test("a changed production plan blocks unstarted batch refunds before an intent or provider write", async () => {
  const value = await approve(await captured()), before = refundWrites().length;
  await currentPlan(value.actor);
  await assert.rejects(() => run(value, 0)); assert.equal(refundWrites().length, before);
  assert.equal((await payments.listIntents(value.actor.tenantId)).filter(intent => intent.purpose === "vip_refund").length, 0);
});
test("batch stop preserves completed items and prevents every unstarted refund", async () => {
  const value = await approve(await captured()); await run(value, 0); const before = refundWrites().length;
  await remedy.revokeRemedyBatch(value.actor, value.batch.id); assert.equal((await run(value, 1)).status, "needs_attention");
  assert.equal((await run(value, 0)).status, "complete"); assert.equal(refundWrites().length, before); assert.equal((await overview(value)).completedCount, 1); assert.equal((await overview(value)).state, "revoked");
});
test("a pre-existing individual remedy is counted once and does not receive a second batch allocation", async () => {
  const value = await captured(); const ticket = value.lines.find(line => line.tier === "vip")!, show = await store.getShow(value.actor.tenantId);
  await paymentService.handlePayment(value.actor, { type: "refund_perk", ticketId: ticket.id, expectedRevision: show.revision }, "http://localhost:4105");
  const preview = await remedy.remedyPreview(await store.getShow(value.actor.tenantId)); assert.equal(preview.public.completedCount, 1); assert.equal(preview.public.newAmountMinor, 55500);
  const approved = await approve(value), before = refundWrites().length;
  const index = approved.items.findIndex(item => item.ticketId === ticket.id); assert.equal((await run(approved, index)).status, "complete"); assert.equal(refundWrites().length, before);
  assert.equal((await overview(approved)).completedCount, 1);
});
test("a prepared individual refund can join the ledger but the batch cannot dispatch it under another approval", async () => {
  const value = await captured(), show = await store.getShow(value.actor.tenantId), preview = await remedy.remedyPreview(show), allocation = preview.items[0]!;
  const { preparePaymentIntent } = await import("../src/server/payment-intents");
  const { lockSupplierShow } = await import("../src/server/supplier-storage");
  const original = await payments.paymentTransaction(async client => {
    const locked = await lockSupplierShow(client, value.actor.tenantId);
    return preparePaymentIntent(client, value.actor, { purpose: "vip_refund", seller: "venue", semanticKey: "ticket:" + allocation.ticketId + ":vip-remedy", ticketId: allocation.ticketId, tier: "vip", parentId: allocation.rootIntentId, resourceIds: [allocation.captureId, allocation.orderId], build: () => ({ kind: "refund_capture", money: { currency: "USD", minor: 1500 }, captureId: allocation.captureId, orderId: allocation.orderId }) }, locked);
  });
  const approved = await approve(value), index = approved.items.findIndex(item => item.ticketId === allocation.ticketId), before = refundWrites().length;
  assert.deepEqual(await run(approved, index), { status: "needs_attention", code: "NOT_DISPATCHED" }); assert.equal(refundWrites().length, before);
  const recorded = await storage.readRemedyItem(value.actor.tenantId, approved.items[index]!.id); assert.equal(recorded.intentId, original.intent.id);
  await assert.rejects(() => remedy.retryRemedyItem(value.actor, approved.batch.id, recorded.id, "http://localhost:4105"), /approved individually/);
  const current = await store.getShow(value.actor.tenantId);
  await paymentService.handlePayment(value.actor, { type: "refund_perk", ticketId: allocation.ticketId, expectedRevision: current.revision }, "http://localhost:4105");
  assert.equal((await run(approved, index)).status, "complete"); assert.equal(refundWrites().length, before + 1);
});
test("a changed original-capture document is rejected before any refund dispatch", async () => {
  const value = await approve(await captured()), before = refundWrites().length;
  await database.pool.query("UPDATE on_remedy_items SET document=jsonb_set(document,'{captureId}',to_jsonb($3::text)) WHERE tenant_id=$1 AND id=$2", [value.actor.tenantId, value.items[0]!.id, value.items[1]!.captureId]);
  await assert.rejects(() => run(value, 0), /immutable original-capture/); assert.equal(refundWrites().length, before);
});
