import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedDatabase } from "./isolated-database";
import { CommerceWire } from "./commerce-wire";

const database = await isolatedDatabase(), wire = new CommerceWire(database.pool);
(globalThis as typeof globalThis & { openingNightProviders?: unknown }).openingNightProviders = { venue: wire.provider(), brightline: wire.provider() };
const store = await import("../src/server/store"), payments = await import("../src/server/payment-store"), paymentService = await import("../src/server/payment-service");
const wallet = await import("../src/server/wallet-service"), walletStorage = await import("../src/server/wallet-storage");
const cohort = await import("../src/server/cohort-service"), storage = await import("../src/server/commerce-storage");
await payments.paymentStore(); after(async () => { await storage.closeCommerceLocks(); await database.close(); });
const signal = () => AbortSignal.timeout(10000);
const code = (value: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === value);
async function draft(mode: "saved_wallet" | "buyer_present" = "saved_wallet") {
  const session = await store.createSession(undefined, "cohort-test:" + randomUUID()); let walletId: string | null = null;
  if (mode === "saved_wallet") {
    const setup = await wallet.beginWalletSetup(session.actor, randomUUID(), session.show.revision, "http://localhost:4105");
    await wallet.runWalletSetup(session.actor.tenantId, setup.id, signal());
    const pending = await walletStorage.readWalletSetup(session.actor.tenantId, setup.id); wire.setups.get(pending.setupTokenId!)!.status = "APPROVED";
    await wallet.runWalletSetup(session.actor.tenantId, setup.id, signal()); walletId = (await walletStorage.readWalletSetup(session.actor.tenantId, setup.id)).savedWalletId;
  }
  const current = await store.getShow(session.actor.tenantId);
  const prepared = await cohort.draftCohort(session.actor, mode, walletId, current.revision, "http://localhost:4105");
  const lines = (await database.pool.query<{ document: import("../src/server/commerce-storage").CohortTicketRecord }>("SELECT document FROM on_cohort_tickets WHERE tenant_id=$1 ORDER BY ordinal", [session.actor.tenantId])).rows.map(row => row.document);
  return { ...session, cohort: prepared, lines, walletId };
}
async function approved(mode: "saved_wallet" | "buyer_present" = "saved_wallet") {
  const value = await draft(mode); const current = await store.getShow(value.actor.tenantId);
  return { ...value, cohort: await cohort.approveCohort(value.actor, value.cohort.id, value.cohort.digest, current.revision, signal()) };
}
async function run(value: Awaited<ReturnType<typeof approved>>, index = 0) { return cohort.runCohortTicket(value.actor.tenantId, value.cohort.id, value.lines[index]!.id, signal()); }
async function view(value: Awaited<ReturnType<typeof approved>>) { return (await cohort.cohortOverview(value.actor.tenantId, await store.getShow(value.actor.tenantId)))!; }

