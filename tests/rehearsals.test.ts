/** Disposable PostgreSQL fixtures. No provider calls, real receipts or browser qualification are implied. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedDatabase } from "./isolated-database";
import { PRODUCTION_SCOPE_HEADER } from "../src/domain/rehearsal-contracts";

const database = await isolatedDatabase();
const store = await import("../src/server/store"), service = await import("../src/server/rehearsal-service");
const http = await import("../src/server/http"), route = await import("../src/app/api/rehearsals/route");
const { enqueueJob } = await import("../src/server/jobs");
after(() => database.close());
const code = (wanted: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === wanted;
async function fixture() { const scope = "test:rehearsal:" + randomUUID(); return { ...await store.createSession(undefined, scope), scope }; }
const create = (value: Awaited<ReturnType<typeof fixture>>, label = "Next independent rehearsal", idempotencyKey = randomUUID()) => service.changeRehearsal(value.actor, { type: "create", expectedTenantId: value.actor.tenantId, idempotencyKey, label }, value.scope);
async function raw(tenantId: string) { return (await database.pool.query<{ snapshot: string }>("SELECT snapshot::text FROM on_shows WHERE tenant_id=$1", [tenantId])).rows[0]!.snapshot; }
async function membership(tenantId: string) { return (await database.pool.query("SELECT * FROM on_rehearsal_members WHERE tenant_id=$1", [tenantId])).rows[0]; }
async function requestCount(workspaceId: string) { return Number((await database.pool.query("SELECT count(*) FROM on_rehearsal_requests WHERE workspace_id=$1", [workspaceId])).rows[0].count); }
function request(token: string, body?: unknown, origin = "http://localhost:4105", path = "/api/rehearsals") {
  return new Request("http://localhost:4105" + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + token, origin, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test("a legacy producer lists its current rehearsal without adopting, mutating or extending it", async () => {
  const value = await fixture(), before = await raw(value.actor.tenantId);
  const sessions = await database.pool.query("SELECT token_hash,expires_at FROM on_sessions WHERE tenant_id=$1 ORDER BY token_hash", [value.actor.tenantId]);
  const overview = await service.listRehearsals(value.actor);
  assert.equal(overview.total, 1); assert.equal(overview.items[0]!.current, true); assert.equal(overview.items[0]!.label, "Alder Hall rehearsal");
  assert.equal(await membership(value.actor.tenantId), undefined); assert.equal(await raw(value.actor.tenantId), before);
  assert.deepEqual((await database.pool.query("SELECT token_hash,expires_at FROM on_sessions WHERE tenant_id=$1 ORDER BY token_hash", [value.actor.tenantId])).rows, sessions.rows);
});
test("a separate rehearsal gets fresh authority while the original snapshot and active identity remain intact", async () => {
  const value = await fixture(), before = await raw(value.actor.tenantId), created = await create(value);
  assert.notEqual(created.tenantId, value.actor.tenantId); assert.notEqual(created.actor.id, value.actor.id); assert.ok(created.token);
  const current = await store.getActor(created.token); assert.deepEqual(current, created.actor);
  const show = await store.getShow(created.tenantId);
  assert.equal(show.revision, 1); assert.equal(show.approvedPlan, null); assert.deepEqual(show.financialEvidence, []); assert.deepEqual(show.acknowledgments, []); assert.deepEqual(show.tickets, []);
  assert.equal(await raw(value.actor.tenantId), before); assert.deepEqual(await store.getActor(value.token), value.actor);
  const overview = await service.listRehearsals(created.actor); assert.equal(overview.total, 2);
  assert.deepEqual(new Set(overview.items.map(item => item.tenantId)), new Set([value.actor.tenantId, created.tenantId]));
  for (const table of ["on_wallet_setups", "on_ticket_cohorts", "on_remedy_batches", "on_jobs"]) assert.equal(Number((await database.pool.query("SELECT count(*) FROM " + table + " WHERE tenant_id=$1", [created.tenantId])).rows[0].count), 0);
});
test("concurrent creates and a lost-response retry retain one tenant, cookie and admission", async () => {
  const value = await fixture(), id = randomUUID();
  const results = await Promise.all([create(value, "One original request", id), create(value, "One original request", id), create(value, "One original request", id)]);
  assert.equal(new Set(results.map(result => result.tenantId)).size, 1); assert.equal(new Set(results.map(result => result.token)).size, 1);
  const replayed = await create(value, "One original request", id); assert.equal(replayed.replayed, true); assert.equal(replayed.token, results[0]!.token);
  const member = await membership(value.actor.tenantId); assert.equal(await requestCount(member.workspace_id), 1);
  assert.equal(Number((await database.pool.query("SELECT count(*) FROM on_session_admissions WHERE scope=$1", [value.scope])).rows[0].count), 2);
  assert.equal(Number((await database.pool.query("SELECT count(*) FROM on_sessions WHERE tenant_id=$1", [replayed.tenantId])).rows[0].count), 1);
});
test("switching back preserves the exact producer, authority expiry, receipts and pending work", async () => {
  const value = await fixture();
  await database.pool.query("UPDATE on_shows SET snapshot=jsonb_set(snapshot,'{financialEvidence}',$2::jsonb) WHERE tenant_id=$1", [value.actor.tenantId, JSON.stringify([{ id: "controlled-history-only", source: "live_sandbox", verified: true }])]);
  await enqueueJob(database.pool, { tenantId: value.actor.tenantId, kind: "payment_reconcile", semanticKey: randomUUID(), payload: { intentId: randomUUID() } });
  const before = await raw(value.actor.tenantId), created = await create(value), original = await membership(value.actor.tenantId);
  const back = await service.changeRehearsal(created.actor, { type: "switch", idempotencyKey: randomUUID(), expectedTenantId: created.tenantId, targetTenantId: value.actor.tenantId });
  assert.deepEqual(back.actor, value.actor); assert.deepEqual(await store.getActor(back.token!), value.actor); assert.equal(back.expiresAt, original.authority_expires_at.toISOString());
  assert.equal(await raw(value.actor.tenantId), before); assert.equal((await membership(value.actor.tenantId)).actor_id, value.actor.id);
  const row = (await service.listRehearsals(back.actor)).items.find(item => item.current)!;
  assert.equal(row.hasFinancialHistory, true); assert.equal(row.pendingWork, 1); assert.equal(row.reviewWork, 0);
  const session = (await database.pool.query("SELECT expires_at FROM on_sessions WHERE tenant_id=$1 ORDER BY expires_at DESC LIMIT 1", [value.actor.tenantId])).rows[0];
  assert.equal(session.expires_at.toISOString(), original.authority_expires_at.toISOString());
});
test("renaming modifies only workspace metadata and its idempotent request record", async () => {
  const value = await fixture(), before = await raw(value.actor.tenantId), id = randomUUID();
  const input = { type: "rename" as const, idempotencyKey: id, expectedTenantId: value.actor.tenantId, label: "Original paid rehearsal" };
  const first = await service.changeRehearsal(value.actor, input); assert.equal(first.token, null);
  assert.equal((await service.changeRehearsal(value.actor, input)).replayed, true);
  assert.equal((await service.listRehearsals(value.actor)).items[0]!.label, input.label); assert.equal(await raw(value.actor.tenantId), before);
  assert.equal(Number((await database.pool.query("SELECT count(*) FROM on_session_admissions WHERE scope=$1", [value.scope])).rows[0].count), 1);
});
test("a request identity cannot be reused for a different name or operation", async () => {
  const value = await fixture(), id = randomUUID(), created = await create(value, "First exact label", id);
  await assert.rejects(create(value, "Different label", id), code("REHEARSAL_REQUEST_CHANGED"));
  await assert.rejects(service.changeRehearsal(value.actor, { type: "switch", idempotencyKey: id, expectedTenantId: value.actor.tenantId, targetTenantId: created.tenantId }), code("REHEARSAL_REQUEST_CHANGED"));
  assert.equal((await service.listRehearsals(value.actor)).total, 2);
});
test("unrelated producers and crew cannot discover or select another saved workspace", async () => {
  const value = await fixture(), created = await create(value), foreign = await fixture();
  assert.equal((await service.listRehearsals(foreign.actor)).total, 1);
  await assert.rejects(service.changeRehearsal(foreign.actor, { type: "switch", expectedTenantId: foreign.actor.tenantId, targetTenantId: created.tenantId, idempotencyKey: randomUUID() }), code("REHEARSAL_NOT_OWNED"));
  assert.equal(await membership(foreign.actor.tenantId), undefined);
  const crew = await store.getActor(await store.createCrewCapability(value.actor, "priya")); assert.ok(crew);
  await assert.rejects(service.listRehearsals(crew), code("PRODUCER_REQUIRED"));
  await assert.rejects(service.changeRehearsal(crew, { type: "create", label: "Cannot elevate crew", expectedTenantId: crew.tenantId, idempotencyKey: randomUUID() }), code("PRODUCER_REQUIRED"));
});
test("expired target access remains visible but cannot mint a renewed producer capability", async () => {
  const value = await fixture(), created = await create(value);
  await database.pool.query("UPDATE on_rehearsal_members SET authority_expires_at=now()-interval '1 second' WHERE tenant_id=$1", [value.actor.tenantId]);
  const before = Number((await database.pool.query("SELECT count(*) FROM on_sessions WHERE tenant_id=$1", [value.actor.tenantId])).rows[0].count);
  assert.equal((await service.listRehearsals(created.actor)).items.find(item => item.tenantId === value.actor.tenantId)!.accessExpired, true);
  await assert.rejects(service.changeRehearsal(created.actor, { type: "switch", idempotencyKey: randomUUID(), expectedTenantId: created.tenantId, targetTenantId: value.actor.tenantId }), code("REHEARSAL_ACCESS_EXPIRED"));
  assert.equal(Number((await database.pool.query("SELECT count(*) FROM on_sessions WHERE tenant_id=$1", [value.actor.tenantId])).rows[0].count), before);
});
test("revoked target producer sessions cannot be resurrected by a workspace membership", async () => {
  const value = await fixture(), created = await create(value);
  await database.pool.query("UPDATE on_sessions SET expires_at=now()-interval '1 second' WHERE tenant_id=$1", [value.actor.tenantId]);
  assert.equal((await service.listRehearsals(created.actor)).items.find(item => item.tenantId === value.actor.tenantId)!.accessExpired, true);
  await assert.rejects(service.changeRehearsal(created.actor, { type: "switch", idempotencyKey: randomUUID(), expectedTenantId: created.tenantId, targetTenantId: value.actor.tenantId }), code("REHEARSAL_ACCESS_EXPIRED"));
});
test("changed member documents cannot substitute a producer from a foreign tenant", async () => {
  const value = await fixture(), created = await create(value), foreign = await fixture();
  await database.pool.query("UPDATE on_rehearsal_members SET actor=$2,actor_id=$3 WHERE tenant_id=$1", [created.tenantId, foreign.actor, foreign.actor.id]);
  await assert.rejects(service.changeRehearsal(value.actor, { type: "switch", idempotencyKey: randomUUID(), expectedTenantId: value.actor.tenantId, targetTenantId: created.tenantId }), code("REHEARSAL_MEMBERSHIP_CHANGED"));
});
test("creation quota failure rolls back adoption and preserves an existing rehearsal", async () => {
  const value = await fixture(), before = await raw(value.actor.tenantId);
  await database.pool.query("INSERT INTO on_session_admissions(id,scope,created_at) SELECT gen_random_uuid(),$1,now() FROM generate_series(1,29)", [value.scope]);
  await assert.rejects(create(value), code("SESSION_CREATION_LIMIT"));
  assert.equal(await membership(value.actor.tenantId), undefined); assert.equal(await raw(value.actor.tenantId), before);
  assert.equal((await store.createSession(value.token, value.scope)).reused, true);
});
test("switching existing rehearsals does not consume or require creation capacity", async () => {
  const value = await fixture(), created = await create(value);
  await database.pool.query("INSERT INTO on_session_admissions(id,scope,created_at) SELECT gen_random_uuid(),$1,now() FROM generate_series(1,28)", [value.scope]);
  await assert.rejects(create(value), code("SESSION_CREATION_LIMIT"));
  const back = await service.changeRehearsal(created.actor, { type: "switch", expectedTenantId: created.tenantId, targetTenantId: value.actor.tenantId, idempotencyKey: randomUUID() }, value.scope);
  assert.equal(back.tenantId, value.actor.tenantId); assert.equal((await service.listRehearsals(back.actor)).total, 2);
});
test("bounded pages retain every owned rehearsal without returning private capabilities", async () => {
  const value = await fixture(); for (let index = 0; index < 26; index++) await create(value, "Rehearsal " + index);
  const first = await service.listRehearsals(value.actor), second = await service.listRehearsals(value.actor, first.nextOffset!);
  assert.equal(first.items.length, 25); assert.equal(second.items.length, 2); assert.equal(first.total, 27); assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.tenantId)).size, 27);
  const serialized = JSON.stringify(first); assert.equal(serialized.includes(value.token), false); assert.equal(serialized.includes(value.actor.id), false); assert.equal(serialized.includes('"actor"'), false); assert.equal(serialized.includes('"workspace_id"'), false);
});
test("a stale displayed production cannot create, rename or select a different rehearsal", async () => {
  const value = await fixture(), foreign = await fixture();
  await assert.rejects(service.changeRehearsal(value.actor, { type: "create", idempotencyKey: randomUUID(), expectedTenantId: foreign.actor.tenantId, label: "Wrong tab" }), code("PRODUCTION_CHANGED"));
  assert.equal(await membership(value.actor.tenantId), undefined);
  const cookieRequest = (method: string, scope?: string, bearer = false) => new Request("http://localhost:4105/api/show", { method, headers: { ...(scope ? { [PRODUCTION_SCOPE_HEADER]: scope } : {}), ...(bearer ? { authorization: "Bearer immutable-capability" } : {}) } });
  assert.doesNotThrow(() => http.assertProductionScope(value.actor, cookieRequest("POST", value.actor.tenantId)));
  assert.throws(() => http.assertProductionScope(value.actor, cookieRequest("POST")), code("PRODUCTION_SCOPE_REQUIRED"));
  assert.throws(() => http.assertProductionScope(value.actor, cookieRequest("POST", foreign.actor.tenantId)), code("PRODUCTION_CHANGED"));
  assert.throws(() => http.assertProductionScope(value.actor, cookieRequest("GET", foreign.actor.tenantId)), code("PRODUCTION_CHANGED"));
  assert.doesNotThrow(() => http.assertProductionScope(value.actor, cookieRequest("POST", undefined, true)));
});
test("route guards reject foreign origins, oversized bodies, injected identities and private workspace discovery", async () => {
  const value = await fixture(), body = { type: "create", idempotencyKey: randomUUID(), expectedTenantId: value.actor.tenantId, label: "Exact rehearsal" };
  assert.equal((await route.GET(request("not-a-session"))).status, 401);
  assert.equal((await route.POST(request(value.token, body, "http://127.0.0.1:4105"))).status, 403);
  assert.equal((await route.POST(request(value.token, { ...body, actorId: value.actor.id }))).status, 400);
  assert.equal((await route.POST(request(value.token, { ...body, label: "x".repeat(65) }))).status, 400);
  assert.equal((await route.POST(request(value.token, { ...body, label: "Line\nbreak" }))).status, 400);
  assert.equal((await route.POST(request(value.token, { ...body, padding: "x".repeat(2100) }))).status, 413);
  assert.equal((await route.GET(request(value.token, undefined, undefined, "/api/rehearsals?workspaceId=" + randomUUID()))).status, 400);
  const read = await route.GET(request(value.token)); assert.equal(read.status, 200); assert.equal(read.headers.get("cache-control"), "private, no-store");
  assert.equal(await membership(value.actor.tenantId), undefined);
  const renamed = await route.POST(request(value.token, { ...body, type: "rename", label: "Current original rehearsal" }));
  assert.equal(renamed.status, 200); assert.equal(renamed.headers.get("set-cookie"), null); assert.equal((await renamed.json()).rehearsals.items[0].label, "Current original rehearsal");
});
