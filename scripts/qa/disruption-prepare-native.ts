/** Owned local planning declarations only. Never seed payment receipts or personal/physical sign-offs. */
import "./disruption-disabled-providers.mjs";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import type { Actor } from "../../src/domain/contracts";
import type { DisruptionEnvelope } from "../../src/domain/disruptions";
import { applyCommand } from "../../src/domain/commands";
import { digest } from "../../src/domain/hash";
import { migrate, pool, getActor, getShow, transactCommand } from "../../src/server/store";
import { insertProducerRehearsal, sessionTokenHash } from "../../src/server/session-records";
import { executeDisruptionCommand, readDisruptionWorkspace } from "../../src/server/disruptions/service";

const directory = ".artifacts/disruption-native-4564", path = `${directory}/fixture.json`;
const guard = (globalThis as typeof globalThis & { openingNightProviderEgressGuard?: { version: number } }).openingNightProviderEgressGuard;
if (process.env.VERCEL || process.env.OPENING_NIGHT_DISRUPTION_QA !== "1" || guard?.version !== 2) throw new Error("Exact provider-disabled local disruption runtime required");
const url = new URL(process.env.DATABASE_URL!);
if (url.hostname !== "127.0.0.1" || url.port !== "55564" || !/^\/opening_disruption_[a-f0-9]{12}$/.test(url.pathname)) throw new Error("Only the newly owned stage14 cluster may be used");
await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
type Access = { token: string; actor?: Actor; expiresAt: string };
type Fixture = {
  version: 1; state: "preparing" | "ready" | "failed"; createdAt: string; origin: string; cookie: string;
  database: string; schema: string; bootstrapKey: string; access: Record<"producer" | "support" | "other" | "supplier" | "sam", Access>;
  initialCommands: Partial<Record<"producer" | "support", { id: string; expectedRevision: number }>>;
  steps: Record<string, { envelope: DisruptionEnvelope; receipt?: unknown }>;
  baseline?: Record<string, { showDigest: string; workspaceDigest: string }>;
  failures: { at: string; message: string }[];
};
let fixture: Fixture;
if (existsSync(path)) {
  fixture = JSON.parse(await readFile(path, "utf8"));
  if (fixture.state === "ready") throw new Error("This fixture is frozen. No reset, reseed or expiry extension is allowed.");
  if (!process.argv.includes("--resume")) throw new Error("An original preparation intent exists. Review it before resuming only its saved identities.");
} else {
  const createdAt = new Date().toISOString(), expiresAt = new Date(Date.parse(createdAt) + 7 * 86400000).toISOString();
  fixture = { version: 1, state: "preparing", createdAt, origin: "http://127.0.0.1:4564", cookie: "opening-night-disruption-4564-session", database: url.pathname.slice(1), schema: "disruption_runtime", bootstrapKey: randomBytes(32).toString("base64url"), access: Object.fromEntries(["producer", "support", "other", "supplier", "sam"].map(name => [name, { token: randomBytes(32).toString("base64url"), expiresAt }])) as Fixture["access"], initialCommands: {}, steps: {}, failures: [] };
  await writeFile(path, JSON.stringify(fixture, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
const save = async () => { await writeFile(path + ".next", JSON.stringify(fixture, null, 2) + "\n", { mode: 0o600 }); await rename(path + ".next", path); };
try {
  await migrate();
  const scope = (await pool.query("SELECT current_database() AS db,current_schema() AS schema,current_user AS role")).rows[0];
  if (scope.db !== fixture.database || scope.schema !== fixture.schema) throw new Error("Original fixture DB/schema does not match its saved intent");
  for (const name of ["producer", "support", "other"] as const) {
    const access = fixture.access[name]; let actor = await getActor(access.token);
    if (!actor) {
      if (access.actor) throw new Error("An original producer capability ended; it cannot be extended or replaced");
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        const created = await insertProducerRehearsal(db, access.token, `disruption-native-4564:${fixture.createdAt}:${name}`);
        await db.query("UPDATE on_sessions SET expires_at=$2 WHERE token_hash=$1", [sessionTokenHash(access.token), access.expiresAt]);
        await db.query("COMMIT"); actor = created.actor;
      } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    }
    access.actor = actor; await save();
  }
  for (const name of ["supplier", "sam"] as const) {
    const access = fixture.access[name];
    if (!access.actor) { access.actor = name === "supplier" ? { id: `supplier:brightline:${randomUUID()}`, tenantId: fixture.access.producer.actor!.tenantId, roles: ["supplier"], supplierId: "brightline", personId: null } : { id: `crew:sam:${randomUUID()}`, tenantId: fixture.access.producer.actor!.tenantId, roles: ["crew"], personId: "sam" }; await save(); }
    const actor = access.actor!;
    await pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(token_hash) DO NOTHING", [sessionTokenHash(access.token), actor.tenantId, actor, access.expiresAt]);
  }
  for (const access of Object.values(fixture.access)) {
    const row = (await pool.query("SELECT actor,expires_at FROM on_sessions WHERE token_hash=$1", [sessionTokenHash(access.token)])).rows[0];
    if (!await getActor(access.token) || digest(row.actor) !== digest(access.actor) || row.expires_at.toISOString() !== access.expiresAt) throw new Error("An original capability or fixed expiry changed; it cannot be reset");
  }
  for (const name of ["producer", "support"] as const) {
    const access = fixture.access[name], authority = { actor: access.actor!, sessionHash: sessionTokenHash(access.token) };
    if (!fixture.initialCommands[name]) { fixture.initialCommands[name] = { id: randomUUID(), expectedRevision: (await getShow(authority.actor.tenantId)).revision }; await save(); }
    const initial = fixture.initialCommands[name]!;
    await transactCommand(authority.actor, initial.id, initial.expectedRevision, { type: "load_incidents" }, show => applyCommand(show, authority.actor, { type: "load_incidents" }));
    const step = async (label: string, make: (show: Awaited<ReturnType<typeof getShow>>) => DisruptionEnvelope["command"]) => {
      const key = `${name}:${label}`;
      if (!fixture.steps[key]) { const show = await getShow(authority.actor.tenantId); fixture.steps[key] = { envelope: { idempotencyKey: randomUUID(), expectedRevision: show.revision, command: make(show) } }; await save(); }
      const result = await executeDisruptionCommand(authority, fixture.steps[key]!.envelope);
      fixture.steps[key]!.receipt = result.receipt; await save();
    };
    for (const supplierId of name === "producer" ? ["brightline", "northside", "sister"] : ["brightline"]) await step(`report-${supplierId}`, show => {
      const offer = show.offers.find(item => item.supplierId === supplierId)!;
      return { type: "report", offerId: offer.id, offerRevision: offer.revision, executionId: null, availability: "unavailable", earliestAt: null, observedAt: fixture.createdAt, reference: "Owned synthetic planning declaration", detail: "Fictional rehearsal input: this unit is declared unavailable. No actual supplier communication, physical failure or financial commitment is claimed.", confirmed: true };
    });
    await step("assessment", () => ({ type: "assess" }));
  }
  fixture.baseline = {};
  const productions = [];
  for (const name of ["producer", "support", "other"] as const) {
    const access = fixture.access[name], show = await getShow(access.actor!.tenantId), workspace = await readDisruptionWorkspace({ actor: access.actor!, sessionHash: sessionTokenHash(access.token) });
    if (show.financialEvidence.length || show.tickets.length || show.facts.length || show.acknowledgments.length || show.crewAttestations?.length || show.crewCues?.length || show.cancellationDecision || show.rentalExecutions?.length) throw new Error("Native planning preparation must not seed money, physical actions, personal decisions or operating approvals");
    fixture.baseline[name] = { showDigest: digest(show), workspaceDigest: digest(workspace) };
    productions.push({ persona: name, tenantId: show.tenantId, revision: show.revision, reports: workspace.reports.length, assessment: workspace.assessments.at(-1) ?? null });
  }
  fixture.state = "ready"; await save();
  await writeFile(`${directory}/public-summary.json`, JSON.stringify({ state: "ready", origin: fixture.origin, source: "Owned fictional planning declarations, actual local bounded Bryntum evaluation", actualProviderCalls: 0, paymentReceiptsSeeded: 0, physicalSignoffsSeeded: 0, personalReadbacksSeeded: 0, operatingDecisionsSeeded: 0, productions, originalExpiry: Object.fromEntries(Object.entries(fixture.access).map(([name, access]) => [name, access.expiresAt])) }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ state: "ready", privateFixture: path, origin: fixture.origin, personas: Object.keys(fixture.access), fixedExpiry: fixture.access.producer.expiresAt, paymentReceiptsSeeded: 0, physicalSignoffsSeeded: 0 }));
} catch (error) {
  fixture.state = "failed"; fixture.failures.push({ at: new Date().toISOString(), message: error instanceof Error ? error.message : "Fixture preparation failed" }); await save(); throw error;
} finally { await pool.end(); }
