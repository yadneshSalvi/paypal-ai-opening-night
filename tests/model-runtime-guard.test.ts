import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
test("the model runtime denies a different database or role before connecting and admits only its exact owned database", async () => {
  const guard = (globalThis as typeof globalThis & { openingNightModelControlledGuard?: { version: number; database: string; role: string; state: { blockedDatabaseIdentities: number; ownDatabaseConnections: number } } }).openingNightModelControlledGuard;
  assert.equal(guard?.version, 2); assert.ok(guard?.database && guard?.role);
  const before = { ...guard.state }, original = new URL(process.env.DATABASE_URL!);
  for (const kind of ["database", "role"]) {
    const denied = new URL(original); if (kind === "database") denied.pathname = "/unowned_model_database"; else denied.username = "unowned_model_role";
    const client = new Client({ connectionString: denied.href });
    assert.throws(() => client.connect(), /different database or role before connecting/);
  }
  assert.equal(guard.state.blockedDatabaseIdentities, before.blockedDatabaseIdentities + 2); assert.equal(guard.state.ownDatabaseConnections, before.ownDatabaseConnections);
  const client = new Client({ connectionString: original.href });
  try { await client.connect(); const scope = (await client.query("SELECT current_database() AS database,current_user AS role,current_schema() AS schema")).rows[0]; assert.deepEqual(scope, { database: guard.database, role: guard.role, schema: "model_runtime" }); }
  finally { await client.end(); }
});
