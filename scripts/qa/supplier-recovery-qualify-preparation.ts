/** Inspect the original completed setup after its final RFQ-count assertion failed. No DB writes or replay. */
import "./supplier-recovery-disabled-providers.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { digest } from "../../src/domain/hash";
import { financialSummary } from "../../src/domain/finance";
import { rentalExecutionDigest } from "../../src/domain/rental-closeout";
import { sessionTokenHash } from "../../src/server/session-records";
import type { Actor, ShowSnapshot } from "../../src/domain/contracts";

const directory = ".artifacts/supplier-recovery-native-4586", bytes = await readFile(directory + "/fixture.json"), fixture = JSON.parse(bytes.toString());
assert.equal(fixture.state, "failed"); assert.equal(fixture.failures.length, 1); assert.match(fixture.failures[0].message, /^The native baseline must retain the actual original plan/);
const database = new URL(process.env.DATABASE_URL!);
assert.equal(database.hostname, "127.0.0.1"); assert.equal(database.port, "55575"); assert.equal(database.pathname, "/" + fixture.database); assert.equal(fixture.schema, "terms_runtime");
const pool = new Pool({ connectionString: database.href, max: 1 }), client = await pool.connect();
try {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const scope = (await client.query("SELECT current_database() AS database,current_schema() AS schema,current_setting('transaction_read_only') AS readonly")).rows[0];
  assert.equal(scope.database, fixture.database); assert.equal(scope.schema, fixture.schema); assert.equal(scope.readonly, "on");
  const fixedCapabilities = [];
  for (const [name, access] of Object.entries({ ...fixture.access, driver: fixture.originalCapabilities.driver, inspector: fixture.originalCapabilities.inspector }) as [string, { token: string; actor: Actor; expiresAt: string }][]) {
    const row = (await client.query("SELECT actor,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS expires_at FROM on_sessions WHERE token_hash=$1", [sessionTokenHash(access.token)])).rows[0];
    assert.ok(row); assert.equal(digest(row.actor), digest(access.actor)); assert.equal(row.expires_at, access.expiresAt); assert.ok(Date.parse(row.expires_at) > Date.now());
    fixedCapabilities.push({ persona: name, actorDigest: digest(row.actor), expiresAt: row.expires_at });
  }
  assert.equal(fixedCapabilities.length, 8);
  const show = (await client.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1", [fixture.access.producer.actor.tenantId])).rows[0]!.snapshot;
  assert.equal(show.planVersion, fixture.original.planVersion); assert.equal(show.approvedPlan!.digest, fixture.original.planDigest); assert.equal(show.rentalExecutions!.length, 1); assert.equal(show.supplierTermRevisions?.length ?? 0, 0);
  const rental = show.rentalExecutions![0]!, money = financialSummary(show);
  assert.equal(rental.id, fixture.original.executionId); assert.equal(rental.paymentRootId, fixture.original.rootIntentId); assert.equal(rental.captureIntentId, fixture.original.feeIntentId); assert.equal(rental.state, "needs_attention"); assert.ok(rental.acceptedAt);
  assert.equal(money.rentalCapturedMinor, 48000); assert.equal(money.remainingRentalAuthorizationMinor, 30000); assert.equal(money.releasedMinor, 0);
  const counts: Record<string, number> = {};
  for (const table of ["on_supplier_terms", "on_supplier_recovery_rfqs", "on_rental_return_records", "on_rental_closeout_grants"]) { counts[table] = (await client.query(`SELECT count(*)::int AS count FROM "${table}" WHERE tenant_id=$1`, [show.tenantId])).rows[0].count; assert.equal(counts[table], 0); }
  const initialStep = fixture.journal.find((item: { step: string }) => item.step === "rfq-intent"), initial = JSON.parse(await readFile(initialStep.path, "utf8")).value;
  const rfqs = (await client.query("SELECT id,status,quote_ids,outcomes FROM on_supplier_rfqs WHERE tenant_id=$1", [show.tenantId])).rows;
  assert.equal(rfqs.length, 1); assert.equal(rfqs[0].id, initial.rfqId); assert.equal(rfqs[0].status, "applied"); assert.equal(rfqs[0].quote_ids.length, 3);
  const operations = (await client.query("SELECT id,status,provider_request_id,payload_hash,document FROM paycore_operations WHERE tenant_id=$1 ORDER BY id", [show.tenantId])).rows;
  assert.ok(operations.length > 0); assert.ok(operations.every(row => row.status === "succeeded"));
  const intents = (await client.query("SELECT document FROM on_payment_intents WHERE tenant_id=$1 ORDER BY id", [show.tenantId])).rows.map(row => row.document);
  const initialCandidates = JSON.parse(await readFile(fixture.journal.find((item: { step: string }) => item.step === "original-plan-candidates").path, "utf8")).value;
  assert.equal(initialCandidates.length, 12); assert.equal(initialCandidates.find((item: { id: string }) => item.id.startsWith("doors-brightline")).report.engine.status, "passed");
  const prior = JSON.parse(await readFile(directory + "/prior-controlled-rows-before.json", "utf8")); assert.equal(prior.priorTenants, 0);
  const other = (await client.query("SELECT snapshot FROM on_shows WHERE tenant_id=$1", [fixture.access.other.actor.tenantId])).rows[0].snapshot;
  const qualified = { state: "ready_from_readonly_inspection", at: new Date().toISOString(), fixtureSha256: createHash("sha256").update(bytes).digest("hex"), originalPreparationState: fixture.state, originalFailureRetained: fixture.failures[0], explanation: "The sole final assertion counted the already-applied initial RFQ as new replacement work. Its original ID and three quotes remain present; new supplier terms and replacement RFQs are absent. No setup instruction was repeated.", databaseMutations: 0, originalExpiriesUnchanged: true, fixedCapabilities, original: fixture.original, initialRfq: { id: initial.rfqId, status: rfqs[0].status, quotes: 3 }, freshRecordCounts: counts, money, snapshots: { producerShow: digest(show), otherShow: digest(other), originalExecution: rentalExecutionDigest(rental), financialEvidence: digest(show.financialEvidence), paymentIntents: digest(intents), paymentOperations: digest(operations) }, providerRequests: 0, noReseedReplayOrRenewal: true };
  await client.query("COMMIT");
  await writeFile(directory + "/retained-controlled-operations.json", JSON.stringify({ provenance: "Original installed SDK over the controlled RetainedRentalWire; no actual provider or physical event. SQL operations and setup journals are retained. The transient wire-call array was not exported before the final preparation assertion failed; it is not recreated.", operations, intents }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await writeFile(directory + "/preparation-qualified.json", JSON.stringify(qualified, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ state: qualified.state, fixedCapabilities: fixedCapabilities.length, initialRfqQuotes: 3, freshTerms: 0, replacementRfqs: 0, databaseMutations: 0, originalFeeMinor: money.rentalCapturedMinor, remainingHoldMinor: money.remainingRentalAuthorizationMinor }));
} catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
finally { client.release(); await pool.end(); }
