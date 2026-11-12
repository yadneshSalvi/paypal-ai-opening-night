/** Read-only forensic receipt for the original failed preparation; no replay, reset or repair. */
import "./audience-disabled-runtime.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { audienceFixtureBase } from "./audience-fixture.mjs";
import { audienceSha256 } from "./audience-inputs.mjs";
const mode = process.argv.includes("--http") ? "http" : "native", base = audienceFixtureBase(mode), bytes = await readFile(base + "/fixture.json"), original = JSON.parse(bytes);
if (original.state !== "failed" || !/^audience_review_[a-f0-9]{32}$/.test(original.schema)) throw new Error("Only the original failed audience preparation may be inspected");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: "-c search_path=" + original.schema, max: 1 }), records = {};
try {
  await pool.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const tables = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name")).rows;
  for (const table of tables) { if (!/^[a-z0-9_]+$/.test(table.table_name)) throw new Error("Unexpected original table"); const rows = (await pool.query('SELECT to_jsonb(t) AS row FROM "' + table.table_name + '" t ORDER BY to_jsonb(t)::text')).rows.map(row => row.row); records[table.table_name] = { rows: rows.length, sha256: audienceSha256(JSON.stringify(rows)) }; }
  await pool.query("COMMIT");
  const result = { version: 1, state: "inspected_original_failure", originalFixtureSha256: audienceSha256(bytes), originalState: original.state, originalSourceInputDigest: original.sourceInputDigest, originalFailure: original.failures, journalSteps: original.journal.map(step => step.step), records, databaseMutations: 0, originalExpiryMutations: 0, commandsReplayed: 0, completedAt: new Date().toISOString() };
  await writeFile(base + "/failed-first-inspection.json", JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ state: result.state, tables: tables.length, databaseMutations: 0, originalFixtureSha256: result.originalFixtureSha256 }));
} finally { await pool.end(); }
