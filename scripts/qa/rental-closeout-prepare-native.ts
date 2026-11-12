/** Root-authorized controlled SDK setup. Actual egress is blocked; no real physical or provider evidence. */
import "./rental-closeout-controlled-wire-runtime.mjs";
import "dotenv/config";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Actor } from "../../src/domain/contracts";
import { digest } from "../../src/domain/hash";
import { rentalHarness } from "../../tests/rental-closeout-harness";
const directory = process.argv.includes("--http") ? ".artifacts/rental-closeout-http-4580" : ".artifacts/rental-closeout-native-4580", path = directory + "/fixture.json";
const guard = (globalThis as typeof globalThis & { openingNightProviderEgressGuard?: { version: number } }).openingNightProviderEgressGuard;
const databaseUrl = new URL(process.env.DATABASE_URL!);
if (process.env.VERCEL || process.env.OPENING_NIGHT_RENTAL_CLOSEOUT_QA !== "1" || guard?.version !== 2 || databaseUrl.hostname !== "127.0.0.1" || databaseUrl.port !== "55573" || databaseUrl.pathname !== "/opening_retained_d9fdcec8e189") throw new Error("Only the explicitly owned provider-blocked stage15 runtime may be prepared");
await mkdir(directory, { recursive: true, mode: 0o700 });
if (existsSync(path)) throw new Error("An original preparation record already exists. It is preserved; no reset, reseed, unknown replay or expiry extension is supported.");
type Access = { actor: Actor; token: string; expiresAt: string };
type Fixture = { version: 1; state: "preparing" | "ready" | "failed"; createdAt: string; expiresAt: string; origin: string; cookie: string; database: string; schema: string; bootstrapKey: string; access: Partial<Record<"producer" | "supplier" | "alternate" | "other" | "sam", Access>>; journal: { step: string; path: string; at: string }[]; original?: { executionId: string; planVersion: number; planDigest: string; rootIntentId: string; orderId: string; feeIntentId: string; wireRunId: string }; baseline?: Record<string, string>; failures: { at: string; message: string }[] };
const createdAt = new Date().toISOString();
const fixture: Fixture = { version: 1, state: "preparing", createdAt, expiresAt: new Date(Date.parse(createdAt) + 7 * 86400000).toISOString(), origin: "http://127.0.0.1:4580", cookie: "opening-night-rental-closeout-4580-session", database: databaseUrl.pathname.slice(1), schema: "retained_runtime", bootstrapKey: randomBytes(32).toString("base64url"), access: {}, journal: [], failures: [] };
await writeFile(path, JSON.stringify(fixture, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const save = async () => { await writeFile(path + ".next", JSON.stringify(fixture, null, 2) + "\n", { mode: 0o600 }); await rename(path + ".next", path); };
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const scope = (await pool.query("SELECT current_database() AS database,current_schema() AS schema")).rows[0];
if (scope.database !== fixture.database || scope.schema !== fixture.schema) throw new Error("Original owned runtime scope mismatch");
const priorTenants = (await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM on_shows ORDER BY tenant_id")).rows.map(value => value.tenant_id);
async function retainedRows() {
  const tables = (await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.columns WHERE table_schema=$1 AND column_name='tenant_id' ORDER BY table_name", [fixture.schema])).rows.map(value => value.table_name);
  const records: Record<string, { rows: number; digest: string }> = {};
  for (const table of tables) { if (!/^[a-z_]+$/.test(table)) throw new Error("Unexpected retained table name"); const rows = (await pool.query(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE tenant_id::text=ANY($1::text[])`, [priorTenants])).rows.map(value => value.row); records[table] = { rows: rows.length, digest: digest(rows.sort((a, b) => digest(a).localeCompare(digest(b)))) }; }
  return records;
}
const before = await retainedRows();
await writeFile(directory + "/prior-controlled-rows-before.json", JSON.stringify({ priorTenants: priorTenants.length, records: before }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
let harness: Awaited<ReturnType<typeof rentalHarness>> | null = null;
try {
  harness = await rentalHarness({ database: { pool, schema: fixture.schema, close: () => pool.end() }, realEngine: true, onStep: async (step, value) => {
    const at = new Date().toISOString(), journalPath = `${directory}/step-${String(fixture.journal.length + 1).padStart(2, "0")}-${step}.json`;
    await writeFile(journalPath, JSON.stringify({ at, step, provenance: "Controlled installed-SDK and enrolled fixture services. Actual provider egress blocked; no actual human/physical event claimed.", value }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fixture.journal.push({ step, path: journalPath, at });
    if (step === "session") { const session = value as { token: string; actor: Actor }; fixture.access.producer = { token: session.token, actor: session.actor, expiresAt: fixture.expiresAt }; await save(); await pool.query("UPDATE on_sessions SET expires_at=$2 WHERE token_hash=$1", [harness!.sessionTokenHash(session.token), fixture.expiresAt]); }
    if (step === "original-capabilities") { const scoped = value as { supplier: { token: string; actor: Actor } }; fixture.access.supplier = { ...scoped.supplier, expiresAt: fixture.expiresAt }; await save(); await pool.query("UPDATE on_sessions SET expires_at=$2 WHERE token_hash=$1", [harness!.sessionTokenHash(scoped.supplier.token), fixture.expiresAt]); }
    await save();
  } });
  const h = harness, value = await h.accepted();
  fixture.original = { executionId: value.executionId, planVersion: value.original.planVersion, planDigest: value.original.approvedPlan!.digest, rootIntentId: value.root.id, orderId: value.orderId, feeIntentId: value.feeIntentId, wireRunId: h.wire.runId }; await save();
  const alternate: Access = { token: randomBytes(32).toString("base64url"), actor: value.actor, expiresAt: fixture.expiresAt }; fixture.access.alternate = alternate; await save();
  await pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,$4)", [h.sessionTokenHash(alternate.token), alternate.actor.tenantId, alternate.actor, alternate.expiresAt]);
  const other = await h.store.createSession(undefined, "retained-native-other:" + randomUUID()); fixture.access.other = { token: other.token, actor: other.actor, expiresAt: fixture.expiresAt }; await save(); await pool.query("UPDATE on_sessions SET expires_at=$2 WHERE token_hash=$1", [h.sessionTokenHash(other.token), fixture.expiresAt]);
  const samToken = await h.store.createCrewCapability(value.actor, "sam"), sam = (await h.store.getActor(samToken))!; fixture.access.sam = { token: samToken, actor: sam, expiresAt: fixture.expiresAt }; await save(); await pool.query("UPDATE on_sessions SET expires_at=$2 WHERE token_hash=$1", [h.sessionTokenHash(samToken), fixture.expiresAt]);
  for (const access of Object.values(fixture.access)) { const row = (await pool.query("SELECT actor,expires_at FROM on_sessions WHERE token_hash=$1", [h.sessionTokenHash(access.token)])).rows[0]; if (!await h.store.getActor(access.token) || digest(row.actor) !== digest(access.actor) || row.expires_at.toISOString() !== fixture.expiresAt) throw new Error("Original review identity or fixed initial expiry mismatch"); }
  const desk = await h.service.readCloseoutWorkspace(value.authority), original = desk.rentals.find(item => item.id === value.executionId)!;
  if (original.currentPlan || original.verifiedFeeMinor !== 48000 || original.depositMinor !== 30000 || original.releasedMinor || original.returns.length || original.closeout) throw new Error("Native fixture must require a fresh original return and separate producer closure review");
  const after = await retainedRows(), preserved = Object.keys(before).every(table => digest(after[table]) === digest(before[table]));
  if (!preserved) throw new Error("Previously retained controlled rows changed during this setup");
  fixture.baseline = { producerShow: digest(await h.store.getShow(value.actor.tenantId)), otherShow: digest(await h.store.getShow(other.actor.tenantId)) };
  await writeFile(directory + "/prior-controlled-rows-preserved.json", JSON.stringify({ priorTenants: priorTenants.length, before, after, preserved }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await writeFile(directory + "/controlled-sdk-provenance.json", JSON.stringify({ original: fixture.original, actualProviderRequests: 0, provider: "Installed SandboxPayPalProvider over RetainedRentalWire", coreVersion: JSON.parse(await readFile("node_modules/@fracture/paypal-core/package.json", "utf8")).version, wireRunId: h.wire.runId, calls: h.wire.calls, controlledResources: [...h.wire.orders], declaration: "These are controlled SDK responses. Enrolled fixture supplier and driver/inspector events are controlled setup, not real physical sign-offs. Initial RFQ uses real services and real Bryntum engine. The later replacement plan is an explicitly supplied snapshot and does not qualify fresh late-day planning." }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fixture.state = "ready"; await save();
  await writeFile(directory + "/public-summary.json", JSON.stringify({ state: "ready", origin: fixture.origin, fixedExpiry: fixture.expiresAt, reviewPersonas: Object.keys(fixture.access), nativeBaseline: "No return inspection or hold-closure approval seeded", originalPlanVersion: original.originalPlanVersion, controlledAcceptedFeeMinor: original.verifiedFeeMinor, remainingHoldMinor: original.depositMinor, currentReleaseMinor: original.releasedMinor, initialPlanEngine: "Real Bryntum candidates committed before the initial producer approval", earlierPlanSource: "Supplied historical replacement snapshot; late-day replacement RFQ, engine run and producer approval remain pending", priorControlledTenantsPreserved: priorTenants.length, actualProviderRequests: 0, actualPhysicalHandoffs: 0, noResetReseedOrRenewal: true }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ fixture: directory + "/fixture.json", state: fixture.state, fixedExpiry: fixture.expiresAt, priorTenantsPreserved: priorTenants.length, originalPlanVersion: original.originalPlanVersion, actualProviderRequests: 0 }));
} catch (error) {
  fixture.state = "failed"; fixture.failures.push({ at: new Date().toISOString(), message: error instanceof Error ? error.message : "Controlled setup failed" }); await save(); throw error;
} finally { if (harness) await harness.close(); else await pool.end(); }
