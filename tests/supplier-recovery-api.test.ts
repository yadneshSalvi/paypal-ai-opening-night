/** Real routes and durable services. Supplier transport and installed SDK wire remain controlled. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { supplierRecoveryHarness } from "./supplier-recovery-harness";
const h = await supplierRecoveryHarness({ realEngine: true }); after(h.close);
const get = await import("../src/app/api/supplier-recovery/route"), command = await import("../src/app/api/supplier-recovery/commands/route"), receipt = await import("../src/app/api/supplier-recovery/commands/[id]/route"), work = await import("../src/app/api/supplier-recovery/work/route"), showRoute = await import("../src/app/api/show/route"), hold = await import("../src/app/api/suppliers/[supplier]/holds/route");
const origin = "http://127.0.0.1:4586";
function request(path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(origin + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: token ? "Bearer " + token : "Basic no-authority", ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const recover = (token: string, id: string) => receipt.GET(request("/api/supplier-recovery/commands/" + id, token), { params: Promise.resolve({ id }) });
async function ready() {
  const value = await h.initial(), supplier = await h.openSupplier(value.authority, "northside"); await h.publish(supplier.authority);
  const requested = await h.requestQuotes(value.authority); assert.equal((await h.rfq.collectSupplierRfq(value.actor.tenantId, requested.receipt.recordId, h.signal(), h.transport)).status, "complete");
  return { ...value, supplier };
}
async function approved() {
  const value = await ready(), plan = await h.realPlan(value.actor);
  const envelope = { idempotencyKey: randomUUID(), expectedRevision: plan.show.revision, command: { type: "approve", candidateId: plan.candidate.id, candidateDigest: plan.candidate.digest, approvals: plan.candidate.approvals.map(item => item.id) } };
  const response = await showRoute.POST(request("/api/show", value.token, envelope)); assert.equal(response.status, 200, await response.clone().text());
  const show = await h.store.getShow(value.actor.tenantId), offer = show.offers.find(item => item.supplierId === "northside")!;
  return { ...value, plan, show, envelope, hold: { idempotencyKey: randomUUID(), expectedRevision: show.revision, quoteId: offer.serviceQuote!.id, planDigest: show.approvedPlan!.digest, acceptCaptureTerms: true } };
}
async function withTransport<T>(transport: typeof h.transport, callback: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => { const outgoing = input instanceof Request ? input : new Request(input, init), url = new URL(outgoing.url); if (url.origin !== origin || !/^\/api\/enrolled-suppliers\/(brightline|northside|sister)\/rpc$/.test(url.pathname)) throw new Error("Unexpected egress from controlled supplier route"); return transport(outgoing); };
  try { return await callback(); } finally { globalThis.fetch = original; }
}

test("anonymous, cross-origin, oversized and unknown instructions fail without storing a command", async () => {
  const anonymous = await get.GET(request("/api/supplier-recovery")); assert.equal(anonymous.status, 401); assert.match(anonymous.headers.get("cache-control")!, /no-store/);
  const value = await h.initial(), supplier = await h.openSupplier(value.authority, "northside"), prepared = await h.terms(supplier.authority), path = "/api/supplier-recovery/commands";
  assert.equal((await command.POST(request(path, supplier.token, prepared.envelope, { Origin: "http://localhost:4586" }))).status, 403);
  const unknown = await command.POST(request(path, supplier.token, { ...prepared.envelope, fakeSecret: "untrusted-secret-not-to-echo" })); assert.equal(unknown.status, 400); assert.doesNotMatch(await unknown.text(), /untrusted-secret-not-to-echo/);
  assert.equal((await command.POST(request(path, supplier.token, { ...prepared.envelope, padding: "x".repeat(31000) }))).status, 413);
  assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_supplier_terms WHERE tenant_id=$1", [value.actor.tenantId])).rows[0].count), 0);
});

test("HTTP publication and receipt recovery keep owned source boundaries and immutable original content", async () => {
  const value = await h.initial(), supplier = await h.openSupplier(value.authority, "northside"), prepared = await h.terms(supplier.authority);
  const first = await command.POST(request("/api/supplier-recovery/commands", supplier.token, prepared.envelope)); assert.equal(first.status, 200); assert.match(first.headers.get("cache-control")!, /no-store/);
  const saved = await first.json(); assert.deepEqual(saved.workspace.cards.map((card: { supplierId: string }) => card.supplierId), ["northside"]); assert.equal(saved.workspace.preview, null); assert.deepEqual(saved.workspace.requests, []);
  assert.doesNotMatch(JSON.stringify(saved), /sessionHash|document_cipher|receipt_cipher|PayPal-Request-Id|authorizationId/);
  assert.deepEqual((await (await recover(supplier.token, prepared.envelope.commandId)).json()).receipt, saved.receipt);
  assert.equal((await (await command.POST(request("/api/supplier-recovery/commands", supplier.token, prepared.envelope))).json()).replayed, true);
  const token = randomBytes(32).toString("base64url"); await h.database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [h.sessionTokenHash(token), value.actor.tenantId, supplier.actor]);
  assert.equal((await recover(token, prepared.envelope.commandId)).status, 404); assert.equal((await recover(supplier.token, randomUUID())).status, 404);
  assert.equal((await get.GET(request("/api/supplier-recovery", supplier.token, undefined, { "x-opening-night-production": randomUUID() }))).status, 409);
  await h.database.pool.query("UPDATE on_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [supplier.authority.sessionHash]); assert.equal((await recover(supplier.token, prepared.envelope.commandId)).status, 401);
});

test("HTTP original quote collection can continue only under its exact reviewing producer", async () => {
  const value = await h.initial(), supplier = await h.openSupplier(value.authority, "northside"); await h.publish(supplier.authority);
  const requested = await h.requestQuotes(value.authority), path = "/api/supplier-recovery/work", body = { rfqId: requested.receipt.recordId };
  assert.equal((await work.POST(request(path, supplier.token, body))).status, 403); assert.equal((await work.POST(request(path, value.token, { ...body, all: true }))).status, 400);
  const token = randomBytes(32).toString("base64url"); await h.database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [h.sessionTokenHash(token), value.actor.tenantId, value.actor]);
  assert.equal((await work.POST(request(path, token, body))).status, 403);
  await withTransport(h.transport, async () => { const done = await work.POST(request(path, value.token, body)); assert.equal(done.status, 200); const result = await done.json(); assert.equal(result.work.status, "complete"); assert.equal(result.workspace.requests[0].outcomes.length, 3); });
  assert.equal((await h.store.getShow(value.actor.tenantId)).approvedPlan, null);
});

test("HTTP generation rechecks the fixed original capability after actual engine work and a database wait", async () => {
  const value = await ready(), before = await h.store.getShow(value.actor.tenantId), lock = await h.database.pool.connect(); let running: Promise<Response> | undefined;
  try {
    await lock.query("BEGIN"); await lock.query("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR UPDATE", [value.actor.tenantId]);
    running = showRoute.POST(request("/api/show", value.token, { idempotencyKey: randomUUID(), expectedRevision: before.revision, command: { type: "generate" } }));
    let waiting = false;
    for (let i = 0; i < 200; i++) { waiting = Boolean((await h.database.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND state='active' AND query LIKE 'SELECT snapshot FROM on_shows WHERE tenant_id=%FOR UPDATE'")).rowCount); if (waiting) break; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal(waiting, true, "The real engine must finish before the guarded transaction waits");
    await h.database.pool.query("UPDATE on_sessions SET expires_at=expires_at+interval '1 microsecond' WHERE token_hash=$1", [value.authority.sessionHash]); await lock.query("COMMIT");
    const response = await running; assert.equal(response.status, 401); assert.equal((await response.json()).code, "SUPPLIER_RECOVERY_SESSION_ENDED");
    assert.equal((await h.store.getShow(value.actor.tenantId)).runs.length, before.runs.length);
  } finally { await lock.query("ROLLBACK"); lock.release(); if (running) await running; }
});

test("a replacement hold needs exact producer access at dispatch even when another same-actor session exists", async () => {
  const value = await approved(), alternate = randomBytes(32).toString("base64url");
  await h.database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [h.sessionTokenHash(alternate), value.actor.tenantId, value.actor]);
  await withTransport(async outgoing => { await h.database.pool.query("UPDATE on_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [value.authority.sessionHash]); return h.transport(outgoing); }, async () => {
    const response = await hold.POST(request("/api/suppliers/northside/holds", value.token, value.hold), { params: Promise.resolve({ supplier: "northside" }) }); assert.equal(response.status, 401);
  });
  assert.equal((await h.store.getShow(value.actor.tenantId)).rentalExecutions!.length, 0);
  await assert.rejects(() => h.protocol.callSupplierService("northside", { version: 1, requestId: randomUUID(), tenantId: value.actor.tenantId, actorId: value.actor.id, action: { type: "hold", quoteId: value.hold.quoteId, planDigest: value.hold.planDigest, expectedRevision: value.hold.expectedRevision, acceptCaptureTerms: true } }, h.signal(), h.transport), { code: "SUPPLIER_HOLD_ACCESS_REQUIRED" });
});

test("a lost replacement-hold response recovers only the same session and original request, with no duplicate execution", async () => {
  const value = await approved(); let first = true;
  await withTransport(async outgoing => { const response = await h.transport(outgoing); if (first) { first = false; throw new TypeError("Controlled loss after exact hold commit"); } return response; }, async () => {
    const path = "/api/suppliers/northside/holds", context = { params: Promise.resolve({ supplier: "northside" }) };
    assert.ok((await hold.POST(request(path, value.token, value.hold), context)).status >= 500);
    const original = (await h.store.getShow(value.actor.tenantId)).rentalExecutions![0]!; assert.equal(original.state, "held");
    const alternate = randomBytes(32).toString("base64url"); await h.database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [h.sessionTokenHash(alternate), value.actor.tenantId, value.actor]);
    const wrong = await hold.POST(request(path, alternate, value.hold), context); assert.equal(wrong.status, 409); assert.equal((await wrong.json()).code, "SUPPLIER_REQUEST_CONFLICT");
    const recovered = await hold.POST(request(path, value.token, value.hold), context); assert.equal(recovered.status, 200); const result = await recovered.json(); assert.equal(result.reservation.execution.id, original.id); assert.doesNotMatch(JSON.stringify(result), /producerAccess|sessionHash/);
    assert.equal((await h.store.getShow(value.actor.tenantId)).rentalExecutions!.length, 1); assert.equal(original.authorizationId, null);
  });
});

test("current source changes prevent HTTP approval while an already-committed original approval remains replayable", async () => {
  const value = await approved(); await h.publish(value.supplier.authority, { feeMinor: 35000 });
  const replay = await showRoute.POST(request("/api/show", value.token, value.envelope)); assert.equal(replay.status, 200); assert.equal((await replay.json()).replayed, true);
  const other = await ready(), plan = await h.realPlan(other.actor); await h.database.pool.query("UPDATE on_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [other.supplier.authority.sessionHash]);
  const response = await showRoute.POST(request("/api/show", other.token, { idempotencyKey: randomUUID(), expectedRevision: plan.show.revision, command: { type: "approve", candidateId: plan.candidate.id, candidateDigest: plan.candidate.digest, approvals: plan.candidate.approvals.map(item => item.id) } }));
  assert.equal(response.status, 409); assert.equal((await response.json()).code, "SUPPLIER_TERMS_CHANGED"); assert.equal((await h.store.getShow(other.actor.tenantId)).approvedPlan, null);
});
