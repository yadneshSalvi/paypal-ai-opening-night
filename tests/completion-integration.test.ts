/** Combined accepted units; local services/engine and explicitly controlled SDK transport. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { digest } from "../src/domain/hash";
import { atVenue } from "../src/domain/time";
import { recordRescueRun } from "../src/domain/commands";
import { DomainError } from "../src/domain/contracts";
import type { ProducerConsentEnvelope } from "../src/domain/plan-consents";
import { isolatedDatabase } from "./isolated-database";
import { audienceHarness } from "./audience-harness";

const database = await isolatedDatabase();
// Skip markers construct the pre-17 boundary only in this disposable test schema.
await database.pool.query("CREATE TABLE on_schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
await database.pool.query("INSERT INTO on_schema_migrations(version) VALUES(17),(18),(19)");
const h = await audienceHarness({ database });
after(async () => {
  await h.close();
  const guard = (globalThis as typeof globalThis & { openingNightModelControlledGuard?: { state: { blockedExternalPaths: number; blockedDatabaseIdentities: number; ownDatabaseConnections: number; suppressedToolingIpc: number } } }).openingNightModelControlledGuard;
  assert.ok(guard); assert.equal(guard.state.blockedExternalPaths, 0); assert.equal(guard.state.blockedDatabaseIdentities, 0);
  console.log("Controlled integration transport", JSON.stringify(guard.state));
});

async function snapshot() {
  const names = (await database.pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'on_schema_migrations' ORDER BY tablename")).rows.map(row => row.tablename as string);
  const result: Record<string, { count: number; digest: string }> = {};
  for (const name of names) {
    assert.match(name, /^[a-z0-9_]+$/);
    const rows = (await database.pool.query(`SELECT row_to_json(t)::text AS value FROM "${name}" t ORDER BY row_to_json(t)::text`)).rows.map(row => row.value);
    result[name] = { count: rows.length, digest: digest(rows) };
  }
  return result;
}

test("combined migrations17–19 preserve every original row, fixed authority and controlled capture", async () => {
  const value = await h.fresh(), capture = await h.capture(value);
  await database.pool.query("DELETE FROM on_schema_migrations WHERE version IN(17,18,19)");
  assert.equal((await database.pool.query("SELECT max(version) AS version FROM on_schema_migrations")).rows[0].version, 16);
  const before = await snapshot(), originalShow = digest(await h.store.getShow(value.actor.tenantId)), wireCalls = h.wire.calls.length;
  const expiry = (await database.pool.query("SELECT expires_at::text AS value FROM on_sessions WHERE token_hash=$1", [value.authority.sessionHash])).rows[0].value;
  delete (globalThis as typeof globalThis & { openingNightMigration?: Promise<void> }).openingNightMigration;
  await h.store.migrate();
  const installed = await snapshot(), additions = Object.keys(installed).filter(name => !before[name]);
  assert.equal(additions.length, 19);
  assert.equal(additions.filter(name => name.startsWith("on_audience_")).length, 10);
  assert.equal(additions.filter(name => name.startsWith("on_plan_consent_")).length, 5);
  assert.deepEqual(additions.filter(name => !name.startsWith("on_audience_") && !name.startsWith("on_plan_consent_")).sort(), ["on_intelligence_observations", "on_intelligence_scopes", "on_source_compilation_observations", "on_source_compilation_scopes"]);
  for (const [name, record] of Object.entries(before)) assert.deepEqual(installed[name], record, name);
  for (const name of additions) assert.equal(installed[name].count, 0, name);
  assert.deepEqual((await database.pool.query("SELECT version FROM on_schema_migrations WHERE version>=17 ORDER BY version")).rows.map(row => row.version), [17, 18, 19]);
  await h.store.migrate(); assert.deepEqual(await snapshot(), installed);
  assert.equal((await database.pool.query("SELECT expires_at::text AS value FROM on_sessions WHERE token_hash=$1", [value.authority.sessionHash])).rows[0].value, expiry);
  assert.equal(digest(await h.store.getShow(value.actor.tenantId)), originalShow);
  const original = (await h.audience.readAudienceWorkspace(value.authority)).tickets.find(item => item.ticketId === capture.ticket.id)!;
  assert.equal(original.verification, "verified"); assert.equal(original.grossMinor, 5000);
  assert.equal(h.wire.calls.length, wireCalls, "Migrations and receipt reads dispatch no provider operations");
});

test("separate artist consent publishes new attendee facts while the old approved message stays immutable and cannot deliver", async () => {
  const value = await h.fresh(), capture = await h.capture(value), link = await h.invite(value, capture.ticket.id);
  const oldDraft = await h.draft(value, [link.capabilityId]); await h.approve(value, oldDraft.draft.id);
  const oldBody = digest(oldDraft.draft), oldReceipt = (await h.attendee.readAttendee(link.reader)).receipt.originalDigest;
  const financialCalls = h.wire.calls.length;
  let show = await h.command(value.actor, { type: "load_incidents" });
  const recovery = await import("../src/server/supplier-recovery/service"), rpc = await import("../src/app/api/enrolled-suppliers/[supplier]/rpc/route"), engine = await import("../src/server/engine");
  const transport: import("../src/server/supplier-protocol").SupplierTransport = request => rpc.POST(request, { params: Promise.resolve({ supplier: new URL(request.url).pathname.split("/").at(-2)! }) });
  const opened = await recovery.executeSupplierRecoveryCommand(value.authority, { commandId: randomUUID(), expectedRevision: show.revision, command: { type: "open_supplier", supplierId: "brightline", confirmed: true } });
  const supplierToken = opened.invitation!.url.split("#")[1]!, supplierActor = (await h.store.getActor(supplierToken))!;
  const supplierAuthority = { actor: supplierActor, sessionHash: h.sessionTokenHash(supplierToken) }, supplier = await recovery.readSupplierRecoveryWorkspace(supplierAuthority), card = supplier.cards[0]!;
  await recovery.executeSupplierRecoveryCommand(supplierAuthority, { commandId: randomUUID(), expectedRevision: supplier.revision, command: { type: "publish_terms", offerId: card.offerId, previousTermId: null, sourceReportId: card.report?.id ?? null, deliveryAt: atVenue("18:40"), expiresAt: card.scenarioDeadline, validForMinutes: 60, feeMinor: card.feeMinor, depositMinor: card.depositMinor, compatible: true, qualifiedDriver: true, conditionVerified: true, capabilityEvidence: "Controlled compatible console source only; no real equipment certification is claimed.", driverEvidence: "Controlled driver roster source only; no actual person or delivery is claimed.", conditionEvidence: "Controlled condition source only; physical inspection and handoff are absent.", reference: "Combined-service controlled late Brightline source", detail: "A new synthetic production's independently attributed supplier edition makes the actual engine evaluate a shorter artist set. No prior production or source is altered.", confirmed: true } });
  const preview = await recovery.readSupplierRecoveryWorkspace(value.authority);
  const requested = await recovery.executeSupplierRecoveryCommand(value.authority, { commandId: randomUUID(), expectedRevision: preview.revision, command: { type: "request_quotes", previewDigest: preview.preview!.digest, detail: "Controlled producer reviewed the current exact supplier source before this distinct quote collection.", confirmed: true } });
  await recovery.continueSupplierRecoveryRfq(value.authority, requested.receipt.recordId, AbortSignal.timeout(10000), transport);
  show = await h.store.getShow(show.tenantId);
  const candidates = await engine.generateCandidates(show), candidate = candidates.find(item => item.family === "budget" && item.patch.offerId.includes("brightline"))!;
  assert.equal(candidate.report.engine?.status, "passed"); assert.equal(candidate.report.status, "feasible_with_approval");
  assert.ok(candidate.approvals.some(item => item.role === "artist_representative"));
  await h.store.transactCommand(value.actor, randomUUID(), show.revision, { type: "controlled-combined-engine" }, current => recordRescueRun(current, value.actor, candidates));
  const consent = await import("../src/server/plan-consents/service");
  async function envelope(command: ProducerConsentEnvelope["command"]): Promise<ProducerConsentEnvelope> {
    const workspace = await consent.consentWorkspace(value.authority);
    return { version: 1, commandId: randomUUID(), scope: workspace.scope, expectedRevision: workspace.revision, approvalRevision: workspace.approvalRevision, command };
  }
  const invited = await consent.executeProducerConsent(value.authority, await envelope({ type: "invite", candidateId: candidate.id, candidateDigest: candidate.digest, requirementId: "artist-set", representativeName: "Controlled Artist Representative", representationBasis: "Declared synthetic integration reviewer. No real person's authority or participation is claimed.", sourceId: candidate.patch.tasks.find(task => task.id === "headliner")!.sourceId, validityMinutes: 15, sourceReviewed: true, invitationReviewed: true }));
  const token = invited.receipt.result.reviewPath!.split("#")[1]!, review = await consent.reviewConsent(token);
  assert.equal(await h.store.getActor(token), null, "Separate review access never grants a producer Actor");
  await consent.executeReviewerConsent(token, { version: 1, commandId: randomUUID(), requestId: review.review.requestId, reviewDigest: review.reviewDigest, expiresAt: review.review.expiresAt, capabilityFingerprint: review.capabilityFingerprint, decision: "approve", declaredName: review.review.representative.invitedName, authorityConfirmed: true, contentReviewed: true, statement: "Controlled separate reviewer approved this exact change. This is synthetic test evidence, not human participation." });
  await consent.executeProducerConsent(value.authority, await envelope({ type: "approve_plan", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: candidate.approvals.map(item => item.id), reviewed: true }));
  const approvedShow = await h.store.getShow(value.actor.tenantId);
  assert.equal(approvedShow.approvedPlan?.digest, candidate.digest);
  assert.equal(approvedShow.approvedPlan?.externalApprovals?.length, 1);
  const retained = await h.audience.readAudienceMessage(value.authority, oldDraft.draft.id);
  assert.equal(digest(retained.draft), oldBody); assert.equal(retained.preview.ready, false); assert.equal(retained.deliveries.length, 0);
  assert.match(retained.preview.blockers.join(" "), /source changed/i);
  await assert.rejects(h.reserve(value, oldDraft.draft.id), error => error instanceof DomainError && /review|source|changed/i.test(error.message));
  // Approval alone cannot publish current audience facts. Complete the existing
  // controlled commercial flow before the separate publication command.
  await assert.rejects(h.draft(value, [link.capabilityId]), { code: "AUDIENCE_SOURCE_CHANGED" });
  await assert.rejects(h.command(value.actor, { type: "publish" }), { code: "COMMERCIAL_PENDING" });
  assert.equal(h.wire.calls.length, financialCalls, "Consent and planning dispatch no financial operations");
  const protocol = await import("../src/server/supplier-protocol"), recoveryLedger = await import("../src/server/supplier-recovery/store"), offer = approvedShow.offers.find(item => item.id === candidate.patch.offerId)!;
  const producerAccess = { sessionHash: value.authority.sessionHash, expiresAt: await recoveryLedger.requireSupplierRecoveryAuthority(database.pool, value.authority, "producer") };
  const held = await protocol.callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: value.actor.tenantId, actorId: value.actor.id, action: { type: "hold", quoteId: offer.serviceQuote!.id, planDigest: approvedShow.approvedPlan!.digest, expectedRevision: approvedShow.revision, acceptCaptureTerms: true, producerAccess } }, AbortSignal.timeout(10000), transport);
  assert.equal(held.kind, "execution"); if (held.kind !== "execution") throw new Error("Expected controlled reservation");
  const heldShow = await h.store.getShow(value.actor.tenantId);
  const checkout = await h.paymentService.handlePayment(value.actor, { type: "rental_checkout", expectedRevision: heldShow.revision }, "http://127.0.0.1:4594");
  const root = await h.payments.readIntent(value.actor.tenantId, checkout.command.intentId), resources = await h.payments.ownedResources(value.actor.tenantId, "brightline", root.id), orderId = resources.find(item => item.kind === "order")!.id;
  h.wire.orders.get(orderId)!.status = "APPROVED"; // Synthetic payer fixture, never an actual buyer action.
  assert.equal((await h.paymentService.handlePayment(value.actor, { type: "complete_checkout", intentId: root.id, state: h.paymentService.callbackState(root) }, "http://127.0.0.1:4594")).status, "succeeded");
  await protocol.callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: value.actor.tenantId, actorId: value.actor.id, action: { type: "confirm", executionId: held.execution.id } }, AbortSignal.timeout(10000), transport);
  await h.command(value.actor, { type: "publish" });
  const publicationCalls = h.wire.calls.length;
  assert.ok(h.wire.calls.filter(call => call.method === "POST").every(call => call.durable));
  const currentDraft = await h.draft(value, [link.capabilityId]);
  assert.notEqual(currentDraft.draft.id, oldDraft.draft.id); assert.notEqual(currentDraft.draft.sourceDigest, oldDraft.draft.sourceDigest);
  assert.equal(currentDraft.preview.ready, true); assert.equal(currentDraft.approval, null);
  await h.approve(value, currentDraft.draft.id); const delivered = await h.deliver(value, currentDraft.draft.id, 1);
  assert.equal(delivered.view.deliveries.length, 1);
  const reader = await h.attendee.readAttendee(link.reader);
  assert.equal(reader.receipt.originalDigest, oldReceipt); assert.equal(reader.inbox.length, 1);
  assert.equal(reader.inbox[0].digest, delivered.view.deliveries[0].digest);
  assert.equal(digest((await h.audience.readAudienceMessage(value.authority, oldDraft.draft.id)).draft), oldBody);
  assert.equal(h.wire.calls.length, publicationCalls, "Message review and inbox delivery dispatch no financial operations");
});
