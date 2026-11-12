import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedDatabase } from "./isolated-database";
import { digest } from "../src/domain/hash";
test("additive continuity migration preserves original planning bytes and expiry while leaving legacy authority read-only", async () => {
  const database = await isolatedDatabase();
  try {
    // This marker only constructs the real pre-continuity schema in this disposable test schema.
    // Remove it before taking the baseline; no original runtime or record is reset.
    await database.pool.query("CREATE TABLE on_schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    await database.pool.query("INSERT INTO on_schema_migrations(version) VALUES(18)");
    const store = await import("../src/server/store"), { sessionTokenHash } = await import("../src/server/session-records"), { sealIntelligence } = await import("../src/server/intelligence/private-payload");
    await store.migrate(); await database.pool.query("DELETE FROM on_schema_migrations WHERE version=18");
    const session = await store.createSession(undefined, "model-additive-migration:" + randomUUID()), conversationId = randomUUID(), runId = randomUUID();
    const request = sealIntelligence(session.show.tenantId, `run:${runId}:request`, { model: "gpt-6.1-sol", store: true, previous_response_id: "resp_retained_legacy", input: "Original failed legacy instruction" });
    await database.pool.query("INSERT INTO on_intelligence_conversations(id,tenant_id,actor_id) VALUES($1,$2,$3)", [conversationId, session.show.tenantId, session.actor.id]);
    await database.pool.query("INSERT INTO on_intelligence_runs(id,tenant_id,conversation_id,actor_id,request_id,request_hash,sequence,revision,source_digest,request_cipher,provider_source,state,failure_code) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,'controlled_fixture','failed','PROVIDER_HTTP_400')", [runId, session.show.tenantId, conversationId, session.actor.id, randomUUID(), digest("original command"), session.show.revision, digest(session.show), request]);
    async function snapshot() {
      const names = (await database.pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'on_schema_migrations' ORDER BY tablename")).rows.map(row => row.tablename as string), rows: Record<string, { count: number; digest: string }> = {};
      for (const name of names) { assert.match(name, /^[a-z_]+$/); const values = (await database.pool.query(`SELECT row_to_json(t)::text AS value FROM "${name}" t ORDER BY row_to_json(t)::text`)).rows.map(row => row.value); rows[name] = { count: values.length, digest: digest(values) }; }
      return rows;
    }
    // The independent consent migration can already be present; continuity still adds exactly its four tables.
    const before = await snapshot(); assert.equal((await database.pool.query("SELECT max(version) AS version FROM on_schema_migrations")).rows[0].version, 19);
    delete (globalThis as typeof globalThis & { openingNightMigration?: Promise<void> }).openingNightMigration;
    await store.migrate(); const after = await snapshot();
    assert.equal(Object.keys(after).length, Object.keys(before).length + 4);
    for (const [name, record] of Object.entries(before)) assert.deepEqual(after[name], record, name);
    for (const name of ["on_intelligence_scopes", "on_intelligence_observations", "on_source_compilation_scopes", "on_source_compilation_observations"]) assert.equal(after[name]?.count, 0);
    const { readIntelligenceConversation } = await import("../src/server/intelligence/ledger");
    const history = await readIntelligenceConversation({ actor: session.actor, sessionHash: sessionTokenHash(session.token) }, conversationId);
    assert.equal(history.canContinue, false); assert.equal(history.runs[0]?.id, runId); assert.equal(history.runs[0]?.state, "failed");
    assert.equal((await database.pool.query("SELECT request_cipher FROM on_intelligence_runs WHERE id=$1", [runId])).rows[0].request_cipher, request);
    await store.migrate(); assert.deepEqual(await snapshot(), after);
    assert.equal((await database.pool.query("SELECT count(*)::integer AS count FROM on_schema_migrations WHERE version=18")).rows[0].count, 1);
  } finally { await database.close(); }
});
