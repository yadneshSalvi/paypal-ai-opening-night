import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { digest } from "../src/domain/hash";
import { applyCommand } from "../src/domain/commands";
import { isolatedDatabase } from "./isolated-database";

test("additive consent migration preserves every original row and only adds empty review ledgers", async () => {
  const database = await isolatedDatabase();
  try {
    // Construct the actual pre-consent shape in this disposable schema only.
    await database.pool.query("CREATE TABLE on_schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    await database.pool.query("INSERT INTO on_schema_migrations(version) VALUES(19)");
    const store = await import("../src/server/store"); await store.migrate();
    await database.pool.query("DELETE FROM on_schema_migrations WHERE version=19");
    const session = await store.createSession(undefined, "plan-consent-additive:" + randomUUID());
    await store.transactCommand(session.actor, randomUUID(), session.show.revision, { type: "load_incidents" }, show => applyCommand(show, session.actor, { type: "load_incidents" }));
    async function snapshot() {
      const names = (await database.pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'on_schema_migrations' ORDER BY tablename")).rows.map(row => row.tablename as string), records: Record<string, { count: number; digest: string }> = {};
      for (const name of names) {
        assert.match(name, /^[a-z_]+$/); const values = (await database.pool.query(`SELECT row_to_json(t)::text AS value FROM "${name}" t ORDER BY row_to_json(t)::text`)).rows.map(row => row.value);
        records[name] = { count: values.length, digest: digest(values) };
      }
      return records;
    }
    const before = await snapshot(); assert.equal((await database.pool.query("SELECT max(version) AS version FROM on_schema_migrations")).rows[0].version, 18);
    delete (globalThis as typeof globalThis & { openingNightMigration?: Promise<void> }).openingNightMigration;
    await store.migrate(); const after = await snapshot();
    assert.equal(Object.keys(after).length, Object.keys(before).length + 5);
    for (const [name, record] of Object.entries(before)) assert.deepEqual(after[name], record, name);
    for (const name of ["on_plan_consent_requests", "on_plan_consent_commands", "on_plan_consent_decisions", "on_plan_consent_revocations", "on_plan_consent_consumptions"]) assert.equal(after[name]?.count, 0);
    assert.equal((await database.pool.query("SELECT max(version) AS version FROM on_schema_migrations")).rows[0].version, 19);
    await store.migrate(); assert.deepEqual(await snapshot(), after);
  } finally { await database.close(); }
});
