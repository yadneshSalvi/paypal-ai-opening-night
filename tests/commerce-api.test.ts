/** Real route admission and disposable PostgreSQL, with controlled SDK transport only. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedDatabase } from "./isolated-database";
import { CommerceWire } from "./commerce-wire";

const database = await isolatedDatabase(), wire = new CommerceWire(database.pool); wire.immediateCapture = true;
(globalThis as typeof globalThis & { openingNightProviders?: unknown }).openingNightProviders = { venue: wire.provider(), brightline: wire.provider() };
const store = await import("../src/server/store"), payments = await import("../src/server/payment-store");
const wallet = await import("../src/server/wallet-service"), walletStorage = await import("../src/server/wallet-storage"), locks = await import("../src/server/commerce-storage");
const route = await import("../src/app/api/commerce/route"), jobs = await import("../src/server/jobs"), runner = await import("../src/server/job-runner");
await payments.paymentStore(); after(async () => { await locks.closeCommerceLocks(); await database.close(); });
const origin = "http://localhost:4105";
const session = () => store.createSession(undefined, "commerce-api:" + randomUUID());
function request(token: string, body?: unknown, overrideOrigin = origin) {
  return new Request(origin + "/api/commerce", { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + token, origin: overrideOrigin, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function post(token: string, body: unknown) { const response = await route.POST(request(token, body)); return { response, body: await response.json() }; }
async function saved() {
  const value = await session();
  const started = await post(value.token, { type: "wallet_start", idempotencyKey: randomUUID(), expectedRevision: value.show.revision, saveOnly: true });
  assert.equal(started.response.status, 202);
  const setup = await walletStorage.readWalletSetup(value.actor.tenantId, started.body.commerce.wallet.id);
  wire.setups.get(setup.setupTokenId!)!.status = "APPROVED";
  const returned = await post(value.token, { type: "wallet_return", setupId: setup.id, state: wallet.walletCallbackState(setup), cancel: false });
  assert.equal(returned.response.status, 200); assert.equal(returned.body.commerce.wallet.status, "ready");
  return { ...value, current: returned.body, setup };
}
test("commerce reads require the producer and never dispatch a provider instruction", async () => {
  const value = await session(), before = wire.calls.length;
  const response = await route.GET(request(value.token)); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json(); assert.equal(body.commerce.wallet, null); assert.equal(body.commerce.cohort, null); assert.equal(wire.calls.length, before);
  assert.equal((await route.GET(request("invalid-session"))).status, 401);
  const crew = await store.createCrewCapability(value.actor, "priya"); assert.equal((await route.GET(request(crew))).status, 403);
  assert.equal((await post(crew, { type: "wallet_start", idempotencyKey: randomUUID(), expectedRevision: value.show.revision, saveOnly: true })).response.status, 403);
  assert.equal(wire.calls.length, before);
});
test("mutations reject cross-origin, oversized, extra and unacknowledged terms before any provider call", async () => {
  const value = await session(), before = wire.calls.length;
  const body = { type: "wallet_start", idempotencyKey: randomUUID(), expectedRevision: value.show.revision, saveOnly: true };
  assert.equal((await route.POST(request(value.token, body, "http://127.0.0.1:4105"))).status, 403);
  assert.equal((await post(value.token, { ...body, saveOnly: false })).response.status, 400);
  assert.equal((await post(value.token, { ...body, maximumMinor: 1 })).response.status, 400);
  assert.equal((await post(value.token, { ...body, padding: "a".repeat(9000) })).response.status, 413);
  assert.equal(wire.calls.length, before); assert.equal((await database.pool.query("SELECT id FROM on_wallet_setups WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 0);
});
test("Next-normalized requests retain the validated loopback host in wallet returns and cohort authority", async () => {
  const value = await session(), actualOrigin = "http://127.0.0.1:4105";
  const normalized = (body: unknown) => new Request(origin + "/api/commerce", { method: "POST", headers: { authorization: "Bearer " + value.token, origin: actualOrigin, host: "127.0.0.1:4105", "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await route.POST(normalized({ type: "wallet_start", idempotencyKey: randomUUID(), expectedRevision: value.show.revision, saveOnly: true }));
  assert.equal(response.status, 202); const body = await response.json();
  const setup = await walletStorage.readWalletSetup(value.actor.tenantId, body.commerce.wallet.id); assert.equal(setup.origin, actualOrigin);
  const operation = await walletStorage.readWalletOperation(value.actor.tenantId, setup.id, "setup");
  assert.ok(operation?.request.phase === "setup");
  assert.ok(operation.request.body.paymentSource.paypal?.experienceContext?.returnUrl?.startsWith(actualOrigin + "/wallet/return?"));
  const draft = await route.POST(normalized({ type: "cohort_draft", mode: "buyer_present", walletId: null, expectedRevision: body.show.revision }));
  assert.equal(draft.status, 200); const draftBody = await draft.json();
  assert.equal((await locks.readCohort(value.actor.tenantId, draftBody.commerce.cohort.id)).origin, actualOrigin);
});
test("save-only return redacts provider credentials, records completed work, and creates zero purchases", async () => {
  const before = wire.writes("/v2/checkout/orders").length, value = await saved();
  const setup = await walletStorage.readWalletSetup(value.actor.tenantId, value.setup.id), method = await walletStorage.readSavedWallet(value.actor.tenantId, setup.savedWalletId!);
  const serialized = JSON.stringify(value.current); for (const privateValue of [method.tokenId, method.customerId!, method.merchantCustomerId, method.payerHash!]) assert.equal(serialized.includes(privateValue), false);
  assert.equal(wire.writes("/v2/checkout/orders").length, before); assert.equal(value.current.show.financialEvidence.length, 0);
  const job = (await jobs.listJobs(value.actor.tenantId)).find(item => item.kind === "wallet_setup")!; assert.equal(job.status, "complete");
  const read = await route.GET(request(value.token)); assert.equal((await read.json()).commerce.wallet.status, "ready"); assert.equal(wire.writes("/v2/checkout/orders").length, before);
});
test("another production and a forged callback cannot read or convert the owned wallet", async () => {
  const value = await session(), foreign = await session();
  const started = await post(value.token, { type: "wallet_start", idempotencyKey: randomUUID(), expectedRevision: value.show.revision, saveOnly: true });
  const setupId = started.body.commerce.wallet.id, before = wire.writes("/v3/vault/payment-tokens").length;
  assert.equal((await post(foreign.token, { type: "wallet_check", setupId })).response.status, 404);
  assert.equal((await post(value.token, { type: "wallet_return", setupId, state: "a".repeat(43), cancel: false })).response.status, 403);
  assert.equal(wire.writes("/v3/vault/payment-tokens").length, before); assert.equal((await (await route.GET(request(foreign.token))).json()).commerce.wallet, null);
});
test("exact cohort review persists consent while its durable worker alone executes the bounded purchase", async () => {
  const value = await saved(), before = wire.writes("/v2/checkout/orders").length;
  const draft = await post(value.token, { type: "cohort_draft", mode: "saved_wallet", walletId: value.current.commerce.wallet.walletId, expectedRevision: value.current.show.revision });
  assert.equal(draft.response.status, 200); assert.equal(draft.body.commerce.cohort.lines.length, 80);
  const approve = { type: "cohort_approve", cohortId: draft.body.commerce.cohort.id, digest: draft.body.commerce.cohort.digest, expectedRevision: draft.body.show.revision, maximumMinor: 337000, maximumTickets: 80, oneControlledBuyer: true, separatePurchases: true };
  for (const changed of [{ maximumMinor: 337001 }, { maximumTickets: 81 }, { oneControlledBuyer: false }, { separatePurchases: false }]) assert.equal((await post(value.token, { ...approve, ...changed })).response.status, 400);
  assert.equal((await post(value.token, { ...approve, digest: "f".repeat(64) })).response.status, 409);
  const approved = await post(value.token, approve); assert.equal(approved.response.status, 200); assert.equal(approved.body.commerce.cohort.state, "approved");
  assert.equal(wire.writes("/v2/checkout/orders").length, before);
  assert.equal((await post(value.token, { type: "ticket_check", cohortId: approve.cohortId, ticketId: approved.body.commerce.cohort.lines[0].id })).response.status, 409);
  const tick = await runner.runJobTick({ tenantId: value.actor.tenantId, limit: 1, budgetMs: 10000 });
  assert.equal(tick.processed, 1); assert.equal(tick.results[0]!.status, "complete"); assert.equal(wire.writes("/v2/checkout/orders").length, before + 1);
  const read = await (await route.GET(request(value.token))).json(); assert.equal(read.commerce.cohort.capturedCount, 1); assert.equal(read.commerce.cohort.capturedMinor, 3500);
  const stopped = await post(value.token, { type: "cohort_stop", cohortId: approve.cohortId }); assert.equal(stopped.body.commerce.cohort.state, "revoked");
  await runner.runJobTick({ tenantId: value.actor.tenantId, limit: 1, budgetMs: 10000 }); assert.equal(wire.writes("/v2/checkout/orders").length, before + 1);
});
test("a manual wallet check does not overwrite an active durable worker lease", async () => {
  const value = await session(), started = await post(value.token, { type: "wallet_start", idempotencyKey: randomUUID(), expectedRevision: value.show.revision, saveOnly: true }), setupId = started.body.commerce.wallet.id;
  await database.pool.query("UPDATE on_jobs SET run_after=now() WHERE tenant_id=$1 AND kind='wallet_setup'", [value.actor.tenantId]);
  const claimed = await jobs.claimJob(value.actor.tenantId); assert.ok(claimed);
  assert.equal((await post(value.token, { type: "wallet_check", setupId })).response.status, 202);
  const current = (await jobs.listJobs(value.actor.tenantId))[0]!; assert.equal(current.status, "running"); assert.equal(current.leaseId, claimed.leaseId);
});
test("historical gross survives an adverse current read and a manual check restores only corroborated readiness", async () => {
  const value = await saved();
  const draft = await post(value.token, { type: "cohort_draft", mode: "saved_wallet", walletId: value.current.commerce.wallet.walletId, expectedRevision: value.current.show.revision });
  await post(value.token, { type: "cohort_approve", cohortId: draft.body.commerce.cohort.id, digest: draft.body.commerce.cohort.digest, expectedRevision: draft.body.show.revision, maximumMinor: 337000, maximumTickets: 80, oneControlledBuyer: true, separatePurchases: true });
  const tick = await runner.runJobTick({ tenantId: value.actor.tenantId, limit: 1, budgetMs: 10000 }); assert.equal(tick.results[0]!.status, "complete");
  const recorded = await (await route.GET(request(value.token))).json();
  const completed = recorded.commerce.cohort.lines.find((item: { state: string }) => item.state === "captured"); assert.ok(completed);
  const line = await locks.readCohortTicket(value.actor.tenantId, completed.id), root = await payments.readIntent(value.actor.tenantId, line.rootIntentId!);
  const resources = await payments.ownedResources(value.actor.tenantId, "venue", root.id), order = resources.find(item => item.kind === "order")!, capture = resources.find(item => item.kind === "capture")!;
  const { observeOwnedPayment } = await import("../src/server/payment-observations");
  wire.orders.get(order.id)!.purchase_units[0].payments.captures[0].status = "DENIED";
  // This is a controlled read fixture in an isolated schema, never a signed-event qualification.
  await observeOwnedPayment(root, wire.provider(), AbortSignal.timeout(5000));
  const adverse = await (await route.GET(request(value.token))).json();
  assert.equal(adverse.commerce.cohort.capturedMinor, 3500); assert.equal(adverse.commerce.cohort.capturedCount, 1);
  assert.equal(adverse.commerce.cohort.currentVerifiedCount, 0); assert.equal(adverse.commerce.cohort.captureReviewCount, 1); assert.equal(adverse.commerce.cohort.lines.find((item: { id: string }) => item.id === line.id).captureReference, "••••" + capture.id.slice(-6));
  const before = wire.calls.filter(call => call.method === "POST").length;
  const denied = await post(value.token, { type: "ticket_check", cohortId: draft.body.commerce.cohort.id, ticketId: line.id });
  assert.equal(denied.body.work.code, "CAPTURE_STATE_REVIEW_REQUIRED"); assert.equal(denied.body.commerce.cohort.capturedMinor, 3500);
  wire.orders.get(order.id)!.purchase_units[0].payments.captures[0].status = "COMPLETED";
  const restored = await post(value.token, { type: "ticket_check", cohortId: draft.body.commerce.cohort.id, ticketId: line.id });
  assert.equal(restored.body.commerce.cohort.currentVerifiedCount, 1); assert.equal(restored.body.commerce.cohort.captureReviewCount, 0);
  assert.equal(wire.calls.filter(call => call.method === "POST").length, before);
});
