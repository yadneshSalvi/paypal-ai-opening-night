import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedDatabase } from "./isolated-database";
import { settlementEnvelopeSchema, type PersonalSettlementData, type ProductionSettlementData, type SettlementCommand, type SettlementEnvelope } from "../src/domain/settlement/contracts";
import { parsePendingSettlement, recoveredSettlement } from "../src/components/settlement/recovery";
import { atVenue } from "../src/domain/time";
import { digest } from "../src/domain/hash";
import { sourceApplicationBlock } from "../src/server/sources/validation";

const database = await isolatedDatabase(), store = await import("../src/server/store"), service = await import("../src/server/settlement/service"), personalRoute = await import("../src/app/api/crew/settlement/route"), producerRoute = await import("../src/app/api/settlement/route");
const { sessionTokenHash } = await import("../src/server/session-records"), { openIntelligence } = await import("../src/server/intelligence/private-payload");
after(async () => { await database.close(); });
const origin = "http://localhost:4524";
const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === wanted);
function request(token: string | null, body?: unknown, extra: { origin?: string; cookie?: string; raw?: string } = {}) {
  const headers = new Headers({ origin: extra.origin ?? origin, "content-type": "application/json" }); if (token) headers.set("authorization", "Bearer " + token); if (extra.cookie) headers.set("cookie", "opening-night-session=" + extra.cookie);
  return new Request(origin + "/api/crew/settlement", { method: body === undefined && extra.raw === undefined ? "GET" : "POST", headers, ...(body !== undefined || extra.raw !== undefined ? { body: extra.raw ?? JSON.stringify(body) } : {}) });
}
async function fresh() {
  const session = await store.createSession(undefined, "settlement:" + randomUUID()), token = await store.createCrewCapability(session.actor, "priya"), crewActor = (await store.getActor(token))!;
  const producer = { actor: session.actor, sessionHash: sessionTokenHash(session.token), scope: "production" as const }, personal = { actor: crewActor, sessionHash: sessionTokenHash(token), scope: "personal" as const };
  return { session, token, producer, personal };
}
type Workspace = Awaited<ReturnType<typeof fresh>>;
async function command(workspace: Workspace, payload: SettlementCommand, idempotencyKey: string = randomUUID()) {
  const authority = payload.type === "report_time" ? workspace.personal : workspace.producer, data = await service.readSettlement(authority);
  const envelope: SettlementEnvelope = { idempotencyKey, expectedRevision: data.revision, expectedShowRevision: data.productionRevision, command: payload };
  return { authority, envelope, result: await service.executeSettlement(authority, envelope) };
}
function report(workspace: Workspace): Extract<SettlementCommand, { type: "report_time" }> { const sheet = workspace.session.show.sheets.at(-1)!; return { type: "report_time", serviceDay: "2026-11-14", replacesId: null, sheetVersion: sheet.version, sheetDigest: sheet.digest, intervals: [{ start: atVenue("11:30"), end: atVenue("12:30"), unpaidMinutes: 0 }], detail: "Reported fixture lighting hours for independent review.", confirmed: true }; }
function rate(): Extract<SettlementCommand, { type: "approve_rate" }> { return { type: "approve_rate", personId: "priya", previousRateId: null, effectiveFrom: "2026-11-14", currency: "USD", hourlyMinor: 3500, overtimeHourlyMinor: 5250, regularMinutes: 480, agreement: "Explicit fictional agreement for the reported show day.", confirmed: true }; }
test("settlement starts in a disposable schema with empty liabilities and no schedule-derived reports", async () => {
  const value = await fresh(), data = await service.readSettlement(value.personal) as PersonalSettlementData;
  assert.equal((await database.pool.query("SELECT current_schema() AS schema")).rows[0].schema, database.schema);
  assert.equal((await database.pool.query("SELECT max(version) AS version FROM on_schema_migrations")).rows[0].version, 12);
  assert.equal(data.revision, 0); assert.deepEqual(data.personal.reports, []); assert.deepEqual(data.personal.rates, []); assert.equal(data.personal.approvedBalanceMinor, 0); assert.equal(data.paymentCapability, "separate_payout_review_required");
});
test("lost response and concurrent same-ID requests recover one immutable attributed record", async () => {
  const value = await fresh(), initial = await service.readSettlement(value.personal), envelope = { idempotencyKey: randomUUID(), expectedRevision: initial.revision, expectedShowRevision: initial.productionRevision, command: report(value) };
  const [a, b] = await Promise.all([service.executeSettlement(value.personal, envelope), service.executeSettlement(value.personal, envelope)]);
  assert.deepEqual(a.receipt, b.receipt); assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
  assert.equal(a.receipt.requestDigest, digest(envelope)); assert.equal(a.receipt.actorId, value.personal.actor.id);
  const replay = await service.executeSettlement(value.personal, envelope); assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, a.receipt);
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_settlement_records WHERE tenant_id=$1", [value.session.actor.tenantId])).rows[0].count, 1);
  await assert.rejects(service.executeSettlement(value.personal, { ...envelope, command: { ...envelope.command, detail: "Changed instructions under an already used identity." } }), code("IDEMPOTENCY_CONFLICT"));
  assert.equal((await service.readSettlement(value.personal)).receipts[0].requestDigest, digest(envelope));
});
test("competing reviews serialize and a definite stale rejection has no command receipt", async () => {
  const value = await fresh(), data = await service.readSettlement(value.producer), envelope = { idempotencyKey: randomUUID(), expectedRevision: data.revision, expectedShowRevision: data.productionRevision, command: rate() };
  const second = { ...envelope, idempotencyKey: randomUUID() }, results = await Promise.allSettled([service.executeSettlement(value.producer, envelope), service.executeSettlement(value.producer, second)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); const rejected = results.findIndex(result => result.status === "rejected");
  assert.equal((results[rejected] as PromiseRejectedResult).reason.code, "SETTLEMENT_REVIEW_STALE");
  assert.equal((await database.pool.query("SELECT command_id FROM on_commands WHERE tenant_id=$1 AND command_id=$2", [value.session.actor.tenantId, rejected === 0 ? envelope.idempotencyKey : second.idempotencyKey])).rowCount, 0);
});
test("an existing whitespace-normalized payable recovers from its untouched legacy file using reads only", async () => {
  const value = await fresh(); await command(value, rate()); await command(value, report(value));
  const before = await service.readSettlement(value.producer) as ProductionSettlementData, preview = before.people.find(person => person.person.id === "priya")!.reports[0].preview!;
  const envelope: SettlementEnvelope = { idempotencyKey: randomUUID(), expectedRevision: before.revision, expectedShowRevision: before.productionRevision, command: { type: "approve_payable", reportId: preview.reportId, rateId: preview.rateId, reviewDigest: preview.digest, detail: "  Reviewed these exact hours, rate and payable. ", reviewedHours: true, reviewedRate: true, reviewedAdjustment: true } };
  const identity = { scope: "production" as const, actorId: value.producer.actor.id, ownerId: value.producer.actor.tenantId }, legacy = JSON.stringify({ schemaVersion: 1, ...identity, createdAt: new Date().toISOString(), requestDigest: digest(envelope), envelope });
  const saved = await service.executeSettlement(value.producer, envelope), pending = await parsePendingSettlement(legacy, identity), data = await service.readSettlement(value.producer) as ProductionSettlementData;
  assert.notEqual(saved.receipt.requestDigest, digest(envelope)); assert.equal(saved.receipt.requestDigest, digest(settlementEnvelopeSchema.parse(envelope))); assert.deepEqual(recoveredSettlement(data, pending), saved.receipt);
  assert.equal(data.totals.approvedBalanceMinor, 3500); assert.equal(data.revision, 3); assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_settlement_records WHERE tenant_id=$1", [identity.ownerId])).rows[0].count, 3);
  assert.equal(JSON.parse(legacy).envelope.command.detail.endsWith(" "), true);
});
test("original encrypted requests and records resist mutation and use tenant-bound context", async () => {
  const value = await fresh(), saved = await command(value, report(value)), row = (await database.pool.query("SELECT * FROM on_settlement_records WHERE id=$1", [saved.result.receipt.id])).rows[0];
  assert.equal(row.record_cipher.includes("lighting"), false); assert.equal(row.request_cipher.includes("lighting"), false);
  assert.deepEqual(openIntelligence(value.session.actor.tenantId, `settlement:v1:${row.id}:request`, row.request_cipher), saved.envelope);
  assert.throws(() => openIntelligence(randomUUID(), `settlement:v1:${row.id}:request`, row.request_cipher));
  await assert.rejects(database.pool.query("UPDATE on_settlement_records SET person_id='sam' WHERE id=$1", [row.id]), /Immutable settlement/);
  await assert.rejects(database.pool.query("DELETE FROM on_settlement_records WHERE id=$1", [row.id]), /Immutable settlement/);
  const retained = await service.readSettlement(value.personal) as PersonalSettlementData; assert.equal(retained.personal.reports.length, 1); assert.equal(retained.receipts[0].digest, row.record_digest);
});
test("producer-approved liability and negative correction preserve money, crew and schedule history", async () => {
  const value = await fresh(), before = await store.getShow(value.session.actor.tenantId); await command(value, rate()); const time = await command(value, report(value));
  let desk = await service.readSettlement(value.producer) as ProductionSettlementData, preview = desk.people.find(person => person.person.id === "priya")!.reports[0].preview!;
  const approve = () => ({ type: "approve_payable" as const, reportId: preview.reportId, rateId: preview.rateId, reviewDigest: preview.digest, detail: "Reviewed exact hours, approved agreement and adjustment.", reviewedHours: true as const, reviewedRate: true as const, reviewedAdjustment: true as const });
  const original = await command(value, approve()); assert.equal((original.result.data as ProductionSettlementData).totals.approvedBalanceMinor, 3500);
  await command(value, { ...report(value), replacesId: time.result.receipt.id, intervals: [{ start: atVenue("11:30"), end: atVenue("12:00"), unpaidMinutes: 0 }] });
  desk = await service.readSettlement(value.producer) as ProductionSettlementData; preview = desk.people.find(person => person.person.id === "priya")!.reports.at(-1)!.preview!; assert.equal(preview.deltaMinor, -1750);
  const correction = await command(value, approve()); assert.equal((correction.result.data as ProductionSettlementData).totals.approvedBalanceMinor, 1750); assert.equal((correction.result.data as ProductionSettlementData).totals.creditAdjustments, 1);
  const afterShow = await store.getShow(value.session.actor.tenantId); for (const key of ["tasks", "dependencies", "resources", "sheets", "acknowledgments", "financialEvidence", "facts", "crewCues", "crewAttestations", "state", "approvedPlan", "tickets"] as const) assert.deepEqual(afterShow[key], before[key]);
  assert.equal(afterShow.settlementVersion, 5); assert.match(sourceApplicationBlock(afterShow)!, /settlement records/);
  const replay = await service.executeSettlement(original.authority, original.envelope); assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, original.result.receipt); assert.equal(replay.data.revision, 5);
});
test("personal DTOs expose only the assigned person even with another person's producer cookie", async () => {
  const value = await fresh(); await command(value, rate()); await command(value, report(value));
  const samToken = await store.createCrewCapability(value.session.actor, "sam"), response = await personalRoute.GET(request(samToken, undefined, { cookie: value.session.token })), sam = await response.json() as PersonalSettlementData;
  assert.equal(response.status, 200); assert.equal(sam.personal.person.id, "sam"); assert.equal(sam.personal.rates.length, 0); assert.equal(sam.personal.reports.length, 0); assert.equal(sam.receipts.length, 0); assert.equal("people" in sam, false); assert.equal(JSON.stringify(sam).includes("priya"), false);
  assert.equal((await personalRoute.GET(request(null, undefined, { cookie: value.session.token }))).status, 401);
  assert.equal((await personalRoute.GET(request(value.session.token))).status, 403); assert.equal((await producerRoute.GET(request(value.token))).status, 403);
});
test("cross-tenant references, revoked sessions and same-actor replacement sessions never authorize a replay", async () => {
  const a = await fresh(), b = await fresh(), saved = await command(a, report(a));
  await assert.rejects(command(b, { type: "request_time_changes", reportId: saved.result.receipt.id, detail: "This foreign report cannot be reviewed by this actor." }), code("TIME_REPORT_NOT_FOUND"));
  const replacementHash = sessionTokenHash("replacement-" + randomUUID());
  await database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [replacementHash, a.personal.actor.tenantId, a.personal.actor]);
  await assert.rejects(service.executeSettlement({ ...a.personal, sessionHash: replacementHash }, saved.envelope), code("IDEMPOTENCY_CONFLICT"));
  await database.pool.query("UPDATE on_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [a.personal.sessionHash]);
  await assert.rejects(service.readSettlement(a.personal), code("SETTLEMENT_SESSION_ENDED")); await assert.rejects(service.executeSettlement(a.personal, saved.envelope), code("SETTLEMENT_SESSION_ENDED"));
});
test("route boundaries reject wrong origin, malformed input, missing checks and scope escalation", async () => {
  const value = await fresh(), envelope = { idempotencyKey: randomUUID(), expectedRevision: 0, expectedShowRevision: value.session.show.revision, command: report(value) };
  assert.equal((await personalRoute.POST(request(value.token, envelope, { origin: "https://other.invalid" }))).status, 403);
  assert.equal((await personalRoute.POST(request(value.token, undefined, { raw: "{" }))).status, 400);
  assert.equal((await personalRoute.POST(request(value.token, { ...envelope, extra: "x".repeat(21000) }))).status, 413);
  assert.equal((await personalRoute.POST(request(value.token, { ...envelope, personId: "sam" }))).status, 400);
  assert.equal((await personalRoute.POST(request(value.token, { ...envelope, command: { ...envelope.command, confirmed: false } }))).status, 400);
  assert.equal((await producerRoute.POST(request(value.session.token, envelope))).status, 400);
  assert.equal((await producerRoute.POST(request(value.token, { ...envelope, command: rate() }))).status, 403);
  const response = await personalRoute.POST(request(value.token, envelope)); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.match(response.headers.get("vary")!, /Authorization/);
});
