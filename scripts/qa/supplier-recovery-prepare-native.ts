/** Fresh controlled lifecycle through real services. Never replaces a plan snapshot or renews access. */
import "./supplier-recovery-controlled-wire-runtime.mjs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Actor } from "../../src/domain/contracts";
import { digest } from "../../src/domain/hash";
import { supplierRecoveryHarness } from "../../tests/supplier-recovery-harness";
import { sessionTokenHash as tokenHash } from "../../src/server/session-records";

const directory = process.argv.includes("--http") ? ".artifacts/supplier-recovery-http-4586" : ".artifacts/supplier-recovery-native-4586";
const path = directory + "/fixture.json", databaseUrl = new URL(process.env.DATABASE_URL ?? "");
const guard = (globalThis as typeof globalThis & { openingNightProviderEgressGuard?: { version: number } }).openingNightProviderEgressGuard;
if (process.env.VERCEL || process.env.OPENING_NIGHT_SUPPLIER_RECOVERY_QA !== "1" || guard?.version !== 2 || databaseUrl.hostname !== "127.0.0.1" || databaseUrl.port !== "55575" || !/^\/opening_terms_[a-f0-9]{12}$/.test(databaseUrl.pathname)) throw new Error("Only this owned, provider-blocked stage16 database may be prepared");
type Persona = "producer" | "supplier" | "northside" | "alternate" | "other" | "sam";
type Access = { token: string; actor: Actor; expiresAt: string };
type Fixture = {
  version: 1; state: "preparing" | "ready" | "failed"; createdAt: string; origin: string; cookie: string; database: string; schema: string;
  bootstrapKey: string; access: Partial<Record<Persona, Access>>; originalCapabilities: Record<string, Access>;
  journal: { step: string; path: string; at: string }[]; original?: { executionId: string; planVersion: number; planDigest: string; rootIntentId: string; orderId: string; feeIntentId: string; wireRunId: string };
  baseline?: { producerShow: string; otherShow: string; originalExecution: string; paymentIntents: string; fixedCapabilities: string };
  failures: { at: string; message: string }[];
};
await mkdir(directory, { recursive: true, mode: 0o700 });
if (existsSync(path)) throw new Error("The original preparation record exists and is retained. No reset, reseed, renewal or replay of unknown work is supported.");
const fixture: Fixture = { version: 1, state: "preparing", createdAt: new Date().toISOString(), origin: "http://127.0.0.1:4586", cookie: "opening-night-supplier-recovery-4586-session", database: databaseUrl.pathname.slice(1), schema: "terms_runtime", bootstrapKey: randomBytes(32).toString("base64url"), access: {}, originalCapabilities: {}, journal: [], failures: [] };
await writeFile(path, JSON.stringify(fixture, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const save = async () => { await writeFile(path + ".next", JSON.stringify(fixture, null, 2) + "\n", { mode: 0o600 }); await rename(path + ".next", path); };
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let harness: Awaited<ReturnType<typeof supplierRecoveryHarness>> | null = null;
async function access(token: string, actor: Actor): Promise<Access> {
  const row = (await pool.query<{ actor: Actor; expires_at: string }>("SELECT actor,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS expires_at FROM on_sessions WHERE token_hash=$1", [tokenHash(token)])).rows[0];
  if (!row || digest(row.actor) !== digest(actor) || Date.parse(row.expires_at) <= Date.now()) throw new Error("An original capability or its unchanged fixed expiry could not be verified");
  return { token, actor, expiresAt: row.expires_at };
}
async function journal(step: string, value: unknown) {
  const at = new Date().toISOString(), journalPath = `${directory}/step-${String(fixture.journal.length + 1).padStart(2, "0")}-${step}.json`;
  await writeFile(journalPath, JSON.stringify({ at, step, provenance: "Controlled installed-SDK responses and enrolled fixture services. Actual provider egress is blocked. No human participation or physical event is claimed.", value }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fixture.journal.push({ step, path: journalPath, at });
  if (step === "session") { const valueWithAccess = value as { token: string; actor: Actor }; fixture.access.producer = await access(valueWithAccess.token, valueWithAccess.actor); }
  if (step === "original-capabilities") {
    for (const [name, original] of Object.entries(value as Record<string, { token: string; actor: Actor }>)) fixture.originalCapabilities[name] = await access(original.token, original.actor);
    fixture.access.supplier = fixture.originalCapabilities.supplier;
  }
  await save();
}
try {
  const scope = (await pool.query("SELECT current_database() AS database,current_schema() AS schema")).rows[0];
  if (scope.database !== fixture.database || scope.schema !== fixture.schema) throw new Error("Owned runtime schema binding failed before any application setup");
  harness = await supplierRecoveryHarness({ database: { pool, schema: fixture.schema, close: () => pool.end() }, realEngine: true, onStep: journal });
  const h = harness;
  const priorTenants = (await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM on_shows ORDER BY tenant_id")).rows.map(value => value.tenant_id);
  async function retainedRows() {
    const tables = (await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.columns WHERE table_schema=$1 AND column_name='tenant_id' ORDER BY table_name", [fixture.schema])).rows.map(value => value.table_name);
    const records: Record<string, { rows: number; digest: string }> = {};
    for (const table of tables) {
      if (!/^[a-z_]+$/.test(table)) throw new Error("Unexpected retained table name");
      const rows = (await pool.query(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE tenant_id::text=ANY($1::text[])`, [priorTenants])).rows.map(value => value.row);
      records[table] = { rows: rows.length, digest: digest(rows.sort((a, b) => digest(a).localeCompare(digest(b)))) };
    }
    return records;
  }
  const before = await retainedRows();
  await writeFile(directory + "/prior-controlled-rows-before.json", JSON.stringify({ priorTenants: priorTenants.length, records: before }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const value = await h.accepted({ replacePlan: false });
  fixture.original = { executionId: value.executionId, planVersion: value.original.planVersion, planDigest: value.original.approvedPlan!.digest, rootIntentId: value.root.id, orderId: value.orderId, feeIntentId: value.feeIntentId, wireRunId: h.wire.runId };
  await save();
  await journal("controlled-current-disruption", await h.report(value.supplierAuthority, "brightline"));
  const northside = await h.openSupplier(value.authority, "northside");
  fixture.access.northside = await access(northside.token, northside.actor);
  await journal("northside-current-terms-access", northside.saved);
  const alternate: Access = { token: randomBytes(32).toString("base64url"), actor: value.actor, expiresAt: fixture.access.producer!.expiresAt };
  // This is the initial insertion of a distinct capability, never an expiry update.
  fixture.access.alternate = alternate; await save();
  await pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,$4)", [tokenHash(alternate.token), alternate.actor.tenantId, alternate.actor, alternate.expiresAt]);
  const other = await h.store.createSession(undefined, "supplier-recovery-native-other:" + randomUUID()); fixture.access.other = await access(other.token, other.actor);
  const samToken = await h.store.createCrewCapability(value.actor, "sam"), sam = (await h.store.getActor(samToken))!; fixture.access.sam = await access(samToken, sam);
  for (const original of [...Object.values(fixture.access), ...Object.values(fixture.originalCapabilities)]) if (digest(await access(original.token, original.actor)) !== digest(original)) throw new Error("An original capability changed during preparation");
  const show = await h.store.getShow(value.actor.tenantId), desk = await h.recovery.readSupplierRecoveryWorkspace(value.authority), rentals = await h.service.readCloseoutWorkspace(value.authority), rental = rentals.rentals.find(item => item.id === value.executionId)!;
  if (show.planVersion !== fixture.original.planVersion || show.approvedPlan?.digest !== fixture.original.planDigest || desk.cards.some(card => card.reference) || desk.requests.some(row => row.expiresAt !== null || row.status !== "applied") || !desk.preview?.ready || rental.verifiedFeeMinor !== 48000 || rental.depositMinor !== 30000 || rental.releasedMinor || rental.returns.length || rental.closeout) throw new Error("The native baseline must retain the actual original plan, fee and hold with all new terms, replacement quotes and approvals still pending");
  const after = await retainedRows(), preserved = Object.keys(before).every(table => digest(after[table]) === digest(before[table]));
  if (!preserved) throw new Error("Previously retained rows changed during this new preparation");
  fixture.baseline = { producerShow: digest(show), otherShow: digest(await h.store.getShow(other.actor.tenantId)), originalExecution: digest(show.rentalExecutions!.find(item => item.id === value.executionId)), paymentIntents: digest(await h.payments.listIntents(value.actor.tenantId)), fixedCapabilities: digest({ access: fixture.access, originalCapabilities: fixture.originalCapabilities }) };
  await writeFile(directory + "/prior-controlled-rows-preserved.json", JSON.stringify({ priorTenants: priorTenants.length, before, after, preserved }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await writeFile(directory + "/controlled-sdk-provenance.json", JSON.stringify({ original: fixture.original, actualProviderRequests: 0, provider: "Installed SandboxPayPalProvider over RetainedRentalWire", coreVersion: JSON.parse(await readFile("node_modules/@fracture/paypal-core/package.json", "utf8")).version, calls: h.wire.calls, controlledResources: [...h.wire.orders], declaration: "Initial RFQ, actual Bryntum candidates, separate plan approval, rental, delivery and inspection use real application services. Provider responses and physical observations are explicitly controlled fixtures. No replacement snapshot is supplied. Fresh terms, replacement collection, engine run, approval and hold remain unperformed." }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fixture.state = "ready"; await save();
  const publicSummary = { state: fixture.state, origin: fixture.origin, fixedExpiries: Object.fromEntries(Object.entries(fixture.access).map(([name, value]) => [name, value.expiresAt])), initialPlanVersion: show.planVersion, initialPlanEngine: "Actual installed Bryntum candidates followed by separate producer approval", originalFeeMinor: rental.verifiedFeeMinor, originalHoldMinor: rental.depositMinor, releasedMinor: rental.releasedMinor, freshSupplierEditions: 0, replacementQuoteCollections: 0, replacementPlanApproved: false, replacementSnapshotSupplied: false, priorTenantsPreserved: priorTenants.length, actualProviderRequests: 0, actualPhysicalHandoffs: 0, noResetReseedOrRenewal: true };
  await writeFile(directory + "/public-summary.json", JSON.stringify(publicSummary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ fixture: path, ...publicSummary }));
} catch (error) {
  fixture.state = "failed"; fixture.failures.push({ at: new Date().toISOString(), message: error instanceof Error ? error.message : "Controlled setup failed" }); await save(); throw error;
} finally { if (harness) await harness.close(); else await pool.end(); }
