/** One fresh, declared controlled fixture through actual services; never replay a prior preparation. */
import "./supplier-admin-runtime.mjs";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import type { Actor } from "../../src/domain/contracts";
import { digest } from "../../src/domain/hash";
import { supplierAdminHarness } from "../../tests/supplier-admin-harness";
const mode = process.argv.includes("--http") ? "http" : "native", directory = `.private/supplier-admin/${mode}`, path = directory + "/fixture.json";
await mkdir(directory, { recursive: true, mode: 0o700 });
if (existsSync(path)) throw new Error("The original supplier preparation exists. Retain it; no reset, reseed, renewal or replacement is supported.");
type Access = { token: string; actor: Actor; expiresAt: string };
const fixture: { version: number; state: string; mode: string; createdAt: string; origin: string; cookie: string; bootstrapKey: string; sourceCommit: string; access: Record<string, Access>; original: unknown; supplierId: string | null; journal: unknown[]; failures: unknown[]; baseline?: unknown } = {
  version: 1, state: "preparing", mode, createdAt: new Date().toISOString(), origin: "http://127.0.0.1:4619", cookie: "opening-night-ai-qa-session", bootstrapKey: randomBytes(32).toString("base64url"),
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), access: {}, original: null, supplierId: null, journal: [], failures: [],
};
await writeFile(path, JSON.stringify(fixture, null, 2) + "\n", { flag: "wx", mode: 0o600 });
async function save() { await writeFile(path + ".next", JSON.stringify(fixture, null, 2) + "\n", { mode: 0o600 }); await rename(path + ".next", path); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let harness: Awaited<ReturnType<typeof supplierAdminHarness>> | undefined;
try {
  harness = await supplierAdminHarness({ database: { schema: "supplier_admin_runtime", pool, close: async () => { await pool.end(); } }, onStep: async (step, value) => {
    const name = `${fixture.journal.length + 1}-${step}.json`; await writeFile(directory + "/" + name, JSON.stringify({ at: new Date().toISOString(), step, value }, null, 2) + "\n", { flag: "wx", mode: 0o600 }); fixture.journal.push({ step, file: name }); await save();
  } });
  const h = harness;
  async function access(token: string, actor: Actor): Promise<Access> {
    const row = (await pool.query<{ expiry: string }>(`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expiry FROM on_sessions WHERE token_hash=$1 AND tenant_id=$2 AND actor=$3::jsonb`, [h.sessionTokenHash(token), actor.tenantId, actor])).rows[0];
    if (!row) throw new Error("The exact original controlled capability is absent"); return { token, actor, expiresAt: row.expiry };
  }
  const previous = (await pool.query("SELECT tenant_id FROM on_shows ORDER BY tenant_id")).rows.map(row => row.tenant_id as string);
  async function snapshot(tenants: string[]) {
    const names = (await pool.query("SELECT table_name FROM information_schema.columns WHERE table_schema='supplier_admin_runtime' AND column_name='tenant_id' ORDER BY table_name")).rows.map(row => row.table_name as string), records: Record<string, { rows: number; digest: string }> = {};
    for (const name of names) { if (!/^[a-z_]+$/.test(name)) throw new Error("Unexpected supplier audit table"); const rows = (await pool.query(`SELECT to_jsonb(t) AS row FROM "${name}" t WHERE tenant_id::text=ANY($1::text[]) ORDER BY to_jsonb(t)::text`, [tenants])).rows.map(row => row.row); records[name] = { rows: rows.length, digest: digest(rows) }; } return records;
  }
  const before = await snapshot(previous); await writeFile(directory + "/prior-before.json", JSON.stringify({ tenants: previous, records: before }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const original = await h.accepted({ replacePlan: false, captureFee: true });
  fixture.access.producer = await access(original.token, original.actor); fixture.access.originalSupplier = await access(original.supplierToken, original.supplierAuthority.actor);
  fixture.original = { executionId: original.executionId, rootIntentId: original.root.id, orderId: original.orderId, feeIntentId: original.feeIntentId, wireRunId: h.wire.runId, planVersion: original.original.planVersion, planDigest: original.original.approvedPlan!.digest, originalMoneyDigest: digest(original.original.financialEvidence), originalExecutionDigest: digest(original.original.rentalExecutions!.find(value => value.id === original.executionId)) }; await save();
  const owner = await h.invite(original.authority); fixture.access.owner = await access(owner.token, owner.actor); fixture.supplierId = owner.supplierId; await save();
  const alternateToken = randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,$4)", [h.sessionTokenHash(alternateToken), original.actor.tenantId, original.actor, fixture.access.producer.expiresAt]);
  fixture.access.alternate = await access(alternateToken, original.actor);
  const other = await h.store.createSession(undefined, "supplier-admin-qualification-other:" + randomUUID()); fixture.access.other = await access(other.token, other.actor);
  const show = await h.store.getShow(original.actor.tenantId), desk = await h.admin.readSupplierAdminWorkspace(original.authority);
  if (desk.cards.length !== 1 || desk.cards[0]!.status !== "invited" || desk.cards[0]!.key || desk.cards[0]!.units.length || desk.cards[0]!.mandates.length || desk.cards[0]!.rfqs.length || digest(show.financialEvidence) !== digest(original.original.financialEvidence) || digest(show.rentalExecutions!.find(value => value.id === original.executionId)) !== digest(original.original.rentalExecutions!.find(value => value.id === original.executionId))) throw new Error("The controlled native baseline must retain original money and leave every supplier-owned action pending");
  for (const value of Object.values(fixture.access)) if (digest(await access(value.token, value.actor)) !== digest(value)) throw new Error("An original fixed capability changed during preparation");
  const after = await snapshot(previous); if (digest(before) !== digest(after)) throw new Error("Earlier controlled tenants changed during this separate preparation");
  fixture.baseline = { production: digest(show), originalMoney: digest(show.financialEvidence), originalExecution: digest(show.rentalExecutions!.find(value => value.id === original.executionId)), priorRows: before, accessDigest: digest(fixture.access) };
  await writeFile(directory + "/controlled-sdk-provenance.json", JSON.stringify({ actualProviderRequests: 0, actualModelRequests: 0, realEngine: true, suppliedReplacementSnapshot: false, declaration: "The initial original Brightline RFQ, actual engine, separate approval, installed-SDK controlled authorization/capture, controlled handoff and inspection are real application-service actions. Their provider responses, identity and physical observations are declared controlled data. No actual PayPal transaction, person, physical work or merchant receipt is claimed. The new managed supplier has only an invitation; admission/key/inventory/terms/mandates/negotiation remain pending.", calls: h.wire.calls, resources: [...h.wire.orders] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fixture.state = "ready"; await save();
  const summary = { state: fixture.state, mode, origin: fixture.origin, sourceCommit: fixture.sourceCommit, fixedExpiries: Object.fromEntries(Object.entries(fixture.access).map(([name, value]) => [name, value.expiresAt])), supplierAdmission: "pending", managedKeys: 0, managedUnits: 0, managedRfqs: 0, originalControlledFeeMinor: 48000, originalControlledDepositMinor: 30000, actualProviderCalls: 0, actualModelCalls: 0, actualPhysicalHandoffs: 0, priorTenantsPreserved: previous.length, noResetReseedOrRenewal: true };
  await writeFile(directory + "/summary.json", JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 }); console.log(JSON.stringify(summary));
} catch (error) { fixture.state = "failed"; fixture.failures.push({ at: new Date().toISOString(), message: error instanceof Error ? error.message : "Controlled preparation failed" }); await save(); throw error; }
finally { if (harness) await harness.close(); else await pool.end(); }
