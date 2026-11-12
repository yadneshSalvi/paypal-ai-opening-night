/** Read-only exact-listener regression. Original native form rejection remains retained. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { selectedAudienceFixture } from "./audience-fixture.mjs";
if (process.env.OPENING_NIGHT_AUDIENCE_REVIEW_CLIENT !== "native" || globalThis.openingNightAudienceGuard?.version !== 1) throw new Error("Use the exact provider-disabled native review client");
const selected = await selectedAudienceFixture("native"), fixture = selected.fixture;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: "-c search_path=" + fixture.schema, max: 2 });
const hash = value => createHash("sha256").update(value).digest("hex");
const fixtureHash = hash(selected.bytes), checks = [];
async function storedRows() {
  assert.equal((await pool.query("SELECT current_schema() AS name")).rows[0]?.name, fixture.schema);
  const names = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name")).rows.map(row => row.table_name), rows = [];
  for (const name of names) { assert.match(name, /^[a-z_0-9]+$/); const values = await pool.query('SELECT to_jsonb(t)::text AS row FROM "' + name + '" t ORDER BY to_jsonb(t)::text'); rows.push({ name, count: values.rowCount, sha256: hash(JSON.stringify(values.rows)) }); }
  return rows;
}
async function check(name, operation) { await operation(); checks.push(name); }
async function request(path, init) { return fetch(fixture.origin + path, { redirect: "manual", cache: "no-store", ...init }); }
function privateResponse(response, policy) { assert.equal(response.headers.get("referrer-policy"), policy); assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("set-cookie"), null); }
try {
  const before = await storedRows();
  await check("Chooser preserves exact same-origin native form Origin", async () => { const response = await request("/__audience_fixture"); assert.equal(response.status, 200); privateResponse(response, "same-origin"); assert.match(response.headers.get("content-security-policy"), /form-action 'self'/); const html = await response.text(); assert.equal(html.includes(fixture.bootstrapKey), false); for (const access of Object.values(fixture.access)) assert.equal(html.includes(access.token), false); });
  await check("Control form response retains same-origin policy", async () => { const response = await request("/__audience_control"); assert.equal(response.status, 403); privateResponse(response, "same-origin"); });
  for (const path of ["/audience", "/attendee"]) await check(path + " retains the unchanged compiled Next policy", async () => { const response = await request(path); assert.equal(response.status, 200); privateResponse(response, "strict-origin-when-cross-origin"); });
  for (const origin of ["null", "https://foreign.invalid", null]) await check("Exact-origin guard rejects " + (origin ?? "missing") + " Origin with original correct key", async () => { const headers = { "content-type": "application/x-www-form-urlencoded" }; if (origin) headers.origin = origin; const response = await request("/__audience_fixture", { method: "POST", headers, body: new URLSearchParams({ persona: "main", key: fixture.bootstrapKey }).toString() }); assert.equal(response.status, 403); privateResponse(response, "same-origin"); assert.equal(response.headers.get("location"), null); });
  await check("Exact origin never substitutes for the private review key", async () => { const response = await request("/__audience_fixture", { method: "POST", headers: { origin: fixture.origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ persona: "main", key: "invalid" }).toString() }); assert.equal(response.status, 403); privateResponse(response, "same-origin"); });
  const after = await storedRows(); assert.deepEqual(after, before); assert.equal(hash(await readFile(selected.filename)), fixtureHash); checks.push("All original stored rows, capabilities, expiries and native fixture bytes unchanged");
  const result = { version: 1, state: "qualified_readonly_wrapper", completedAt: new Date().toISOString(), checks: checks.length, passed: checks, productionBuildId: (await readFile(".next/BUILD_ID", "utf8")).trim(), nativeFixtureSha256: fixtureHash, storedTableCount: before.length, storedRowInventorySha256: hash(JSON.stringify(before)), originalMainExpiry: fixture.access.main.expiresAt, original403Retained: true, positiveNativeSubmission: "pending_root", providerCalls: 0, modelCalls: 0, externalMessages: 0, authorityRenewal: false, financialWrites: 0, sessionWrites: 0 };
  await writeFile(".artifacts/audience-review-stage18/policy-result.json", JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 }); console.log(JSON.stringify({ state: result.state, checks: checks.length, storedTableCount: before.length, productionBuildId: result.productionBuildId, authorityRenewal: false }));
} finally { await pool.end(); }
