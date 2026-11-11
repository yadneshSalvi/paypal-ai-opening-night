import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import "../src/server/env";

export async function isolatedDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !["localhost", "127.0.0.1"].includes(new URL(connectionString).hostname)) throw new Error("Integration fixtures require a local PostgreSQL database");
  const schema = "on_test_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString, options: "-c search_path=" + schema, max: 8 });
  (globalThis as typeof globalThis & { openingNightPool?: Pool }).openingNightPool = pool;
  return { schema, pool, close: async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); } };
}
