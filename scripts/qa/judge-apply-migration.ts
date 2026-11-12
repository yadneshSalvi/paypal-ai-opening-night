/**
 * Applies the additive judge-v23 migration to the configured LOCAL database
 * when a long-running dev process memoized its migration run before v23
 * existed. Uses the same advisory lock and version row as `migrate()`.
 */
import pg from "pg";
import "../../src/server/env";
import { judgeMigration } from "../../src/server/migrations/judge-v23";

const connectionString = process.env.DATABASE_URL;
if (!connectionString || !["localhost", "127.0.0.1"].includes(new URL(connectionString).hostname)) throw new Error("This helper only targets a local PostgreSQL database");
const pool = new pg.Pool({ connectionString, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(4105001)");
  const prior = await client.query("SELECT version FROM on_schema_migrations WHERE version IN (22,23) ORDER BY version");
  if (!prior.rows.some(row => row.version === 22)) throw new Error("Run the application once so migrations up to v22 exist");
  if (prior.rows.some(row => row.version === 23)) console.log(JSON.stringify({ applied: false, reason: "already current" }));
  else { await client.query(judgeMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(23)"); console.log(JSON.stringify({ applied: true })); }
  await client.query("COMMIT");
} catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await pool.end(); }
