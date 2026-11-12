/** Real domain, durable services and Bryntum; installed SDK transport is controlled and actual egress blocked. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Actor } from "../src/domain/contracts";
import type { SupplierTermInput } from "../src/domain/supplier-recovery";
import type { SupplierTransport } from "../src/server/supplier-protocol";
import { digest } from "../src/domain/hash";
import { financialSummary } from "../src/domain/finance";
import { rentalExecutionDigest } from "../src/domain/rental-closeout";
import { atVenue, plusMinutes } from "../src/domain/time";
import { supplierRecoveryHarness } from "./supplier-recovery-harness";

const h = await supplierRecoveryHarness({ realEngine: true }); after(h.close);
async function capability(actor: Actor, seconds = 86400) {
  const token = randomBytes(32).toString("base64url"), authority = { actor, sessionHash: h.sessionTokenHash(token) };
  const row = (await h.database.pool.query<{ expires_at: Date }>("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,clock_timestamp()+($4*interval '1 second')) RETURNING expires_at", [authority.sessionHash, actor.tenantId, actor, seconds])).rows[0]!;
  return { token, authority, expiresAt: row.expires_at.toISOString() };
}
async function ready(overrides: Partial<SupplierTermInput> = {}) {
  const value = await h.initial(), supplier = await h.openSupplier(value.authority, "northside");
  const published = await h.publish(supplier.authority, overrides);
  const requested = await h.requestQuotes(value.authority);
  return { ...value, supplier, published, requested, rfqId: requested.receipt.recordId };
}
async function collect(value: { actor: Actor; rfqId: string }, transport: SupplierTransport = h.transport) {
  return h.rfq.collectSupplierRfq(value.actor.tenantId, value.rfqId, h.signal(), transport);
}
async function requestRow(tenantId: string, id: string) {
  return (await h.database.pool.query("SELECT * FROM on_supplier_rfqs WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0];
}

test("pre-plan supplier access is private, exact-session recoverable and never renewed by replay", async () => {
  const value = await h.initial(), before = await h.recovery.readSupplierRecoveryWorkspace(value.authority);
  const envelope = { commandId: randomUUID(), expectedRevision: before.revision, command: { type: "open_supplier" as const, supplierId: "northside" as const, confirmed: true as const } };
  const [first, duplicate] = await Promise.all([h.recovery.executeSupplierRecoveryCommand(value.authority, envelope), h.recovery.executeSupplierRecoveryCommand(value.authority, envelope)]);
  assert.equal(Number(first.replayed) + Number(duplicate.replayed), 1); assert.deepEqual(first.invitation, duplicate.invitation);
  assert.deepEqual((await h.recovery.recoverSupplierRecoveryCommand(value.authority, envelope.commandId)).invitation, first.invitation);
  assert.ok(first.invitation); const token = first.invitation.url.split("#")[1]!, actor = (await h.store.getActor(token))!;
  const own = await h.recovery.readSupplierRecoveryWorkspace({ actor, sessionHash: h.sessionTokenHash(token) });
  assert.deepEqual(own.cards.map(card => card.supplierId), ["northside"]); assert.equal(own.preview, null); assert.deepEqual(own.requests, []);
  assert.equal(own.expiresAt, first.invitation.expiresAt); assert.equal((await h.store.getShow(value.actor.tenantId)).approvedPlan, null);
  const other = await capability(value.actor);
  await assert.rejects(() => h.recovery.recoverSupplierRecoveryCommand(other.authority, envelope.commandId), { status: 404 });
  await assert.rejects(() => h.recovery.executeSupplierRecoveryCommand(other.authority, envelope), { code: "SUPPLIER_RECOVERY_COMMAND_OWNER" });
  assert.doesNotMatch(JSON.stringify(await h.recovery.readSupplierRecoveryWorkspace(value.authority)), /sessionHash|document_cipher|receipt_cipher|supplier\/access#/);
  await assert.rejects(() => h.database.pool.query("UPDATE on_supplier_recovery_invites SET document_cipher='changed' WHERE tenant_id=$1", [value.actor.tenantId]), /immutable/);
});

test("only the owning supplier may publish a new immutable, canonical and body-bound edition", async () => {
  const value = await h.initial(), supplier = await h.openSupplier(value.authority, "northside"), prepared = await h.terms(supplier.authority);
  await assert.rejects(() => h.recovery.executeSupplierRecoveryCommand(value.authority, prepared.envelope), { code: "SUPPLIER_RECOVERY_ROLE" });
  await assert.rejects(() => h.recovery.executeSupplierRecoveryCommand(supplier.authority, { ...prepared.envelope, command: { ...prepared.envelope.command, offerId: "brightline-v1" } }), { code: "SUPPLIER_TERMS_SCOPE" });
  const saved = await h.recovery.executeSupplierRecoveryCommand(supplier.authority, prepared.envelope);
  const replayed = await h.recovery.executeSupplierRecoveryCommand(supplier.authority, prepared.envelope);
  assert.equal(replayed.replayed, true); assert.deepEqual(replayed.receipt, saved.receipt);
  await assert.rejects(() => h.recovery.executeSupplierRecoveryCommand(supplier.authority, { ...prepared.envelope, command: { ...prepared.envelope.command, feeMinor: 12345 } }), { code: "IDEMPOTENCY_CONFLICT" });
  const source = await h.recoveryLedger.readSupplierTerms(h.database.pool, value.actor.tenantId, saved.receipt.recordId);
  assert.equal(source.record.sessionHash, supplier.authority.sessionHash); assert.equal(source.record.source, "controlled_supplier_terms");
  assert.equal(source.record.sessionExpiresAt, saved.workspace.expiresAt); assert.equal(source.digest, saved.workspace.cards[0]!.reference!.digest);
  assert.doesNotMatch(JSON.stringify(saved), /sessionHash|document_cipher|receipt_cipher/);
  for (const table of ["on_supplier_terms", "on_supplier_recovery_commands"]) await assert.rejects(() => h.database.pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [value.actor.tenantId]), /immutable/);
  const second = await h.publish(supplier.authority, { feeMinor: 34567 });
  assert.equal(second.workspace.cards[0]!.reference!.revision, 2); assert.notEqual(second.receipt.recordId, saved.receipt.recordId);
  assert.deepEqual((await h.recoveryLedger.readSupplierTerms(h.database.pool, value.actor.tenantId, saved.receipt.recordId)).record, source.record);
  await assert.rejects(() => h.recovery.executeSupplierRecoveryCommand(supplier.authority, { ...prepared.envelope, commandId: randomUUID(), expectedRevision: second.workspace.revision }), { code: "SUPPLIER_TERMS_CHANGED" });
});

test("past or contradictory times, unbacked positive evidence and noncanonical bytes create no edition", async () => {
  const value = await h.initial(), supplier = await h.openSupplier(value.authority, "northside");
  const invalid: Partial<SupplierTermInput>[] = [
    { deliveryAt: atVenue("17:14") }, { deliveryAt: atVenue("00:45", "2026-11-15") }, { expiresAt: atVenue("17:15") },
    { expiresAt: atVenue("18:00") }, { qualifiedDriver: true, driverEvidence: null }, { qualifiedDriver: null },
    { conditionVerified: null }, { conditionVerified: true, conditionEvidence: null }, { reference: " whitespace source " },
  ];
  for (const item of invalid) await assert.rejects(() => h.publish(supplier.authority, item));
  assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_supplier_terms WHERE tenant_id=$1", [value.actor.tenantId])).rows[0].count), 0);
});

test("withdrawn capacity requires a separate own-supplier available-again report before new terms", async () => {
  const value = await h.initial(), supplier = await h.openSupplier(value.authority, "northside"); await h.report(value.authority, "northside");
  await assert.rejects(() => h.publish(supplier.authority), { code: "SUPPLIER_TERMS_WITHDRAWN" });
  await assert.rejects(() => h.report(value.authority, "northside", "available"), { code: "SUPPLIER_RECONFIRMATION_REQUIRED" });
  const available = await h.report(supplier.authority, "northside", "available"), published = await h.publish(supplier.authority);
  assert.equal(published.workspace.cards[0]!.reference!.sourceReportId, available.receipt.recordId);
  await h.report(value.authority, "northside", "delayed");
  assert.equal((await h.recovery.readSupplierRecoveryWorkspace(supplier.authority)).cards[0]!.usable, false);
  await assert.rejects(() => h.publish(supplier.authority, { sourceReportId: available.receipt.recordId }), { code: "SUPPLIER_TERMS_REPORT_CHANGED" });
});

test("one fresh quote and two authenticated refusals complete the collection without extending past scenario terms", async () => {
  const value = await h.initial(); await h.report(value.authority, "brightline");
  const supplier = await h.openSupplier(value.authority, "northside"), published = await h.publish(supplier.authority), originalOffers = (await h.store.getShow(value.actor.tenantId)).offers;
  const request = await h.requestQuotes(value.authority), rfqId = request.receipt.recordId;
  assert.equal((await collect({ ...value, rfqId })).status, "complete"); const show = await h.store.getShow(value.actor.tenantId), row = await requestRow(value.actor.tenantId, rfqId);
  assert.equal(row.outcomes.length, 3); assert.equal(row.outcomes.filter((outcome: { kind: string }) => outcome.kind === "quote").length, 1);
  assert.deepEqual(row.outcomes.filter((outcome: { kind: string }) => outcome.kind === "declined").map((outcome: { decline: { code: string } }) => outcome.decline.code).sort(), ["FRESH_TERMS_REQUIRED", "UNIT_UNAVAILABLE"]);
  const quote = show.offers.find(offer => offer.supplierId === "northside")!; assert.equal(quote.serviceQuote!.termsSource!.id, published.receipt.recordId); assert.equal(quote.deliveryAt, atVenue("17:35")); assert.equal(quote.expiresAt, atVenue("17:30"));
  for (const id of ["brightline", "sister"]) { const declined = show.offers.find(offer => offer.supplierId === id)!; assert.equal(declined.status, "expired"); assert.equal(declined.expiresAt, originalOffers.find(offer => offer.supplierId === id)!.expiresAt); }
  for (const table of ["on_supplier_quotes", "on_supplier_requests", "on_supplier_recovery_rfqs"]) await assert.rejects(() => h.database.pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [value.actor.tenantId]), /immutable/);
  assert.equal(show.rentalExecutions?.length ?? 0, 0); assert.equal(h.wire.calls.length, 0);
});

test("a committed supplier response lost in transit retains all original request identities and leaves offers unchanged", async () => {
  const value = await ready(), before = await h.store.getShow(value.actor.tenantId); let dropped = false;
  const lost: SupplierTransport = async request => { const response = await h.transport(request); if (request.url.includes("/northside/") && !dropped) { dropped = true; throw new TypeError("Controlled response lost after supplier commit"); } return response; };
  assert.equal((await collect(value, lost)).status, "waiting"); assert.deepEqual((await h.store.getShow(value.actor.tenantId)).offers, before.offers);
  const first = await requestRow(value.actor.tenantId, value.rfqId); assert.equal(first.outcomes.length, 2);
  const originals = (await h.database.pool.query("SELECT request_id,response FROM on_supplier_requests WHERE tenant_id=$1 ORDER BY request_id", [value.actor.tenantId])).rows; assert.equal(originals.length, 3);
  assert.equal((await collect(value)).status, "complete"); const final = await requestRow(value.actor.tenantId, value.rfqId); assert.deepEqual(final.request_ids, first.request_ids);
  assert.deepEqual((await h.database.pool.query("SELECT request_id,response FROM on_supplier_requests WHERE tenant_id=$1 ORDER BY request_id", [value.actor.tenantId])).rows, originals);
  assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_supplier_quotes WHERE tenant_id=$1", [value.actor.tenantId])).rows[0].count), 1);
});

test("a forged cross-supplier refusal stays unknown until the authentic original response is read", async () => {
  const value = await ready(), before = await h.store.getShow(value.actor.tenantId);
  const forged: SupplierTransport = async request => { const response = await h.transport(request); if (!request.url.includes("/sister/")) return response; const body = await response.json(); body.result.decline.supplierId = "brightline"; return Response.json(body); };
  assert.equal((await collect(value, forged)).status, "waiting"); assert.deepEqual((await h.store.getShow(value.actor.tenantId)).offers, before.offers);
  assert.equal((await requestRow(value.actor.tenantId, value.rfqId)).last_code, "SUPPLIER_RESPONSE_INVALID");
  assert.equal((await collect(value)).status, "complete");
});

test("a different capability cannot adopt quote work and expired original authority dispatches no request", async () => {
  const value = await ready(), alternate = await capability(value.actor);
  await assert.rejects(() => h.recovery.continueSupplierRecoveryRfq(alternate.authority, value.rfqId, h.signal(), h.transport), { code: "SUPPLIER_RFQ_OWNER" });
  await assert.rejects(() => h.recovery.recoverSupplierRecoveryCommand(alternate.authority, value.requested.receipt.commandId), { status: 404 });
  await h.database.pool.query("UPDATE on_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [value.authority.sessionHash]); let requests = 0;
  const result = await collect(value, async request => { requests++; return h.transport(request); });
  assert.equal(result.status, "needs_attention"); assert.equal(requests, 0); assert.equal((await requestRow(value.actor.tenantId, value.rfqId)).status, "needs_review");
});

test("a new supplier edition during collection preserves the original signed quote but cannot apply it", async () => {
  const value = await ready(), before = await h.store.getShow(value.actor.tenantId); let changed = false;
  const racing: SupplierTransport = async request => { const response = await h.transport(request); if (request.url.includes("/northside/") && !changed) { changed = true; await h.publish(value.supplier.authority, { feeMinor: 34567 }); } return response; };
  assert.equal((await collect(value, racing)).status, "needs_attention"); const show = await h.store.getShow(value.actor.tenantId);
  assert.deepEqual(show.offers, before.offers); assert.notEqual(show.supplierTermRevisions![0]!.id, value.published.receipt.recordId);
  assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_supplier_quotes WHERE tenant_id=$1", [value.actor.tenantId])).rows[0].count), 1);
  assert.equal((await requestRow(value.actor.tenantId, value.rfqId)).status, "needs_review");
});

test("supplier source revocation after a signed reply prevents the final offer replacement", async () => {
  const value = await ready(), before = await h.store.getShow(value.actor.tenantId); let changed = false;
  const racing: SupplierTransport = async request => { const response = await h.transport(request); if (request.url.includes("/northside/") && !changed) { changed = true; await h.database.pool.query("UPDATE on_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [value.supplier.authority.sessionHash]); } return response; };
  const result = await collect(value, racing); assert.deepEqual(result, { status: "needs_attention", code: "TERMS_ACCESS_ENDED" });
  assert.deepEqual((await h.store.getShow(value.actor.tenantId)).offers, before.offers);
});

test("scenario expiry is inclusive and retains the original edition while declining all expired offers", async () => {
  const value = await h.initial(), supplier = await h.openSupplier(value.authority, "northside"), published = await h.publish(supplier.authority, { expiresAt: atVenue("17:20") });
  await h.command(value.actor, { type: "advance", time: "17:20" }); const requested = await h.requestQuotes(value.authority), rfqId = requested.receipt.recordId;
  assert.equal((await collect({ ...value, rfqId })).status, "complete"); const row = await requestRow(value.actor.tenantId, rfqId);
  assert.equal(row.quote_ids.length, 0); assert.equal(row.outcomes.find((outcome: { supplierId: string }) => outcome.supplierId === "northside").decline.code, "TERMS_EXPIRED");
  assert.equal((await h.recoveryLedger.readSupplierTerms(h.database.pool, value.actor.tenantId, published.receipt.recordId)).record.input.expiresAt, atVenue("17:20"));
});

test("real-time source expiry is capped by the original access and checked again after delayed transport", async () => {
  const value = await h.initial(), supplier = await h.openSupplier(value.authority, "northside"), short = await capability(supplier.actor, 3);
  const published = await h.publish(short.authority), requested = await h.requestQuotes(value.authority), rfqId = requested.receipt.recordId;
  assert.equal(published.workspace.cards[0]!.reference!.validUntil, short.expiresAt); const before = await h.store.getShow(value.actor.tenantId);
  const delayed: SupplierTransport = async request => { const response = await h.transport(request); if (request.url.includes("/northside/")) await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(short.expiresAt) - Date.now() + 30))); return response; };
  assert.deepEqual(await collect({ ...value, rfqId }, delayed), { status: "needs_attention", code: "TERMS_EXPIRED" });
  assert.deepEqual((await h.store.getShow(value.actor.tenantId)).offers, before.offers); let calls = 0;
  await collect({ ...value, rfqId }, async request => { calls++; return h.transport(request); }); assert.equal(calls, 0);
});

test("actual engine success cannot approve a quote after its exact supplier access is silently extended", async () => {
  const value = await ready(); assert.equal((await collect(value)).status, "complete"); const planned = await h.realPlan(value.actor);
  await h.database.pool.query("UPDATE on_sessions SET expires_at=expires_at+interval '1 minute' WHERE token_hash=$1", [value.supplier.authority.sessionHash]);
  await assert.rejects(() => h.command(value.actor, { type: "approve", candidateId: planned.candidate.id, candidateDigest: planned.candidate.digest, approvals: planned.candidate.approvals.map(item => item.id) }), { code: "SUPPLIER_TERMS_CHANGED" });
  assert.equal((await h.store.getShow(value.actor.tenantId)).approvedPlan, null);
});

test("actual engine success does not turn missing driver and condition sources into confirmed evidence", async () => {
  const value = await ready({ qualifiedDriver: null, driverEvidence: null, conditionVerified: null, conditionEvidence: null }); assert.equal((await collect(value)).status, "complete");
  const show = await h.store.getShow(value.actor.tenantId), candidates = await h.engine.generateCandidates(show), candidate = candidates.find(item => item.id.startsWith("doors-northside"))!;
  assert.equal(candidate.report.engine?.status, "passed"); assert.equal(candidate.report.status, "unknown_pending_evidence");
  assert.ok(candidate.report.issues.some(issue => issue.code === "DRIVER_UNKNOWN")); assert.ok(candidate.report.issues.some(issue => issue.code === "CONDITION_UNKNOWN"));
});

test("a healthy current accepted rental cannot be replaced without an attributed current disruption", async () => {
  const value = await h.accepted({ replacePlan: false }); const desk = await h.recovery.readSupplierRecoveryWorkspace(value.authority);
  assert.equal(desk.preview!.ready, false); assert.match(desk.preview!.blockers.join(" "), /current change affecting/);
  await assert.rejects(() => h.recoveryAct(value.authority, { type: "request_quotes", previewDigest: desk.preview!.digest, detail: "A healthy current rental must not be silently replaced.", confirmed: true }), { code: "SUPPLIER_RECOVERY_PREVIEW_CHANGED" });
});

test("actual RFQ, engine and separate replacement approval retain the original accepted fee and close only its hold", async () => {
  const value = await h.accepted({ replacePlan: false }); await h.report(value.authority, "brightline");
  const supplier = await h.openSupplier(value.authority, "northside"), published = await h.publish(supplier.authority);
  const before = await h.store.getShow(value.actor.tenantId), original = before.rentalExecutions!.find(item => item.id === value.executionId)!, originalDigest = rentalExecutionDigest(original), money = structuredClone(before.financialEvidence), providerWrites = h.wire.calls.filter(call => call.method === "POST").length;
  const reviewed = await h.recovery.readSupplierRecoveryWorkspace(value.authority); assert.equal(reviewed.preview!.retained[0]!.verifiedFeeMinor, 48000); assert.equal(reviewed.preview!.retained[0]!.depositMinor, 30000);
  const requested = await h.requestQuotes(value.authority), rfqId = requested.receipt.recordId;
  assert.equal((await collect({ ...value, rfqId })).status, "complete"); let show = await h.store.getShow(value.actor.tenantId);
  assert.equal(show.approvedPlan, null); assert.equal(show.planVersion, before.planVersion + 1); assert.equal(rentalExecutionDigest(show.rentalExecutions!.find(item => item.id === value.executionId)!), originalDigest);
  const planned = await h.realPlan(value.actor); assert.equal(planned.candidates.length, 12);
  assert.equal(planned.candidate.patch.tasks.find(task => task.id === "rental-authorized")!.start, before.clock);
  show = await h.command(value.actor, { type: "approve", candidateId: planned.candidate.id, candidateDigest: planned.candidate.digest, approvals: planned.candidate.approvals.map(item => item.id) });
  const offer = show.offers.find(item => item.supplierId === "northside")!; assert.equal(offer.serviceQuote!.termsSource!.id, published.receipt.recordId);
  const producerAccess = { sessionHash: value.authority.sessionHash, expiresAt: await h.recoveryLedger.requireSupplierRecoveryAuthority(h.database.pool, value.authority, "producer") };
  const held = await h.protocol.callSupplierService("northside", { version: 1, requestId: randomUUID(), tenantId: show.tenantId, actorId: value.actor.id, action: { type: "hold", quoteId: offer.serviceQuote!.id, planDigest: show.approvedPlan!.digest, expectedRevision: show.revision, acceptCaptureTerms: true, producerAccess } }, h.signal(), h.transport);
  assert.equal(held.kind, "execution"); if (held.kind !== "execution") throw new Error("No replacement execution");
  assert.notEqual(held.execution.id, value.executionId); assert.equal(held.execution.state, "held"); assert.equal(held.execution.authorizationId, null); assert.equal(held.execution.acceptedAt, null);
  show = await h.store.getShow(value.actor.tenantId); assert.deepEqual(show.financialEvidence, money); assert.equal(h.wire.calls.filter(call => call.method === "POST").length, providerWrites);
  assert.equal(rentalExecutionDigest(show.rentalExecutions!.find(item => item.id === value.executionId)!), originalDigest);
  assert.ok(!show.facts.some(fact => fact.planVersion === show.planVersion && ["supplier_confirmed", "delivery_accepted"].includes(fact.kind)));
  await h.returned(value); const closure = await h.approve(value); assert.equal(closure.grant.executionId, value.executionId); assert.equal(closure.preview.residualMinor, 30000);
  assert.equal((await h.worker.runRentalCloseoutWork(value.actor.tenantId, closure.intent.id, h.signal(), "dispatch")).status, "complete");
  const final = await h.store.getShow(value.actor.tenantId); assert.equal(financialSummary(final).rentalCapturedMinor, 48000); assert.equal(financialSummary(final).releasedMinor, 30000);
  assert.equal(final.rentalExecutions!.find(item => item.id === held.execution.id)!.state, "held"); assert.equal(final.rentalExecutions!.find(item => item.id === held.execution.id)!.authorizationId, null);
});

test("a prepared original fee remains visible and is never dispatched by replacement quote collection", async () => {
  const value = await h.accepted({ replacePlan: false, captureFee: false }); await h.report(value.authority, "brightline");
  const supplier = await h.openSupplier(value.authority, "northside"); await h.publish(supplier.authority);
  const before = await h.store.getShow(value.actor.tenantId), writes = h.wire.calls.filter(call => call.method === "POST").length, desk = await h.recovery.readSupplierRecoveryWorkspace(value.authority);
  assert.equal(desk.preview!.retained[0]!.feeInstructionPending, true); assert.equal(desk.preview!.retained[0]!.verifiedFeeMinor, 0);
  const requested = await h.requestQuotes(value.authority); assert.equal((await collect({ ...value, rfqId: requested.receipt.recordId })).status, "complete");
  const final = await h.store.getShow(value.actor.tenantId); assert.equal(digest(final.financialEvidence), digest(before.financialEvidence)); assert.equal(h.wire.calls.filter(call => call.method === "POST").length, writes);
  assert.equal((await h.recovery.readSupplierRecoveryWorkspace(value.authority)).preview!.retained[0]!.feeInstructionPending, true);
});

test("all signed refusals can feed real no-feasible assessment and cancellation cannot be reopened by a new edition", async () => {
  const value = await h.initial(); await h.report(value.authority, "brightline");
  const supplier = await h.openSupplier(value.authority, "brightline"), requested = await h.requestQuotes(value.authority);
  assert.equal((await collect({ ...value, rfqId: requested.receipt.recordId })).status, "complete"); let show = await h.store.getShow(value.actor.tenantId);
  const assessed = await h.disruption.executeDisruptionCommand(value.authority, { idempotencyKey: randomUUID(), expectedRevision: show.revision, command: { type: "assess" } });
  const assessment = assessed.workspace.assessments.at(-1)!; assert.equal(assessment.generated, 12); assert.equal(assessment.conclusion, "no_feasible_candidate");
  const preview = await h.disruption.previewCancellation(value.authority, "cancel_show", 3500); show = await h.store.getShow(value.actor.tenantId);
  await h.disruption.executeDisruptionCommand(value.authority, { idempotencyKey: randomUUID(), expectedRevision: show.revision, command: { type: "decide", mode: "cancel_show", assessmentId: assessment.id, previewDigest: preview.digest, admissionRefundMinor: 3500, detail: "Controlled producer decision after all twelve real engine alternatives were infeasible; no paid audience records exist.", confirmed: true } });
  await h.report(supplier.authority, "brightline", "available"); await h.publish(supplier.authority);
  const desk = await h.recovery.readSupplierRecoveryWorkspace(value.authority); assert.equal(desk.preview!.ready, false); assert.equal(desk.preview!.program, "cancelled");
  await assert.rejects(() => h.recoveryAct(value.authority, { type: "request_quotes", previewDigest: desk.preview!.digest, detail: "New terms cannot authorize reopening a cancelled show.", confirmed: true }), { code: "SUPPLIER_RECOVERY_PREVIEW_CHANGED" });
  assert.equal((await h.store.getShow(value.actor.tenantId)).cancellationDecision!.mode, "cancel_show");
});
