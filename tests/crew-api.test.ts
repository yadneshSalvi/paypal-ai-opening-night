/** Real API admission and durable PostgreSQL commands, in a disposable local
 * schema. No PayPal/model transport or original tenant is used. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedDatabase } from "./isolated-database";
import { controlledCommercialInputs, crewPublished } from "./crew-fixtures";
import { crewCommandEnvelopeSchema, crewDataSchema, type CrewCommandEnvelope } from "../src/domain/crew/contracts";
import { digest } from "../src/domain/hash";
import { atVenue } from "../src/domain/time";

const database = await isolatedDatabase();
const store = await import("../src/server/store");
const service = await import("../src/server/crew/service");
const accessService = await import("../src/server/crew/access");
const route = await import("../src/app/api/crew/route");
const showRoute = await import("../src/app/api/show/route");
const accessRoute = await import("../src/app/api/crew/access/route");
const inviteRoute = await import("../src/app/api/crew/invite/route");
const { sessionTokenHash } = await import("../src/server/session-records");
const { currentAcknowledgments } = await import("../src/domain/readiness");
after(async () => { await database.close(); });
const origin = "http://localhost:4505";
function request(token: string | null, body?: unknown, options: { path?: string; cookie?: string; origin?: string; raw?: string; method?: string } = {}) {
  const headers = new Headers({ origin: options.origin ?? origin, "content-type": "application/json" });
  if (token !== null) headers.set("authorization", "Bearer " + token);
  if (options.cookie) headers.set("cookie", "opening-night-session=" + options.cookie);
  return new Request(origin + (options.path ?? "/api/crew"), { method: options.method ?? (body === undefined && options.raw === undefined ? "GET" : "POST"), headers, ...(body !== undefined || options.raw !== undefined ? { body: options.raw ?? JSON.stringify(body) } : {}) });
}
async function fresh(personId = "priya", published = true) {
  const session = await store.createSession(undefined, "crew-api:" + randomUUID());
  if (published) {
    const fixture = crewPublished().show;
    fixture.tenantId = session.actor.tenantId; fixture.id = session.show.id;
    await database.pool.query("UPDATE on_shows SET snapshot=$2,revision=$3 WHERE tenant_id=$1", [session.actor.tenantId, fixture, fixture.revision]);
  }
  const token = await store.createCrewCapability(session.actor, personId);
  const access = await service.requireCrewSession(request(token));
  const data = await service.readCrew(access);
  return { session, token, access, data };
}
function acknowledgment(value: Awaited<ReturnType<typeof fresh>>, idempotencyKey = randomUUID()): CrewCommandEnvelope {
  return { idempotencyKey, expectedRevision: value.data.show.revision, command: { type: "acknowledge", sheetVersion: value.data.sheet.version, sheetDigest: value.data.sheet.digest, seenTaskIds: value.data.sheet.changes.map(change => change.taskId), offline: false } };
}
async function post(token: string, body: unknown) { const response = await route.POST(request(token, body)); return { response, body: await response.json() }; }
const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === expected);

test("test store is in its disposable schema and new rehearsals start with empty personal evidence", async () => {
  assert.equal((await database.pool.query("SELECT current_schema() AS schema")).rows[0].schema, database.schema);
  const value = await fresh("priya", false);
  assert.equal(value.session.show.crewProtocol, 1); assert.equal(value.session.show.crewAttestations!.length, 0); assert.equal(value.session.show.crewCues!.length, 0);
  assert.equal(value.data.review, null); assert.equal(value.data.rest.nextCall!.id, "matinee-load-in");
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_jobs WHERE tenant_id=$1", [value.session.actor.tenantId])).rows[0].count, 0);
});
test("dedicated reads ignore producer cookies, require a personal bearer, and reject broad show access", async () => {
  const value = await fresh();
  const response = await route.GET(request(value.token, undefined, { cookie: value.session.token }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("vary"), "Authorization");
  const data = crewDataSchema.parse(await response.json()); assert.equal(data.person.id, "priya"); assert.equal("showId" in data.show, false); assert.equal("resources" in data.show, false);
  const denied = await route.GET(request(null, undefined, { cookie: value.session.token }));
  assert.equal(denied.status, 401); assert.equal(denied.headers.get("cache-control"), "private, no-store"); assert.equal(denied.headers.get("vary"), "Authorization");
  assert.equal((await route.GET(request(value.session.token, undefined, { cookie: value.token }))).status, 403);
  assert.equal((await route.GET(request("not-a-personal-token", undefined, { cookie: value.session.token }))).status, 401);
  assert.equal((await showRoute.GET(request(value.token, undefined, { path: "/api/show", cookie: value.session.token }))).status, 403);
  assert.equal((await showRoute.GET(request("invalid-bearer", undefined, { path: "/api/show", cookie: value.session.token }))).status, 401);
  assert.equal((await showRoute.POST(request(value.token, { idempotencyKey: randomUUID(), expectedRevision: value.data.show.revision, command: { type: "advance", time: "18:45" } }, { path: "/api/show", cookie: value.session.token }))).status, 403);
  const producer = await showRoute.GET(request(value.session.token, undefined, { path: "/api/show", cookie: value.token })); assert.equal(producer.status, 200);
  assert.equal((await producer.json()).currentActor.id, value.session.actor.id);
});
test("producer roles cannot impersonate crew readbacks, signoffs or cues through either endpoint", async () => {
  const value = await fresh(), envelope = acknowledgment(value);
  assert.equal((await post(value.session.token, envelope)).response.status, 403);
  const commands = [envelope.command, { type: "fact", kind: "focus_signed_off", detail: "Producer cannot certify another crew member." }, { type: "go", reportId: "a".repeat(64) }, { type: "house_open" }];
  for (const command of commands) {
    const response = await showRoute.POST(request(value.session.token, { ...envelope, idempotencyKey: randomUUID(), command }, { path: "/api/show" }));
    assert.equal(response.status, 403); assert.equal((await response.json()).code, "PERSON_CREW_CLIENT_REQUIRED");
  }
  const saved = await store.getShow(value.session.actor.tenantId); assert.equal(saved.acknowledgments.length, 0); assert.equal(saved.crewCues!.length, 0); assert.equal(saved.crewAttestations!.length, 0);
});
test("cross-origin, malformed, oversized and forged-body writes fail before durable mutation", async () => {
  const value = await fresh(), body = acknowledgment(value);
  assert.equal((await route.POST(request(value.token, body, { origin: "https://unrelated.invalid" }))).status, 403);
  assert.equal((await route.POST(request(value.token, undefined, { raw: "{broken" }))).status, 400);
  assert.equal((await route.POST(request(value.token, { ...body, oversized: "x".repeat(24000) }))).status, 413);
  for (const extra of [{ personId: "sam" }, { roles: ["stage_manager"] }, { tenantId: randomUUID() }, { actorId: "producer:any" }]) {
    assert.equal((await post(value.token, { ...body, ...extra })).response.status, 400);
    assert.equal((await post(value.token, { ...body, command: { ...body.command, ...extra } })).response.status, 400);
  }
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_commands WHERE tenant_id=$1", [value.session.actor.tenantId])).rows[0].count, 0);
  assert.equal((await store.getShow(value.session.actor.tenantId)).revision, body.expectedRevision);
});
test("a lost response replays the original envelope once and returns the same attributed readback", async () => {
  const value = await fresh(), body = acknowledgment(value);
  const first = await post(value.token, body); assert.equal(first.response.status, 200); assert.equal(first.body.replayed, false);
  const replay = await post(value.token, body); assert.equal(replay.response.status, 200); assert.equal(replay.body.replayed, true); assert.deepEqual(replay.body.receipt, first.body.receipt);
  assert.equal(replay.body.data.acknowledgments.length, 1); assert.equal(replay.body.data.acknowledgments[0].commandId, body.idempotencyKey); assert.equal(replay.body.data.acknowledgments[0].actorId, value.access.actor.id);
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_events WHERE tenant_id=$1 AND event->>'type'='crew.acknowledged'", [value.session.actor.tenantId])).rows[0].count, 1);
  const changed = await post(value.token, { ...body, expectedRevision: replay.body.data.show.revision }); assert.equal(changed.response.status, 409); assert.equal(changed.body.code, "IDEMPOTENCY_CONFLICT");
});
test("a definite stale rejection retains no command key and permits the same intent with a fresh revision", async () => {
  const value = await fresh(), body = acknowledgment(value);
  const producerUpdate = await showRoute.POST(request(value.session.token, { idempotencyKey: randomUUID(), expectedRevision: body.expectedRevision, command: { type: "advance", time: "17:15" } }, { path: "/api/show" })); assert.equal(producerUpdate.status, 200);
  const stale = await post(value.token, body); assert.equal(stale.response.status, 409); assert.equal(stale.body.code, "STALE_REVISION");
  assert.equal((await database.pool.query("SELECT command_id FROM on_commands WHERE tenant_id=$1 AND command_id=$2", [value.session.actor.tenantId, body.idempotencyKey])).rowCount, 0);
  const current = await service.readCrew(value.access), retry = await post(value.token, { ...body, expectedRevision: current.show.revision });
  assert.equal(retry.response.status, 200); assert.equal(retry.body.receipt.commandId, body.idempotencyKey); assert.equal(retry.body.data.acknowledgments.length, 1);
});
test("an exact replay after publication returns a historical receipt and the latest sheet", async () => {
  const value = await fresh(), body = acknowledgment(value); const first = await post(value.token, body); assert.equal(first.response.status, 200);
  const show = await store.getShow(value.session.actor.tenantId), previous = show.sheets.at(-1)!;
  show.sheets.push({ ...structuredClone(previous), id: randomUUID(), version: previous.version + 1, digest: digest({ previous: previous.digest, testPublication: randomUUID() }), publishedAt: new Date().toISOString() }); show.revision++;
  await database.pool.query("UPDATE on_shows SET snapshot=$2,revision=$3 WHERE tenant_id=$1", [show.tenantId, show, show.revision]);
  const replay = await post(value.token, body); assert.equal(replay.response.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.receipt.current, false); assert.equal(replay.body.data.sheet.version, previous.version + 1);
  assert.equal(replay.body.data.acknowledgments[0].receivedAt, first.body.data.acknowledgments[0].receivedAt); assert.equal(currentAcknowledgments(await store.getShow(show.tenantId)).length, 0);
});
test("eleven independent personal commands record eleven current people; reserve and duplicate sessions cannot inflate readiness", async () => {
  const value = await fresh("sam"), show = await store.getShow(value.session.actor.tenantId);
  const people = show.resources.filter(person => person.kind === "person" && person.critical && !person.reserve);
  for (const person of people) {
    const token = person.id === "sam" ? value.token : await store.createCrewCapability(value.session.actor, person.id);
    const access = await service.requireCrewSession(request(token)), data = await service.readCrew(access);
    const command = { idempotencyKey: randomUUID(), expectedRevision: data.show.revision, command: { type: "acknowledge", sheetVersion: data.sheet.version, sheetDigest: data.sheet.digest, seenTaskIds: data.sheet.changes.map(change => change.taskId), offline: false } };
    assert.equal((await post(token, command)).response.status, 200);
  }
  const reserve = show.resources.find(person => person.reserve)!, reserveToken = await store.createCrewCapability(value.session.actor, reserve.id);
  const reserveAccess = await service.requireCrewSession(request(reserveToken)), reserveData = await service.readCrew(reserveAccess);
  assert.deepEqual(reserveData.duties, []); assert.deepEqual(reserveData.cues, []);
  assert.equal((await post(reserveToken, { idempotencyKey: randomUUID(), expectedRevision: reserveData.show.revision, command: { type: "acknowledge", sheetVersion: reserveData.sheet.version, sheetDigest: reserveData.sheet.digest, seenTaskIds: [], offline: false } })).response.status, 200);
  assert.equal(currentAcknowledgments(await store.getShow(show.tenantId)).length, 11);
  const anotherSam = await store.createCrewCapability(value.session.actor, "sam"), latest = await service.readCrew(await service.requireCrewSession(request(anotherSam)));
  const duplicate = await post(anotherSam, { ...acknowledgment(value), expectedRevision: latest.show.revision }); assert.equal(duplicate.response.status, 409); assert.equal(duplicate.body.code, "ALREADY_ACKNOWLEDGED");
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_jobs WHERE tenant_id=$1", [show.tenantId])).rows[0].count, 0);
});
test("a capability cannot create invitations, inspect producer access management, or create another person's signed duty", async () => {
  const value = await fresh("tom");
  assert.equal((await inviteRoute.POST(request(value.token, { personId: "sam" }, { path: "/api/crew/invite" }))).status, 403);
  assert.equal((await accessRoute.GET(request(value.token, undefined, { path: "/api/crew/access" }))).status, 403);
  const ack = await post(value.token, acknowledgment(value)); assert.equal(ack.response.status, 200);
  const blocked = await post(value.token, { idempotencyKey: randomUUID(), expectedRevision: ack.body.data.show.revision, command: { type: "attest", kind: "cue_signed_off", review: ack.body.data.review, detail: "Tom cannot become the qualified lighting programmer.", confirmed: true } });
  assert.equal(blocked.response.status, 403); assert.equal(blocked.body.code, "CREW_DUTY_FORBIDDEN");
});
test("expiry or revocation between session lookup and the locked command prevents reads, writes and exact replays", async () => {
  const value = await fresh(), body = acknowledgment(value); await post(value.token, body);
  const locked = await database.pool.connect(); await locked.query("BEGIN"); await locked.query("SELECT tenant_id FROM on_shows WHERE tenant_id=$1 FOR UPDATE", [value.session.actor.tenantId]);
  const pending = service.executeCrew(value.access, body);
  await database.pool.query("UPDATE on_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [sessionTokenHash(value.token)]);
  await locked.query("COMMIT"); locked.release();
  await assert.rejects(pending, code("CREW_ACCESS_EXPIRED"));
  await assert.rejects(service.readCrew(value.access), code("CREW_ACCESS_EXPIRED"));
  assert.equal((await route.GET(request(value.token))).status, 401); assert.equal((await post(value.token, body)).response.status, 401);
  assert.equal((await store.getShow(value.session.actor.tenantId)).acknowledgments.length, 1);
});
test("a signed live action survives an uncertain response as one exact durable record with current attribution", async () => {
  const value = await fresh(), show = controlledCommercialInputs(await store.getShow(value.session.actor.tenantId));
  show.clock = atVenue("18:45");
  await database.pool.query("UPDATE on_shows SET snapshot=$2 WHERE tenant_id=$1", [show.tenantId, show]);
  value.data = await service.readCrew(value.access);
  const ack = await post(value.token, acknowledgment(value)); assert.equal(ack.response.status, 200);
  const body = { idempotencyKey: randomUUID(), expectedRevision: ack.body.data.show.revision, command: { type: "attest", kind: "focus_signed_off", review: ack.body.data.review, detail: "Controlled API test of the assigned focus inspection.", confirmed: true } };
  const first = await post(value.token, body); assert.equal(first.response.status, 200); assert.equal(first.body.receipt.type, "attestation"); assert.equal(first.body.receipt.current, true);
  const replay = await post(value.token, body); assert.equal(replay.response.status, 200); assert.equal(replay.body.replayed, true); assert.deepEqual(replay.body.receipt, first.body.receipt);
  assert.equal(replay.body.data.history.length, 1); assert.equal(replay.body.data.history[0].personId, "priya"); assert.equal(replay.body.data.history[0].actorId, value.access.actor.id); assert.match(replay.body.data.history[0].signatureFingerprint, /^[a-f0-9]{64}$/);
  const conflict = await post(value.token, { ...body, command: { ...body.command, detail: "Changed instructions must never reuse a live action identity." } });
  assert.equal(conflict.response.status, 409); assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");
  const saved = await store.getShow(show.tenantId); assert.equal(saved.crewAttestations!.length, 1); assert.equal(saved.crewAttestations![0]!.commandId, body.idempotencyKey);
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_events WHERE tenant_id=$1 AND event->>'type'='crew.focus_signed_off'", [show.tenantId])).rows[0].count, 1);
  await accessService.revokeCrewAccess(value.session.actor, "priya", randomUUID(), saved.revision);
  assert.equal((await post(value.token, body)).response.status, 401);
  assert.deepEqual((await store.getShow(show.tenantId)).crewAttestations, saved.crewAttestations);
});
test("revoking current links is a reviewed idempotent transaction and a replay cannot revoke a later new invitation", async () => {
  const value = await fresh(), ack = await post(value.token, acknowledgment(value));
  const before = (await store.getShow(value.session.actor.tenantId)).acknowledgments;
  const body = { personId: "priya", expectedRevision: ack.body.data.show.revision, idempotencyKey: randomUUID(), confirmed: true };
  const first = await accessRoute.POST(request(value.session.token, body, { path: "/api/crew/access" })); assert.equal(first.status, 200);
  assert.equal((await route.GET(request(value.token))).status, 401);
  const newer = await store.createCrewCapability(value.session.actor, "priya");
  const replay = await accessRoute.POST(request(value.session.token, body, { path: "/api/crew/access" })); assert.equal(replay.status, 200); assert.equal((await replay.json()).replayed, true);
  assert.equal((await route.GET(request(newer))).status, 200); assert.deepEqual((await store.getShow(value.session.actor.tenantId)).acknowledgments, before);
  assert.equal((await accessService.crewAccessOverview(value.session.actor)).people.find(person => person.personId === "priya")!.activeLinks, 1);
});
test("separate tenants stay isolated and a crew cookie cannot be promoted to its original producer", async () => {
  const first = await fresh("sam"), second = await fresh("priya");
  assert.notEqual(first.session.actor.tenantId, second.session.actor.tenantId);
  const result = await post(first.token, acknowledgment(first)); assert.equal(result.response.status, 200);
  assert.equal((await store.getShow(second.session.actor.tenantId)).acknowledgments.length, 0);
  const promoted = await store.createSession(first.token, "crew-api-promotion:" + randomUUID());
  assert.equal(promoted.reused, false); assert.notEqual(promoted.actor.tenantId, first.session.actor.tenantId); assert.equal(promoted.actor.personId, null); assert.ok(promoted.actor.roles.includes("producer"));
  const stolenKey = { ...acknowledgment(first), idempotencyKey: result.body.receipt.commandId, expectedRevision: result.body.data.show.revision };
  const anotherPerson = await store.createCrewCapability(first.session.actor, "priya");
  const conflict = await post(anotherPerson, stolenKey); assert.equal(conflict.response.status, 409); assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(crewCommandEnvelopeSchema.safeParse(stolenKey).success, true);
});
