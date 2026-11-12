import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { parse } from "dotenv";
const file = new URL("../.private/local-only.env", import.meta.url);
assert.equal(statSync(file).mode & 0o777, 0o600, "Use only the protected fresh local input configuration");
const fresh = parse(readFileSync(file));
for (const key of ["DATABASE_URL", "JUDGE_SESSION_SECRET", "BRYNTUM_LICENSE_KEY"]) { assert.ok(fresh[key], `Missing isolated ${key}`); process.env[key] = fresh[key]; }
const connection = new URL(process.env.DATABASE_URL);
assert.equal(connection.hostname, "127.0.0.1"); assert.equal(connection.port, "55575");
assert.equal(decodeURIComponent(connection.pathname.slice(1)), "opening_inputs_a33a861ff304"); assert.equal(decodeURIComponent(connection.username), "inputs_app_a33a861ff304");
process.env.OPENING_NIGHT_INPUTS_DATABASE = "opening_inputs_a33a861ff304";
process.env.OPENING_NIGHT_INPUTS_ROLE = "inputs_app_a33a861ff304";
process.env.OPENING_NIGHT_INPUTS_PORT = "55575";
process.env.OPENING_NIGHT_MODEL_DATABASE = process.env.OPENING_NIGHT_INPUTS_DATABASE;
process.env.OPENING_NIGHT_MODEL_ROLE = process.env.OPENING_NIGHT_INPUTS_ROLE;
process.env.OPENING_NIGHT_MODEL_TEST_PORT = process.env.OPENING_NIGHT_INPUTS_PORT;
process.env.OPENING_NIGHT_MODEL_GUARD_AUDIT = new URL("../.private/production-inputs-evidence/transport", import.meta.url).pathname;
await import("../scripts/qa/model-controlled-runtime.mjs");
