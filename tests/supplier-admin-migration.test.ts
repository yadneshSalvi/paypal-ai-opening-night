import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { digest } from "../src/domain/hash";
import { applyCommand } from "../src/domain/commands";
import { isolatedDatabase } from "./isolated-database";

test("migration21 is additive over the actual prior schema and preserves every original service row and full session expiry", async () => {
  const database = await isolatedDatabase();
  try {
    // Match the existing versioned migration-test seam in this disposable schema only.
    await database.pool.query("CREATE TABLE on_schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    await database.pool.query("INSERT INTO on_schema_migrations(version) VALUES(21)");
    const store = await import("../src/server/store"); await store.migrate(); await database.pool.query("DELETE FROM on_schema_migrations WHERE version=21");
    const session = await store.createSession(undefined, "supplier-admin-additive:" + randomUUID());
    await store.transactCommand(session.actor, randomUUID(), session.show.revision, { type: "load_incidents" }, show => applyCommand(show, session.actor, { type: "load_incidents" }));
    const rfq = await import("../src/server/supplier-rfq"), rpc = await import("../src/app/api/enrolled-suppliers/[supplier]/rpc/route"); const show = await store.getShow(session.actor.tenantId), id = randomUUID();
    await rfq.beginSupplierRfq(session.actor, id, show.revision);
    assert.equal((await rfq.collectSupplierRfq(session.actor.tenantId, id, AbortSignal.timeout(10000), request => rpc.POST(request, { params: Promise.resolve({ supplier: new URL(request.url).pathname.split("/").at(-2)! }) }))).status, "complete");
    async function snapshot() {
      const names = (await database.pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'on_schema_migrations' ORDER BY tablename")).rows.map(row => row.tablename as string), records: Record<string, { rows: number; digest: string }> = {};
      for (const name of names) { assert.match(name, /^[a-z_]+$/); const rows = (await database.pool.query(`SELECT row_to_json(t)::text AS value FROM "${name}" t ORDER BY row_to_json(t)::text`)).rows.map(row => row.value); records[name] = { rows: rows.length, digest: digest(rows) }; }
      return records;
    }
    const before = await snapshot(), originalExpiry = (await database.pool.query("SELECT expires_at::text AS expiry FROM on_sessions")).rows;
    assert.equal((await database.pool.query("SELECT max(version) AS version FROM on_schema_migrations")).rows[0].version, 19);
    delete (globalThis as typeof globalThis & { openingNightMigration?: Promise<void> }).openingNightMigration;
    await store.migrate(); const after = await snapshot();
    assert.equal(Object.keys(after).length, Object.keys(before).length + 5);
    for (const [name, record] of Object.entries(before)) assert.deepEqual(after[name], record, name);
    for (const name of ["on_supplier_admin_records", "on_supplier_admin_keys", "on_supplier_admin_commands", "on_supplier_admin_invites", "on_supplier_admin_requests"]) assert.equal(after[name]!.rows, 0);
    assert.equal(digest((await database.pool.query("SELECT expires_at::text AS expiry FROM on_sessions")).rows), digest(originalExpiry));
    assert.equal((await database.pool.query("SELECT max(version) AS version FROM on_schema_migrations")).rows[0].version, 21);
    await store.migrate(); assert.deepEqual(await snapshot(), after);
  } finally { await database.close(); }
});
