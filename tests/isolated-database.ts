import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import "../src/server/env";

export async function isolatedDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !["localhost", "127.0.0.1"].includes(new URL(connectionString).hostname)) throw new Error("Integration fixtures require a local PostgreSQL database");
  const schema = "on_test_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  // pg URL options otherwise override Pool.options and can target the runtime schema.
  const isolatedUrl = new URL(connectionString); isolatedUrl.searchParams.delete("options");
  const pool = new Pool({ connectionString: isolatedUrl.href, options: "-c search_path=" + schema, max: 8 });
  const actual = (await pool.query<{ schema: string }>("SELECT current_schema() AS schema")).rows[0]?.schema;
  if (actual !== schema) { await pool.end(); await admin.end(); throw new Error("Integration schema isolation failed before importing application code"); }
  (globalThis as typeof globalThis & { openingNightPool?: Pool }).openingNightPool = pool;
  return { schema, pool, close: async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); } };
}