test("a cohort draft fixes exactly80 immutable allocations without creating payments or sales", async () => {
  const value = await draft(); assert.equal(value.lines.length, 80); assert.equal(value.lines.filter(line => line.tier === "standard").length, 42); assert.equal(value.lines.filter(line => line.tier === "vip").length, 38);
  assert.equal(value.lines.reduce((sum, line) => sum + line.amountMinor, 0), 337000);
  assert.equal((await payments.listIntents(value.actor.tenantId)).length, 0); assert.equal((await store.getShow(value.actor.tenantId)).tickets.length, 0);
  const copy = await cohort.draftCohort(value.actor, "saved_wallet", value.walletId, 1, "http://localhost:4105"); assert.equal(copy.id, value.cohort.id); assert.equal(copy.ticketSetDigest, value.cohort.ticketSetDigest);
});
test("parallel approvals queue one bounded set and never buy merely by creating the draft", async () => {
  const value = await draft(); const current = await store.getShow(value.actor.tenantId), before = wire.writes("/v2/checkout/orders").length;
  const replies = await Promise.all([0, 1, 2].map(() => cohort.approveCohort(value.actor, value.cohort.id, value.cohort.digest, current.revision, signal())));
  assert.ok(replies.every(item => item.digest === replies[0]!.digest)); assert.equal(wire.writes("/v2/checkout/orders").length, before);
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_jobs WHERE tenant_id=$1 AND kind='cohort_ticket'", [value.actor.tenantId])).rows[0].count, 80);
  assert.equal(Date.parse(replies[0]!.expiresAt!) - Date.parse(replies[0]!.approvedAt!), 86400000);
});
test("one saved-wallet ticket uses exact independent consent and one stable order/capture pair", async () => {
  const value = await approved(); const before = wire.writes("/v2/checkout/orders").length;
  assert.equal((await run(value)).status, "complete"); assert.equal((await run(value)).status, "complete");
  const sent = wire.writes("/v2/checkout/orders").at(-1)!; assert.equal(wire.writes("/v2/checkout/orders").length, before + 1); assert.ok(sent.durable);
  assert.deepEqual(sent.body!.payment_source.paypal.stored_credential, { payment_initiator: "MERCHANT", usage_pattern: "IMMEDIATE", usage: "DERIVED" });
  assert.equal(sent.body!.purchase_units[0].amount.value, "35.00"); assert.equal(sent.body!.purchase_units[0].items.length, 1);
  assert.equal((await view(value)).capturedMinor, 3500); assert.equal((await view(value)).capturedCount, 1); assert.equal((await view(value)).reservedCount, 1);
  assert.equal((await payments.listIntents(value.actor.tenantId)).length, 2);
});
test("competing workers cannot dispatch the same logical ticket twice", async () => {
  const value = await approved(), before = wire.writes("/v2/checkout/orders").length;
  const results = await Promise.allSettled([0, 1, 2, 3].map(() => run(value)));
  assert.ok(results.some(result => result.status === "fulfilled")); assert.equal((await view(value)).capturedCount, 1); assert.equal(wire.writes("/v2/checkout/orders").length, before + 1);
});
test("an immediate create-order capture is imported without a second capture instruction", async () => {
  const value = await approved(); wire.immediateCapture = true; const capturesBefore = wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/capture")).length;
  try { assert.equal((await run(value)).status, "complete"); } finally { wire.immediateCapture = false; }
  assert.equal(wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/capture")).length, capturesBefore);
  assert.equal((await payments.listIntents(value.actor.tenantId)).length, 1); assert.equal((await view(value)).capturedCount, 1);
});
test("a lost order response pauses the cohort and permanently retains that ticket reservation", async () => {
  const value = await approved(); wire.failNext = "order_lost"; const before = wire.writes("/v2/checkout/orders").length;
  assert.equal((await run(value)).status, "waiting"); assert.equal((await view(value)).state, "paused");
  assert.deepEqual(await run(value, 1), { status: "waiting", code: "COHORT_PAUSED", delaySeconds: 300 });
  await run(value); assert.equal(wire.writes("/v2/checkout/orders").length, before + 1); assert.equal((await view(value)).reservedCount, 1); assert.equal((await view(value)).capturedCount, 0);
  await assert.rejects(() => cohort.resumeCohort(value.actor, value.cohort.id), code("COHORT_UNRESOLVED_TICKET"));
});
test("a lost capture response reconciles the original owned order and never repeats the capture", async () => {
  const value = await approved(); wire.failNext = "capture_lost"; const before = wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/capture")).length;
  assert.equal((await run(value)).status, "complete"); await run(value);
  assert.equal(wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/capture")).length, before + 1);
  assert.equal((await view(value)).capturedMinor, 3500);
});
test("revocation before work prevents even a new order and preserves the fixed ticket set", async () => {
  const value = await approved(), before = wire.writes("/v2/checkout/orders").length;
  await cohort.revokeCohort(value.actor, value.cohort.id); assert.equal((await run(value)).status, "needs_attention");
  assert.equal(wire.writes("/v2/checkout/orders").length, before); assert.equal((await payments.listIntents(value.actor.tenantId)).length, 0); assert.equal((await view(value)).state, "revoked");
});
test("revocation during the final token read stops a claimed operation before provider dispatch", async () => {
  const value = await approved(); let reads = 0; const before = wire.writes("/v2/checkout/orders").length;
  wire.before = async call => { if (call.method === "GET" && call.path.startsWith("/v3/vault/payment-tokens/") && ++reads === 2) await cohort.revokeCohort(value.actor, value.cohort.id); };
  try { assert.equal((await run(value)).status, "needs_attention"); } finally { wire.before = null; }
  assert.equal(wire.writes("/v2/checkout/orders").length, before); const intents = await payments.listIntents(value.actor.tenantId); assert.equal(intents.length, 1);
  const operation = await (await payments.paymentStore()).get(intents[0]!.command.scope, intents[0]!.id); assert.equal(operation?.status, "not_sent");
  assert.equal((await storage.readCohortTicket(value.actor.tenantId, value.lines[0]!.id)).dispatchAuthorizedAt, null);
});
test("a previously authorized in-flight capture may finish after stop, while every unstarted line stays stopped", async () => {
  const value = await approved(); wire.immediateCapture = true;
  wire.before = async call => { if (call.method === "POST" && call.path === "/v2/checkout/orders") await cohort.revokeCohort(value.actor, value.cohort.id); };
  try { assert.equal((await run(value)).status, "complete"); } finally { wire.before = null; wire.immediateCapture = false; }
  assert.equal((await run(value, 1)).status, "needs_attention"); assert.equal((await view(value)).capturedCount, 1); assert.equal((await view(value)).state, "revoked");
  const line = await storage.readCohortTicket(value.actor.tenantId, value.lines[0]!.id), current = await storage.readCohort(value.actor.tenantId, value.cohort.id);
  assert.ok(line.dispatchAuthorizedAt); assert.ok(Date.parse(line.dispatchAuthorizedAt!) <= Date.parse(current.revokedAt!));
});
test("an expired cohort cannot extend its authority by restarting queued work", async () => {
  const value = await approved(); value.cohort.expiresAt = new Date(Date.now() - 1000).toISOString(); await storage.saveCohort(database.pool, value.cohort);
  const before = wire.writes("/v2/checkout/orders").length; assert.equal((await run(value)).status, "needs_attention"); assert.equal(wire.writes("/v2/checkout/orders").length, before);
  await assert.rejects(() => cohort.resumeCohort(value.actor, value.cohort.id), code("COHORT_CONSENT_EXPIRED"));
});
test("payer action pauses further tickets until the same original order settles and the operator resumes", async () => {
  const value = await approved(); wire.requirePayerApproval = true;
  try { assert.equal((await run(value)).status, "needs_attention"); } finally { wire.requirePayerApproval = false; }
  const publicView = await view(value); assert.equal(publicView.state, "paused"); assert.ok(publicView.lines[0]!.approvalUrl);
  const line = await storage.readCohortTicket(value.actor.tenantId, value.lines[0]!.id); const root = await payments.readIntent(value.actor.tenantId, line.rootIntentId!);
  const order = (await payments.ownedResources(value.actor.tenantId, "venue", root.id)).find(resource => resource.kind === "order")!; wire.orders.get(order.id)!.status = "APPROVED";
  assert.equal((await run(value)).status, "complete"); await cohort.resumeCohort(value.actor, value.cohort.id); assert.equal((await view(value)).state, "approved");
});
test("all80 verified captures sum to3370 and replay cannot create an81st logical ticket", async () => {
  const value = await approved(); wire.immediateCapture = true; const before = wire.writes("/v2/checkout/orders").length;
  try { for (let index = 0; index < 80; index++) assert.equal((await run(value, index)).status, "complete"); }
  finally { wire.immediateCapture = false; }
  const result = await view(value); assert.equal(result.state, "complete"); assert.equal(result.capturedCount, 80); assert.equal(result.capturedMinor, 337000); assert.equal(result.reservedCount, 80);
  for (let index = 0; index < 80; index++) assert.equal((await run(value, index)).status, "complete");
  assert.equal(wire.writes("/v2/checkout/orders").length, before + 80);
  const show = await store.getShow(value.actor.tenantId); assert.equal(new Set(show.tickets.map(ticket => ticket.captureId)).size, 80);
  await assert.rejects(() => cohort.runCohortTicket(value.actor.tenantId, value.cohort.id, randomUUID(), signal()), code("COHORT_TICKET_NOT_FOUND"));
});
test("the same bounded allocation supports individual buyer-present approvals without a Vault token", async () => {
  const value = await approved("buyer_present"); const beforeReads = wire.calls.filter(call => call.path.startsWith("/v3/vault/")).length;
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_jobs WHERE tenant_id=$1 AND kind='cohort_ticket'", [value.actor.tenantId])).rows[0].count, 0);
  await cohort.startIndividualCohortTicket(value.actor, value.cohort.id, value.lines[0]!.id);
  const sent = wire.writes("/v2/checkout/orders").at(-1)!; assert.equal(sent.body!.payment_source.paypal.vault_id, undefined); assert.equal((await view(value)).capturedCount, 0);
  const line = await storage.readCohortTicket(value.actor.tenantId, value.lines[0]!.id), root = await payments.readIntent(value.actor.tenantId, line.rootIntentId!);
  const order = (await payments.ownedResources(value.actor.tenantId, "venue", root.id)).find(resource => resource.kind === "order")!; wire.orders.get(order.id)!.status = "APPROVED";
  const result = await paymentService.handlePayment(value.actor, { type: "complete_checkout", intentId: root.id, state: paymentService.callbackState(root) }, "http://localhost:4105");
  assert.equal(result.status, "succeeded"); assert.equal((await view(value)).capturedCount, 1); assert.equal(wire.calls.filter(call => call.path.startsWith("/v3/vault/")).length, beforeReads);
});
test("a pending immediate capture pauses the run and is read back without a second capture command", async () => {
  const value = await approved(); wire.immediateCapture = true; wire.immediateCaptureStatus = "PENDING";
  const before = wire.writes("/v2/checkout/orders").length, captures = wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/capture")).length;
  try { assert.equal((await run(value)).status, "waiting"); } finally { wire.immediateCapture = false; wire.immediateCaptureStatus = "COMPLETED"; }
  assert.equal((await view(value)).capturedCount, 0); assert.equal((await view(value)).state, "paused");
  assert.equal((await run(value, 1)).status, "waiting"); assert.equal(wire.writes("/v2/checkout/orders").length, before + 1);
  const line = await storage.readCohortTicket(value.actor.tenantId, value.lines[0]!.id);
  const order = (await payments.ownedResources(value.actor.tenantId, "venue", line.rootIntentId!)).find(resource => resource.kind === "order")!;
  wire.orders.get(order.id)!.purchase_units[0].payments.captures[0].status = "COMPLETED";
  assert.equal((await run(value)).status, "complete"); assert.equal((await view(value)).capturedCount, 1);
  assert.equal(wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/capture")).length, captures);
  await cohort.resumeCohort(value.actor, value.cohort.id); assert.equal((await view(value)).state, "approved");
});
test("a changed logical-ticket document cannot bypass its immutable price allocation", async () => {
  const value = await approved(), line = value.lines[0]!, before = wire.writes("/v2/checkout/orders").length;
  await database.pool.query("UPDATE on_cohort_tickets SET document=jsonb_set(document,'{amountMinor}','5000'::jsonb) WHERE tenant_id=$1 AND id=$2", [value.actor.tenantId, line.id]);
  await assert.rejects(() => run(value), code("COHORT_LINE_MISMATCH"));
  assert.equal(wire.writes("/v2/checkout/orders").length, before);
});
