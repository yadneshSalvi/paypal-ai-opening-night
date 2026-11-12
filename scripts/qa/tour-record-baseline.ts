/** Read-only database snapshot of the ready native fixture and retained failed attempt. */
import "./tour-disabled-providers.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pool, getShow } from "../../src/server/store";
import { sessionTokenHash } from "../../src/server/session-records";
import { readTourWorkspace, readPersonalTour } from "../../src/server/tour/service";
import { digest } from "../../src/domain/hash";
import type { Actor } from "../../src/domain/contracts";

const directory = ".artifacts/tour-native-4558-r2", raw = await readFile(`${directory}/fixture.json`), fixture = JSON.parse(raw.toString());
const database = new URL(process.env.DATABASE_URL!);
if (database.hostname !== "127.0.0.1" || database.port !== "55556") throw new Error("Only the owned stage12 database may be read");
assert.equal(fixture.state, "ready"); assert.equal(fixture.version, 2);
const producer = { actor: fixture.producer.actor, sessionHash: sessionTokenHash(fixture.producer.token) };
const tables = ["on_shows", "on_events", "on_commands", "on_tour_records", "on_tour_editions", "on_tour_commands", "on_tour_acknowledgments", "on_tour_source_bindings", "on_source_documents", "on_source_objects", "on_source_compilations"];
async function tableSnapshots(tenant: string) {
  const output = [];
  for (const table of tables) {
    const rows = (await pool.query(`SELECT row_to_json(t) AS value FROM ${table} t WHERE tenant_id=$1`, [tenant])).rows.map(row => row.value);
    rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    output.push({ table, rows: rows.length, digest: digest(rows) });
  }
  return output;
}
async function sessions(intent: typeof fixture) {
  const output = [];
  for (const [name, value] of Object.entries({ producer: intent.producer, other: intent.other, ...intent.crew }) as [string, { token: string; actor: Actor; expiresAt: string }][]) {
    const row = (await pool.query("SELECT actor,expires_at FROM on_sessions WHERE token_hash=$1", [sessionTokenHash(value.token)])).rows[0];
    assert.deepEqual(row.actor, value.actor); assert.equal(row.expires_at.toISOString(), value.expiresAt);
    output.push({ persona: name, actorId: value.actor.id, tenantId: value.actor.tenantId, expiresAt: value.expiresAt });
  }
  return output;
}
try {
  const workspace = await readTourWorkspace(producer), canonicalRoot = await getShow(producer.actor.tenantId);
  assert.equal(digest(canonicalRoot), fixture.canonicalRootDigest); assert.equal(digest(workspace), fixture.nativeBaselineDigest);
  assert.equal(workspace.swaps.length, 0); assert.equal(workspace.acknowledgments.length, 0); assert.ok(workspace.readbacks.every(value => !value.current));
  assert.equal(workspace.productions.length, 6); assert.equal(workspace.templates.length, 2);
  for (const production of workspace.productions) { assert.deepEqual(production.operationalEvidence, []); assert.deepEqual(production.commercialEvidence, []); }
  assert.equal(workspace.comparisons[0]!.applied, null);
  const own = await readPersonalTour({ actor: fixture.crew.tom.actor, sessionHash: sessionTokenHash(fixture.crew.tom.token) });
  assert.ok(own.calls.every(value => !value.acknowledged));
  const source = (await pool.query("SELECT id,state,provider_source,provider_response_id,result_digest FROM on_source_compilations WHERE tenant_id=$1 ORDER BY id", [producer.actor.tenantId])).rows;
  assert.equal(source.length, 2);
  for (const row of source) { assert.equal(row.state, "completed"); assert.equal(row.provider_source, "controlled_fixture"); assert.match(row.provider_response_id, /^resp_synthetic_stage12_static_[AB]$/); }
  const failedRaw = await readFile(".artifacts/tour-native-4558/fixture.json"), failed = JSON.parse(failedRaw.toString());
  const retainedFailure = (await pool.query("SELECT id,state,failure_code,provider_source,provider_response_id FROM on_source_compilations WHERE tenant_id=$1", [failed.producer.actor.tenantId])).rows;
  assert.equal(retainedFailure.length, 1); assert.equal(retainedFailure[0].state, "indeterminate"); assert.equal(retainedFailure[0].failure_code, "DISPATCH_IDENTITY_UNKNOWN"); assert.equal(retainedFailure[0].provider_response_id, null);
  const value = {
    at: new Date().toISOString(), origin: fixture.origin, cookie: fixture.cookie, tenantId: producer.actor.tenantId,
    fixtureSha256: createHash("sha256").update(raw).digest("hex"), originalCreatedAt: fixture.createdAt,
    rootDigest: digest(canonicalRoot), workspaceDigest: digest(workspace), originalWorkspaceDigest: fixture.nativeBaselineDigest,
    synthetic: fixture.synthetic, sessions: await sessions(fixture), tableSnapshots: await tableSnapshots(producer.actor.tenantId),
    productions: workspace.productions.map(value => ({ id: value.id, name: value.name, origin: value.origin, revision: value.revision, digest: value.digest })),
    templates: workspace.templates.map(value => ({ id: value.id, name: value.spec.name, revision: value.revision, digest: value.digest })),
    comparison: workspace.comparisons[0]!.candidates.map(value => ({ id: value.id, name: value.name, status: value.report.status, hard: value.report.hard.length, unknown: value.report.unknown.length, approvals: value.report.approvals.length, engine: value.report.engine?.status })),
    personalTom: { calls: own.calls.length, currentReadbacks: 0, swaps: 0, historicalReadbacks: own.history.length }, sourceCompilations: source,
    retainedFailedAttempt: { path: ".artifacts/tour-native-4558/fixture.json", sha256: createHash("sha256").update(failedRaw).digest("hex"), sessions: await sessions(failed), tableSnapshots: await tableSnapshots(failed.producer.actor.tenantId), sourceCompilations: retainedFailure, reset: false, replaced: false },
    originalFixturePreserved: true, actualProviderCalls: false,
  };
  if (process.argv.includes("--verify")) {
    const baseline = JSON.parse(await readFile(`${directory}/native-baseline-at-freeze.json`, "utf8"));
    for (const key of ["fixtureSha256", "rootDigest", "workspaceDigest", "sessions", "tableSnapshots", "sourceCompilations", "retainedFailedAttempt"] as const) assert.deepEqual(value[key], baseline[key], `The original ${key} changed`);
    const file = `${directory}/baseline-verification-${Date.now()}.json`;
    await writeFile(file, JSON.stringify({ at: value.at, fixturePreserved: true, retainedFailedAttemptPreserved: true, tables: tables.length, originalExpiryUnchanged: true, databaseWrites: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ verified: true, file }));
  } else {
    await writeFile(`${directory}/native-baseline-at-freeze.json`, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ fixturePreserved: true, retainedFailedAttemptPreserved: true, personalDecisionsSeeded: 0, sourceCompilations: source.length, baseline: `${directory}/native-baseline-at-freeze.json` }));
  }
} finally { await pool.end(); }
