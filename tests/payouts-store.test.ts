/** Isolated PostgreSQL and the pinned REST core's controlled wire transport; no actual provider qualification. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedDatabase } from "./isolated-database";
import { createPayoutWireFixture } from "../scripts/qa/payout-wire-fixture.mjs";
import { atVenue } from "../src/domain/time";
import { digest } from "../src/domain/hash";
import { financialSummary } from "../src/domain/finance";
import { payoutEnvelopeSchema, type PayoutCommand, type PayoutData, type PayoutEnvelope } from "../src/domain/payouts/contracts";
import type { ProductionSettlementData, SettlementCommand } from "../src/domain/settlement/contracts";
import { sourceApplicationBlock } from "../src/server/sources/validation";

const database = await isolatedDatabase(), store = await import("../src/server/store"), settlement = await import("../src/server/settlement/service"), service = await import("../src/server/payouts/service"), storage = await import("../src/server/payouts/store"), provider = await import("../src/server/payouts/provider"), worker = await import("../src/server/payouts/worker"), locks = await import("../src/server/commerce-locks"), jobs = await import("../src/server/jobs"), runner = await import("../src/server/job-runner");
const { sessionTokenHash } = await import("../src/server/session-records"), { openIntelligence } = await import("../src/server/intelligence/private-payload");
const producerRoute = await import("../src/app/api/payouts/route"), personalRoute = await import("../src/app/api/crew/payouts/route"), workRoute = await import("../src/app/api/payouts/work/route");
after(async () => { await locks.closeCommerceLocks(); await database.close(); });
const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === wanted);
const signal = () => AbortSignal.timeout(10000);
type Fixture = ReturnType<typeof createPayoutWireFixture>;
async function fresh(wire = createPayoutWireFixture()) {
  provider.installPayoutFixture(wire as unknown as import("../src/server/payouts/provider").PayoutFixtureRuntime);
  const session = await store.createSession(undefined, "payout:" + randomUUID()), token = await store.createCrewCapability(session.actor, "priya"), actor = (await store.getActor(token))!;
  const producer = { actor: session.actor, sessionHash: sessionTokenHash(session.token), scope: "production" as const }, personal = { actor, sessionHash: sessionTokenHash(token), scope: "personal" as const };
  return { wire, session, producer, personal, token };
}
type Workspace = Awaited<ReturnType<typeof fresh>>;
async function settlementCommand(value: Workspace, command: SettlementCommand, personId = "priya") {
  let authority = value.producer as import("../src/server/settlement/service").SettlementAuthority;
  if (command.type === "report_time") { const token = personId === "priya" ? value.token : await store.createCrewCapability(value.session.actor, personId); authority = { actor: (await store.getActor(token))!, sessionHash: sessionTokenHash(token), scope: "personal" }; }
  const data = await settlement.readSettlement(authority);
  return settlement.executeSettlement(authority, { idempotencyKey: randomUUID(), expectedRevision: data.revision, expectedShowRevision: data.productionRevision, command });
}
async function payable(value: Workspace, personId = "priya") {
  const sheet = value.session.show.sheets.at(-1)!;
  await settlementCommand(value, { type: "approve_rate", personId, previousRateId: null, effectiveFrom: "2026-11-14", currency: "USD", hourlyMinor: 3500, overtimeHourlyMinor: 5250, regularMinutes: 480, agreement: "Explicit controlled fixture rate agreement.", confirmed: true });
  await settlementCommand(value, { type: "report_time", serviceDay: "2026-11-14", replacesId: null, sheetVersion: sheet.version, sheetDigest: sheet.digest, intervals: [{ start: atVenue("11:30"), end: atVenue("12:30"), unpaidMinutes: 0 }], detail: "Personally reported fictional lighting work.", confirmed: true }, personId);
  const data = await settlement.readSettlement(value.producer) as ProductionSettlementData, review = data.people.find(item => item.person.id === personId)!.reports[0].preview!;
  return settlementCommand(value, { type: "approve_payable", reportId: review.reportId, rateId: review.rateId, reviewDigest: review.digest, detail: "Reviewed exact fictional hours, rate and liability.", reviewedHours: true, reviewedRate: true, reviewedAdjustment: true });
}
async function envelope(value: Workspace, command: PayoutCommand): Promise<PayoutEnvelope> { const data = await service.readPayouts(value.producer); return { idempotencyKey: randomUUID(), expectedRevision: data.revision, expectedSettlementRevision: data.settlementRevision, expectedShowRevision: data.productionRevision, command }; }
async function execute(value: Workspace, command: PayoutCommand) { return service.executePayout(value.producer, await envelope(value, command)); }
async function recipient(value: Workspace, personId = "priya", unclaimed = false) {
  const data = await service.readPayouts(value.producer), admission = data.admissions.find(item => item.personId === personId && item.receiver.startsWith("unclaimed.") === unclaimed)!;
  return execute(value, { type: "approve_recipient", personId, previousId: data.people.find(item => item.person.id === personId)!.recipients.at(-1)?.id ?? null, admissionId: admission.id, admissionDigest: admission.digest, detail: "Reviewed this exact owned controlled sandbox recipient.", reviewedRecipient: true });
}
async function approve(value: Workspace, personIds = ["priya"]) {
  const { data, review } = await service.readPayoutReview(value.producer, personIds);
  assert.deepEqual(review.blockers, []);
  const original = await envelope(value, { type: "approve_payout", personIds, reviewDigest: review.digest, detail: "  Reviewed exact recipient, liability, credits and separate fees. ", reviewedAmounts: true, reviewedRecipients: true, reviewedCredits: true, reviewedFees: true });
  assert.equal(data.revision, original.expectedRevision);
  const result = await service.executePayout(value.producer, original);
  return { original, result, grantId: result.receipt.id };
}
async function ready(unclaimed = false) { const value = await fresh(); await payable(value); await recipient(value, "priya", unclaimed); return value; }
async function finish(value: Workspace, grantId: string) {
  await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId }, signal());
  const itemJobs = (await jobs.listJobs(value.producer.actor.tenantId)).filter(job => job.kind === "payout_item" && job.payload.grantId === grantId);
  for (const job of itemJobs) await worker.runPayoutJob(value.producer.actor.tenantId, "payout_item", job.payload as { grantId: string; senderItemId: string; batchReadId: string }, signal());
  return service.readPayouts(value.producer);
}
const writes = (wire: Fixture) => wire.calls.filter(call => call.method === "POST");
function request(token: string | null, body?: unknown, extra: { origin?: string; cookie?: string; raw?: string } = {}) {
  const origin = "http://localhost:4528", headers = new Headers({ origin: extra.origin ?? origin, "content-type": "application/json" });
  if (token) headers.set("authorization", "Bearer " + token); if (extra.cookie) headers.set("cookie", "opening-night-session=" + extra.cookie);
  return new Request(origin + "/api/payouts", { method: body === undefined && extra.raw === undefined ? "GET" : "POST", headers, ...(body !== undefined || extra.raw !== undefined ? { body: extra.raw ?? JSON.stringify(body) } : {}) });
}

test("strict admission and normalized replay bind the complete instruction before one concurrent dispatch", async () => {
  let durable = false;
  const wire = createPayoutWireFixture({ beforeCall: async call => { if (call.method === "POST") durable = Boolean((await database.pool.query("SELECT id FROM on_payout_records WHERE kind='dispatch' AND semantic_key=$1", [call.requestId])).rowCount); } });
  const value = await fresh(wire); await payable(value); await recipient(value);
  const { review } = await service.readPayoutReview(value.producer, ["priya"]), original = await envelope(value, { type: "approve_payout", personIds: ["priya"], reviewDigest: review.digest, detail: "  Exact reviewed recipient and USD liability. ", reviewedAmounts: true, reviewedRecipients: true, reviewedCredits: true, reviewedFees: true });
  const [a, b] = await Promise.all([service.executePayout(value.producer, original), service.executePayout(value.producer, original)]);
  assert.deepEqual(a.receipt, b.receipt); assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]); assert.equal(a.receipt.requestDigest, digest(payoutEnvelopeSchema.parse(original)));
  if (original.command.type !== "approve_payout") throw new Error("Expected reviewed payout");
  await assert.rejects(service.executePayout(value.producer, { ...original, command: { ...original.command, detail: "Changed meaning in a previously reviewed request." } }), code("IDEMPOTENCY_CONFLICT"));
  await Promise.allSettled([worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: a.receipt.id }, signal()), worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: a.receipt.id }, signal())]);
  assert.equal(writes(wire).length, 1); assert.equal(durable, true); const call = writes(wire)[0]; assert.equal(call.requestId, a.receipt.id); assert.equal(call.body.sender_batch_header.sender_batch_id, "opening-night-" + a.receipt.id); assert.equal(call.body.items[0].amount.value, "35.00"); assert.deepEqual(Object.keys(call.body).sort(), ["items", "sender_batch_header"]);
  const data = await finish(value, a.receipt.id); assert.equal(data.grants[0].items[0].status, "SUCCESS"); assert.equal(data.totals.currentPaidMinor, 3500); assert.equal(data.totals.observedFeeMinor, 25); assert.equal(data.grants[0].items[0].transport, "local_fixture");
  const show = await store.getShow(value.producer.actor.tenantId); assert.equal(show.financialEvidence.length, 0); assert.equal(financialSummary(show).crewPaidMinor, 0); assert.match(sourceApplicationBlock(show)!, /payout history/);
  for (const key of ["tasks", "dependencies", "resources", "sheets", "acknowledgments", "facts", "tickets", "state", "crewAttestations", "crewCues"] as const) assert.deepEqual(show[key], value.session.show[key]);
});
test("unknown create and an unavailable original ID retain the allocation and never re-POST", async () => {
  const value = await ready(), approved = await approve(value); value.wire.behavior.lostCreate = true;
  assert.equal((await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal())).status, "needs_attention");
  for (let i = 0; i < 3; i++) await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal());
  let data = await service.readPayouts(value.producer); assert.equal(data.totals.reservedMinor, 3500); assert.equal(data.grants[0].canLocate, true); assert.equal(data.grants[0].canRevoke, false); assert.equal(data.people.find(person => person.person.id === "priya")!.preview, null); assert.equal(writes(value.wire).length, 1);
  await execute(value, { type: "locate_original", grantId: approved.grantId, batchId: "WRONG-OWNED-CANDIDATE", detail: "Checking a reviewed candidate without any replacement transfer.", confirmed: true });
  await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal());
  data = await service.readPayouts(value.producer); assert.equal(data.grants[0].canLocate, true); assert.equal(data.grants[0].batchVerified, false);
  const batchId = [...value.wire.batches.keys()][0] as string;
  await execute(value, { type: "locate_original", grantId: approved.grantId, batchId, detail: "Reviewed original controlled batch identity for GET-only recovery.", confirmed: true });
  data = await finish(value, approved.grantId); assert.equal(data.totals.currentPaidMinor, 3500); assert.equal(writes(value.wire).length, 1); assert.equal(data.grants[0].providerBatchId, batchId);
});
test("partial batch and foreign item reads cannot qualify payment or release an allocation", async () => {
  const value = await ready(), approved = await approve(value); await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal());
  value.wire.behavior.partialBatch = true; let data = await finish(value, approved.grantId); assert.equal(data.grants[0].batchVerified, false); assert.equal(data.totals.currentPaidMinor, 0); assert.equal(data.totals.reservedMinor, 3500);
  value.wire.behavior.partialBatch = false; await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal());
  value.wire.behavior.foreignReceiver = true;
  const itemJob = (await jobs.listJobs(value.producer.actor.tenantId)).find(job => job.kind === "payout_item")!;
  await worker.runPayoutJob(value.producer.actor.tenantId, "payout_item", itemJob.payload as { grantId: string; senderItemId: string; batchReadId: string }, signal());
  data = await service.readPayouts(value.producer); assert.equal(data.grants[0].items[0].currentVerified, false); assert.equal(data.grants[0].items[0].status, "UNKNOWN"); assert.equal(JSON.stringify(data).includes("other.controlled"), false);
  value.wire.behavior.foreignReceiver = false; data = await finish(value, approved.grantId); assert.equal(data.totals.currentPaidMinor, 3500);
  value.wire.behavior.batchUnavailable = true; data = await finish(value, approved.grantId); assert.equal(data.totals.currentPaidMinor, 0); assert.equal(data.totals.historicalPaidMinor, 3500); assert.equal(data.totals.reservedMinor, 3500); assert.equal(writes(value.wire).length, 1);
});
test("exact-session, production, recipient and pending-work changes hold before the provider boundary", async t => {
  for (const change of ["session", "production", "admission", "correction", "revoked"] as const) await t.test(change, async () => {
    const value = await ready(), approved = await approve(value);
    if (change === "session") await database.pool.query("UPDATE on_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [value.producer.sessionHash]);
    if (change === "production") await database.pool.query("UPDATE on_shows SET revision=revision+1,snapshot=jsonb_set(snapshot,'{revision}',to_jsonb(revision+1)) WHERE tenant_id=$1", [value.producer.actor.tenantId]);
    if (change === "admission") { const admissions = value.wire.admissions; value.wire.admissions = show => admissions(show).map((item: import("../src/server/payouts/provider").PayoutAdmissionInput) => ({ ...item, receiver: "changed.controlled@payout.invalid" })); }
    if (change === "revoked") await execute(value, { type: "revoke_payout", grantId: approved.grantId, detail: "Withdraw this exact instruction before any dispatch.", confirmed: true });
    if (change === "correction") {
      const current = await settlement.readSettlement(value.personal), report = current.scope === "personal" ? current.personal.reports[0].report : null;
      await settlementCommand(value, { type: "report_time", serviceDay: report!.serviceDay, replacesId: report!.id, sheetVersion: report!.sheet.version, sheetDigest: report!.sheet.digest, intervals: [{ start: atVenue("11:30"), end: atVenue("12:00"), unpaidMinutes: 0 }], detail: "Fictional finish correction awaiting independent review.", confirmed: true });
    }
    await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal()); assert.equal(writes(value.wire).length, 0);
    if (change !== "session") { const data = await service.readPayouts(value.producer); assert.equal(data.grants[0].status, change === "revoked" ? "revoked" : "held"); assert.equal(data.totals.currentPaidMinor, 0); }
  });
});
test("batch success qualifies each recipient separately and personal access exposes only its own item", async () => {
  const value = await fresh(); await payable(value); await payable(value, "sam"); await recipient(value); await recipient(value, "sam", true); const approved = await approve(value, ["priya", "sam"]);
  await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal()); const data = await finish(value, approved.grantId);
  assert.equal(data.grants[0].batchStatus, "SUCCESS"); assert.equal(data.grants[0].status, "checking"); assert.equal(data.totals.currentPaidMinor, 3500); assert.equal(data.totals.reservedMinor, 3500); assert.equal(data.totals.observedFeeMinor, 50);
  const samToken = await store.createCrewCapability(value.session.actor, "sam"), response = await personalRoute.GET(request(samToken, undefined, { cookie: value.session.token })), own = await response.json(); assert.equal(response.status, 200); assert.equal(own.items.length, 1); assert.equal(own.items[0].personId, "sam"); assert.equal(JSON.stringify(own).includes("priya"), false); assert.equal(own.items[0].status, "UNCLAIMED");
  const item = data.grants[0].items.find(item => item.personId === "sam")!;
  const cancel = await execute(value, { type: "cancel_unclaimed", grantId: approved.grantId, senderItemId: item.senderItemId, reviewDigest: item.cancelReviewDigest!, detail: "Reviewed this original unclaimed controlled item for cancellation.", confirmed: true });
  value.wire.behavior.lostCancel = true;
  await worker.runPayoutJob(value.producer.actor.tenantId, "payout_cancel", { grantId: approved.grantId, cancellationId: cancel.receipt.id }, signal());
  await worker.runPayoutJob(value.producer.actor.tenantId, "payout_cancel", { grantId: approved.grantId, cancellationId: cancel.receipt.id }, signal());
  const after = await service.readPayouts(value.producer); assert.equal(after.grants[0].items.find(item => item.personId === "sam")!.status, "RETURNED"); assert.equal(after.totals.currentPaidMinor, 3500); assert.equal(after.totals.reservedMinor, 0); assert.equal(value.wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/cancel")).length, 1);
});
test("unknown cancellation is GET-only on continuation and does not create a second cancellation authority", async () => {
  const value = await ready(true), approved = await approve(value); await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal()); const data = await finish(value, approved.grantId), item = data.grants[0].items[0];
  const cancel = await execute(value, { type: "cancel_unclaimed", grantId: approved.grantId, senderItemId: item.senderItemId, reviewDigest: item.cancelReviewDigest!, detail: "Reviewed exactly this unclaimed controlled item.", confirmed: true });
  value.wire.behavior.cancelUnavailable = true;
  await worker.runPayoutJob(value.producer.actor.tenantId, "payout_cancel", { grantId: approved.grantId, cancellationId: cancel.receipt.id }, signal());
  await worker.runPayoutJob(value.producer.actor.tenantId, "payout_cancel", { grantId: approved.grantId, cancellationId: cancel.receipt.id }, signal());
  let current = await service.readPayouts(value.producer); assert.equal(current.grants[0].items[0].cancelReviewDigest, null); assert.equal(current.totals.reservedMinor, 3500); assert.equal(value.wire.calls.filter(call => call.path.endsWith("/cancel")).length, 1);
  const batch = [...value.wire.batches.values()][0]; batch.items[0].transaction_status = "RETURNED";
  await worker.runPayoutJob(value.producer.actor.tenantId, "payout_cancel", { grantId: approved.grantId, cancellationId: cancel.receipt.id }, signal()); current = await service.readPayouts(value.producer); assert.equal(current.grants[0].items[0].status, "RETURNED"); assert.equal(current.people.find(person => person.person.id === "priya")!.availableMinor, 3500); assert.equal(value.wire.calls.filter(call => call.path.endsWith("/cancel")).length, 1);
});
test("generic 422 after dispatch remains uncertain while an authentication refusal proves no transfer", async t => {
  for (const status of [422, 401]) await t.test(String(status), async () => { const value = await ready(), approved = await approve(value); value.wire.behavior.createStatus = status; await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal()); const data = await service.readPayouts(value.producer); assert.equal(data.grants[0].items[0].status, status === 401 ? "NOT_SENT" : "UNKNOWN"); assert.equal(data.totals.reservedMinor, status === 401 ? 0 : 3500); await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal()); assert.equal(writes(value.wire).length, 1); });
});
test("encrypted immutable history, attribution and resource ownership fail closed across tenants", async () => {
  const value = await ready(), approved = await approve(value), row = (await database.pool.query("SELECT * FROM on_payout_records WHERE id=$1", [approved.grantId])).rows[0];
  const record = openIntelligence<import("../src/domain/payouts/contracts").PayoutGrant>(value.producer.actor.tenantId, `payout:v1:${row.id}:record`, row.record_cipher); assert.equal(record.requestDigest, digest(payoutEnvelopeSchema.parse(approved.original))); assert.equal(row.record_cipher.includes("payout.invalid"), false); assert.equal(row.request_cipher.includes("Reviewed"), false);
  assert.throws(() => openIntelligence(randomUUID(), `payout:v1:${row.id}:record`, row.record_cipher)); await assert.rejects(database.pool.query("UPDATE on_payout_records SET kind='recipient' WHERE id=$1", [row.id]), /Immutable payout/); await assert.rejects(database.pool.query("DELETE FROM on_payout_records WHERE id=$1", [row.id]), /Immutable payout/);
  const other = await fresh(value.wire); await assert.rejects(execute(other, { type: "refresh_payout", grantId: approved.grantId }), code("PAYOUT_NOT_FOUND"));
  const replacement = sessionTokenHash("replacement-" + randomUUID()); await database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [replacement, value.producer.actor.tenantId, value.producer.actor]); await assert.rejects(service.executePayout({ ...value.producer, sessionHash: replacement }, approved.original), code("IDEMPOTENCY_CONFLICT"));
  await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal()); await finish(value, approved.grantId);
  await payable(other); await recipient(other); const second = await approve(other), batchId = (await service.readPayouts(value.producer)).grants[0].providerBatchId!;
  await assert.rejects(storage.payoutTransaction(db => storage.bindPayoutResource(db, { merchant: record.merchantFingerprint, kind: "batch", providerId: batchId, tenantId: other.producer.actor.tenantId, grantId: second.grantId })), code("PAYOUT_OWNERSHIP_CONFLICT"));
  await database.pool.query("UPDATE on_payout_state SET revision=revision+1 WHERE tenant_id=$1", [other.producer.actor.tenantId]); await assert.rejects(service.readPayouts(other.producer), code("PAYOUT_INTEGRITY"));
});
test("HTTP roles, origin, bounds and payout-only work cannot wake unrelated financial jobs", async () => {
  const value = await ready(), data = await service.readPayouts(value.producer), admission = data.admissions[0], body = await envelope(value, { type: "approve_recipient", personId: admission.personId, previousId: null, admissionId: admission.id, admissionDigest: admission.digest, detail: "Explicit exact controlled recipient review.", reviewedRecipient: true });
  assert.equal((await producerRoute.GET(request(value.token))).status, 403); assert.equal((await personalRoute.GET(request(value.session.token))).status, 403); assert.equal((await personalRoute.GET(request(null, undefined, { cookie: value.session.token }))).status, 401);
  assert.equal((await producerRoute.POST(request(value.session.token, body, { origin: "https://other.invalid" }))).status, 403); assert.equal((await producerRoute.POST(request(value.session.token, undefined, { raw: "{" }))).status, 400);
  assert.equal((await producerRoute.POST(request(value.session.token, { ...body, receiver: "caller@payout.invalid" }))).status, 400); assert.equal((await producerRoute.POST(request(value.session.token, { ...body, amountMinor: 1 }))).status, 400); assert.equal((await producerRoute.POST(request(value.session.token, { ...body, extra: "x".repeat(21000) }))).status, 413);
  const unrelated = await jobs.enqueueJob(database.pool, { tenantId: value.producer.actor.tenantId, kind: "payment_reconcile", semanticKey: "untouched-finance", payload: { intentId: randomUUID() } });
  await approve(value); const response = await workRoute.POST(request(value.session.token, {})); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal((await jobs.listJobs(value.producer.actor.tenantId)).find(job => job.id === unrelated.id)!.status, "queued"); assert.equal((await database.pool.query("SELECT to_regclass('on_payment_intents') AS name")).rows[0].name, null);
  const remaining = await runner.runJobTick({ tenantId: value.producer.actor.tenantId, kinds: [], handler: async () => { throw new Error("No work is admitted through an empty filter"); } }); assert.equal(remaining.processed, 0);
});
test("a persisted dispatch with no response survives worker restart without a replacement POST", async () => {
  const value = await ready(), approved = await approve(value);
  await storage.payoutTransaction(async db => {
    const show = await storage.payoutShow(db, value.producer.actor.tenantId, true), state = await storage.readPayoutState(db, show), grant = state.records.find(record => record.id === approved.grantId)!;
    if (grant.kind !== "grant") throw new Error("Expected original grant");
    await storage.appendPayoutRecord(db, show, state, { kind: "dispatch", grantId: grant.id, providerRequestDigest: digest(grant.request) }, { request: grant.request, semanticKey: grant.id });
  });
  const resumed = await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal());
  assert.equal(resumed.status, "needs_attention"); assert.equal(writes(value.wire).length, 0);
  const data = await service.readPayouts(value.producer); assert.equal(data.grants[0].canRevoke, false); assert.equal(data.grants[0].canLocate, true); assert.equal(data.totals.reservedMinor, 3500);
});
test("the core's duplicate response recovers only the exact original batch and item collection", async () => {
  const value = await ready(), approved = await approve(value); value.wire.behavior.duplicateCreate = true;
  await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal());
  const data = await finish(value, approved.grantId); assert.equal(data.totals.currentPaidMinor, 3500); assert.equal(writes(value.wire).length, 1);
  const original = await storage.payoutTransaction(async db => { const show = await storage.payoutShow(db, value.producer.actor.tenantId); return storage.readPayoutState(db, show); }), dispatch = original.records.find(record => record.kind === "dispatch_result");
  assert.ok(dispatch?.kind === "dispatch_result" && dispatch.result.outcome === "succeeded" && dispatch.result.recovered);
});
test("expired grant and cancellation authorities cannot be renewed by a worker retry", async () => {
  const value = await ready(), approved = await approve(value), now = Date.now;
  try { Date.now = () => now() + 11 * 60000; await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal()); }
  finally { Date.now = now; }
  let data = await service.readPayouts(value.producer); assert.equal(data.grants[0].problem, "PAYOUT_AUTHORITY_EXPIRED"); assert.equal(writes(value.wire).length, 0);
  await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal()); assert.equal(writes(value.wire).length, 0);
  await execute(value, { type: "revoke_payout", grantId: approved.grantId, detail: "Revoke the expired original before a separately reviewed instruction.", confirmed: true });
  await recipient(value, "priya", true); const next = await approve(value); await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: next.grantId }, signal()); data = await finish(value, next.grantId); const item = data.grants.find(grant => grant.id === next.grantId)!.items[0];
  const cancel = await execute(value, { type: "cancel_unclaimed", grantId: next.grantId, senderItemId: item.senderItemId, reviewDigest: item.cancelReviewDigest!, detail: "Explicit cancellation authority for this original unclaimed item.", confirmed: true });
  try { Date.now = () => now() + 11 * 60000; await worker.runPayoutJob(value.producer.actor.tenantId, "payout_cancel", { grantId: next.grantId, cancellationId: cancel.receipt.id }, signal()); }
  finally { Date.now = now; }
  await worker.runPayoutJob(value.producer.actor.tenantId, "payout_cancel", { grantId: next.grantId, cancellationId: cancel.receipt.id }, signal());
  assert.equal(value.wire.calls.filter(call => call.path.endsWith("/cancel")).length, 0);
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_payout_records WHERE tenant_id=$1 AND kind='cancel_result'", [value.producer.actor.tenantId])).rows[0].count, 1);
});
test("unknown item status and a success-to-failed regression hold rather than free an already-paid balance", async () => {
  const value = await ready(), approved = await approve(value); await worker.runPayoutJob(value.producer.actor.tenantId, "payout_batch", { grantId: approved.grantId }, signal()); await finish(value, approved.grantId);
  const batch = [...value.wire.batches.values()][0]; batch.items[0].transaction_status = "FAILED";
  let data = await finish(value, approved.grantId); assert.equal(data.grants[0].items[0].status, "UNKNOWN"); assert.equal(data.grants[0].items[0].problem, "PAYOUT_STATUS_REGRESSION"); assert.equal(data.totals.historicalPaidMinor, 3500); assert.equal(data.totals.reservedMinor, 3500);
  batch.items[0].transaction_status = "FUTURE_UNRECOGNIZED_STATUS"; data = await finish(value, approved.grantId); assert.equal(data.grants[0].batchVerified, false); assert.equal(data.totals.reservedMinor, 3500); assert.equal(writes(value.wire).length, 1);
});
test("local fixture adapters cannot use cached gateways after credential or hosting boundaries change", async () => {
  const value = await ready(); assert.equal(provider.payoutGateway(value.wire.merchantFingerprint).transport, "local_fixture");
  const before = process.env.PAYPAL_CLIENT_ID;
  try { process.env.PAYPAL_CLIENT_ID = "controlled-test-boundary-value"; assert.throws(() => provider.payoutGateway(value.wire.merchantFingerprint), code("PAYOUT_QA_DISABLED")); assert.throws(() => provider.installPayoutFixture(undefined), /disabled local isolation/); }
  finally { if (before === undefined) delete process.env.PAYPAL_CLIENT_ID; else process.env.PAYPAL_CLIENT_ID = before; }
  const hosted = process.env.VERCEL;
  try { process.env.VERCEL = "1"; assert.throws(() => provider.installPayoutFixture(undefined), /disabled local isolation/); assert.throws(() => provider.payoutGateway(value.wire.merchantFingerprint), code("PAYOUT_QA_DISABLED")); }
  finally { if (hosted === undefined) delete process.env.VERCEL; else process.env.VERCEL = hosted; }
  assert.equal(value.wire.calls.length, 0);
});
