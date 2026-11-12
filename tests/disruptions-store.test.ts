/** Real installed SDK over a controlled fetch and an isolated database. No provider qualification. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { isolatedDatabase } from "./isolated-database";
import { DisruptionWire } from "./disruption-wire";
import { applyCommand, recordRescueRun, type Command } from "../src/domain/commands";
import { enumerateCandidates } from "../src/domain/scheduling";
import { financialSummary } from "../src/domain/finance";
import { testEngine } from "./helpers";
import { atVenue } from "../src/domain/time";
import type { Actor, ShowSnapshot } from "../src/domain/contracts";
import type { DisruptionCommand, DisruptionEnvelope } from "../src/domain/disruptions";
import type { DisruptionAuthority } from "../src/server/disruptions/contracts";
import { hasCurrentSupportOnlyPlan } from "../src/domain/disruptions";
import { readiness } from "../src/domain/readiness";

const database = await isolatedDatabase(), wire = new DisruptionWire(database.pool);
(globalThis as typeof globalThis & { openingNightProviders?: unknown }).openingNightProviders = { venue: wire.provider(), brightline: wire.provider() };
const store = await import("../src/server/store"), payments = await import("../src/server/payment-store"), paymentService = await import("../src/server/payment-service");
const service = await import("../src/server/disruptions/service"), ledger = await import("../src/server/disruptions/store"), worker = await import("../src/server/disruptions/worker");
const { sessionTokenHash } = await import("../src/server/session-records");
const { closeCommerceLocks } = await import("../src/server/commerce-locks");
await payments.paymentStore(); after(async () => { await closeCommerceLocks(); await database.close(); });
const signal = () => AbortSignal.timeout(10000);
const controlledEngine = async (show: ShowSnapshot) => { const candidates = enumerateCandidates(show); candidates.forEach(candidate => { candidate.report.engine = testEngine(candidate); }); return candidates; };
const refundWrites = () => wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/refund"));
async function command(actor: Actor, value: Command) { const show = await store.getShow(actor.tenantId); return (await store.transactCommand(actor, randomUUID(), show.revision, value, current => applyCommand(current, actor, value))).show; }
async function planned() {
  const session = await store.createSession(undefined, "disruption:" + randomUUID());
  // Retained legacy contract makes financial fixtures independent of RFQ timing.
  await database.pool.query("UPDATE on_shows SET snapshot=snapshot-'commercialProtocol'-'rentalExecutions' WHERE tenant_id=$1", [session.actor.tenantId]);
  let show = await command(session.actor, { type: "load_incidents" }); const candidates = await controlledEngine(show);
  show = (await store.transactCommand(session.actor, randomUUID(), show.revision, { type: "controlled-engine" }, current => recordRescueRun(current, session.actor, candidates))).show;
  const candidate = candidates.find(item => item.id.startsWith("doors-brightline"))!;
  show = await command(session.actor, { type: "approve", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: candidate.approvals.map(item => item.id) });
  return { ...session, show, authority: { actor: session.actor, sessionHash: sessionTokenHash(session.token) } };
}
async function act(authority: DisruptionAuthority, value: DisruptionCommand, envelope?: DisruptionEnvelope) { const show = await store.getShow(authority.actor.tenantId); return service.executeDisruptionCommand(authority, envelope ?? { idempotencyKey: randomUUID(), expectedRevision: show.revision, command: value }, controlledEngine); }
async function report(value: Awaited<ReturnType<typeof planned>>, supplierId = "brightline") {
  const show = await store.getShow(value.actor.tenantId), offer = show.offers.find(item => item.supplierId === supplierId)!;
  return act(value.authority, { type: "report", offerId: offer.id, offerRevision: offer.revision, executionId: null, availability: "unavailable", earliestAt: null, observedAt: new Date().toISOString(), reference: "Controlled signed source report", detail: "Supplier confirms the original console is no longer available for this production.", confirmed: true });
}
async function capture(value: Awaited<ReturnType<typeof planned>>, tier: "standard" | "vip") {
  const show = await store.getShow(value.actor.tenantId), ticketId = randomUUID();
  const created = await paymentService.handlePayment(value.actor, { type: "ticket_checkout", expectedRevision: show.revision, ticketId, tier }, "http://localhost:4105");
  const root = await payments.readIntent(value.actor.tenantId, created.command.intentId), resources = await payments.ownedResources(value.actor.tenantId, "venue", root.id), orderId = resources.find(item => item.kind === "order")!.id;
  wire.orders.get(orderId)!.status = "APPROVED";
  const operation = await paymentService.handlePayment(value.actor, { type: "complete_checkout", intentId: root.id, state: paymentService.callbackState(root) }, "http://localhost:4105");
  assert.equal(operation.status, "succeeded"); return { ticketId, root, orderId };
}
async function decision(value: Awaited<ReturnType<typeof planned>>, mode: "support_only" | "cancel_show" = "cancel_show", admissionRefundMinor = mode === "cancel_show" ? 3500 : 1000) {
  if (!(await store.getShow(value.actor.tenantId)).supplierDisruptions?.length) await report(value);
  const assessed = await act(value.authority, { type: "assess" });
  const preview = await service.previewCancellation(value.authority, mode, admissionRefundMinor); assert.equal(preview.ready, true, preview.blockers.join("; "));
  const result = await act(value.authority, { type: "decide", mode, assessmentId: assessed.receipt.recordId!, previewDigest: preview.digest, admissionRefundMinor, detail: "Producer reviewed the current failed supplier plan, exact original ticket allocations, and retained crew obligations.", confirmed: true });
  return { result, preview, items: await ledger.remedyItems(value.actor.tenantId, result.receipt.recordId!) };
}
async function committedRental() {
  const session = await store.createSession(undefined, "committed-disruption:" + randomUUID()), actor = session.actor;
  const protocol = await import("../src/server/supplier-protocol"), rfq = await import("../src/server/supplier-rfq"), rpc = await import("../src/app/api/enrolled-suppliers/[supplier]/rpc/route");
  const transport: import("../src/server/supplier-protocol").SupplierTransport = request => rpc.POST(request, { params: Promise.resolve({ supplier: new URL(request.url).pathname.split("/").at(-2)! }) });
  let show = await command(actor, { type: "load_incidents" }); const rfqId = randomUUID(); await rfq.beginSupplierRfq(actor, rfqId, show.revision);
  assert.equal((await rfq.collectSupplierRfq(actor.tenantId, rfqId, signal(), transport)).status, "complete");
  show = await store.getShow(actor.tenantId); const candidates = await controlledEngine(show);
  show = (await store.transactCommand(actor, randomUUID(), show.revision, { type: "controlled-engine" }, current => recordRescueRun(current, actor, candidates))).show;
  const candidate = candidates.find(item => item.id.startsWith("doors-brightline"))!; show = await command(actor, { type: "approve", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: candidate.approvals.map(item => item.id) });
  const offer = show.offers.find(item => item.supplierId === "brightline")!;
  const held = await protocol.callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: actor.tenantId, actorId: actor.id, action: { type: "hold", quoteId: offer.serviceQuote!.id, planDigest: show.approvedPlan!.digest, expectedRevision: show.revision, acceptCaptureTerms: true } }, signal(), transport);
  assert.equal(held.kind, "execution"); if (held.kind !== "execution") throw new Error("Controlled hold missing");
  show = await store.getShow(actor.tenantId);
  const checkout = await paymentService.handlePayment(actor, { type: "rental_checkout", expectedRevision: show.revision }, "http://localhost:4105"), root = await payments.readIntent(actor.tenantId, checkout.command.intentId);
  const resources = await payments.ownedResources(actor.tenantId, "brightline", root.id), orderId = resources.find(item => item.kind === "order")!.id; wire.orders.get(orderId)!.status = "APPROVED";
  assert.equal((await paymentService.handlePayment(actor, { type: "complete_checkout", intentId: root.id, state: paymentService.callbackState(root) }, "http://localhost:4105")).status, "succeeded");
  await protocol.callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: actor.tenantId, actorId: actor.id, action: { type: "confirm", executionId: held.execution.id } }, signal(), transport);
  const token = await store.createSupplierCapability(actor), supplierActor = (await store.getActor(token))!;
  return { ...session, actor, authority: { actor, sessionHash: sessionTokenHash(session.token) }, executionId: held.execution.id, root, orderId, supplierAuthority: { actor: supplierActor, sessionHash: sessionTokenHash(token) }, protocol, transport };
}

test("report and receipt are exact-session scoped; retry is idempotent and history remains immutable", async () => {
  const value = await planned(), before = await store.getShow(value.actor.tenantId), offer = before.offers[0]!;
  const envelope: DisruptionEnvelope = { idempotencyKey: randomUUID(), expectedRevision: before.revision, command: { type: "report", offerId: offer.id, offerRevision: offer.revision, executionId: null, availability: "delayed", earliestAt: atVenue("21:30"), observedAt: new Date().toISOString(), reference: "Controlled source after original commitment", detail: "The original delivery cannot arrive before 21:30 venue time.", confirmed: true } };
  const original = await act(value.authority, envelope.command, envelope), replay = await act(value.authority, envelope.command, envelope), recovered = await service.recoverDisruptionCommand(value.authority, envelope.idempotencyKey);
  assert.deepEqual(original.receipt, replay.receipt); assert.deepEqual(recovered.receipt, original.receipt); assert.equal(replay.replayed, true);
  const current = await store.getShow(value.actor.tenantId); assert.equal(current.supplierDisruptions!.length, 1); assert.deepEqual(current.offers, before.offers); assert.deepEqual(current.financialEvidence, before.financialEvidence); assert.deepEqual(current.crewAttestations, before.crewAttestations);
  await assert.rejects(() => act(value.authority, envelope.command, { ...envelope, expectedRevision: before.revision + 1 }), /different instructions/);
  const second = randomBytes(32).toString("base64url"); await database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [sessionTokenHash(second), value.actor.tenantId, value.actor]);
  await assert.rejects(() => service.recoverDisruptionCommand({ actor: value.actor, sessionHash: sessionTokenHash(second) }, envelope.idempotencyKey), /not recorded/);
  await assert.rejects(() => database.pool.query("UPDATE on_disruption_records SET digest='changed' WHERE tenant_id=$1", [value.actor.tenantId]), /immutable/);
  assert.equal((await payments.listIntents(value.actor.tenantId)).length, 0);
});
test("suppliers cannot report another supplier or inspect production financial decisions", async () => {
  const value = await planned(), token = await store.createSupplierCapability(value.actor), actor = (await store.getActor(token))!, authority = { actor, sessionHash: sessionTokenHash(token) };
  const own = await service.readDisruptionWorkspace(authority); assert.equal(own.access, "supplier"); assert.ok(own.offers.every(offer => offer.supplierId === "brightline")); assert.deepEqual(own.obligations, []);
  const other = value.show.offers.find(offer => offer.supplierId === "northside")!;
  await assert.rejects(() => act(authority, { type: "report", offerId: other.id, offerRevision: other.revision, executionId: null, availability: "unavailable", earliestAt: null, observedAt: new Date().toISOString(), reference: "Cross supplier attempt", detail: "This supplier session does not own the other equipment.", confirmed: true }), /only its own/);
  await assert.rejects(() => act(authority, { type: "assess" }), /production operator/);
  const offer = own.offers[0]!;
  await assert.rejects(() => act(value.authority, { type: "report", offerId: offer.id, offerRevision: offer.revision, executionId: null, availability: "available", earliestAt: atVenue("17:30"), observedAt: new Date().toISOString(), reference: "Operator cannot impersonate supplier", detail: "An operator cannot attest to the supplier's new availability.", confirmed: true }), /Only this supplier/);
});
test("bounded no-feasible assessment records all twelve candidates and source-backed reasons", async () => {
  const value = await planned(); for (const supplier of ["brightline", "northside", "sister"]) await report(value, supplier);
  const result = await act(value.authority, { type: "assess" }), assessment = result.workspace.assessments.at(-1)!;
  assert.equal(assessment.generated, 12); assert.equal(assessment.conclusion, "no_feasible_candidate"); assert.equal(assessment.enginePassed, 12); assert.match(assessment.scope, /bounded search/);
  const show = await store.getShow(value.actor.tenantId); assert.equal(show.runs.at(-1)!.id, assessment.runId); assert.ok(show.runs.at(-1)!.candidates.every(candidate => candidate.report.issues.some(issue => issue.code === "SUPPLIER_UNAVAILABLE")));
});
test("a changed production clock invalidates the retained assessment and preview without changing its report history", async () => {
  const value = await planned(); await report(value);
  const assessed = await act(value.authority, { type: "assess" }); assert.equal(assessed.workspace.assessmentIsCurrent, true);
  const oldPreview = await service.previewCancellation(value.authority, "cancel_show", 3500);
  await command(value.actor, { type: "advance", time: "16:10" });
  const current = await service.readDisruptionWorkspace(value.authority); assert.equal(current.assessmentIsCurrent, false); assert.deepEqual(current.reports, assessed.workspace.reports);
  await assert.rejects(() => act(value.authority, { type: "decide", mode: "cancel_show", assessmentId: assessed.receipt.recordId!, previewDigest: oldPreview.digest, admissionRefundMinor: 3500, detail: "A stale assessment cannot approve this current production cancellation.", confirmed: true }), /Reassess the current supplier/);
  const fresh = await act(value.authority, { type: "assess" }); assert.equal(fresh.workspace.assessmentIsCurrent, true);
  assert.notEqual(fresh.workspace.assessments.at(-1)!.sourceDigest, assessed.workspace.assessments.at(-1)!.sourceDigest);
  await assert.rejects(() => act(value.authority, { type: "decide", mode: "cancel_show", assessmentId: fresh.receipt.recordId!, previewDigest: oldPreview.digest, admissionRefundMinor: 3500, detail: "A fresh assessment still requires the current reviewed capture allocation.", confirmed: true }), /current original-capture allocation/);
  assert.equal((await store.getShow(value.actor.tenantId)).cancellationDecision, undefined);
});
test("a source mutation during engine work cannot publish or recover a stale assessment", async () => {
  const value = await planned(); await report(value); const original = await store.getShow(value.actor.tenantId), commandId = randomUUID();
  await assert.rejects(() => service.executeDisruptionCommand(value.authority, { idempotencyKey: commandId, expectedRevision: original.revision, command: { type: "assess" } }, async show => {
    const candidates = await controlledEngine(show); await report(value, "northside"); return candidates;
  }), /production changed/);
  const current = await store.getShow(value.actor.tenantId); assert.equal(current.disruptionAssessments?.length ?? 0, 0); assert.equal(current.runs.length, original.runs.length);
  await assert.rejects(() => service.recoverDisruptionCommand(value.authority, commandId), /not recorded/);
});
test("full cancellation subtracts the prior VIP remedy and refunds each original allocation exactly once", async () => {
  const value = await planned(), vip = await capture(value, "vip"), standard = await capture(value, "standard");
  await paymentService.handlePayment(value.actor, { type: "refund_perk", ticketId: vip.ticketId, expectedRevision: (await store.getShow(value.actor.tenantId)).revision }, "http://localhost:4105");
  const before = await store.getShow(value.actor.tenantId), sheetBefore = structuredClone(before.sheets), writesBefore = refundWrites().length;
  const approved = await decision(value); assert.equal(approved.preview.alreadyRefundedMinor, 1500); assert.equal(approved.preview.newRefundMinor, 7000); assert.equal(approved.preview.perkMinor, 0); assert.equal(approved.items.length, 2);
  assert.equal(refundWrites().length, writesBefore); // Approval is durable; it is not a provider receipt.
  for (const item of approved.items) assert.equal((await worker.runEventRemedy(value.actor.tenantId, approved.result.receipt.recordId!, item.allocation.id, signal())).status, "complete");
  for (const item of approved.items) assert.equal((await worker.runEventRemedy(value.actor.tenantId, approved.result.receipt.recordId!, item.allocation.id, signal())).status, "complete");
  const show = await store.getShow(value.actor.tenantId), summary = financialSummary(show);
  assert.equal(summary.grossCapturedMinor, 8500); assert.equal(summary.settledTicketRefundMinor, 8500); assert.equal(summary.ledgerTicketNetMinor, 0); assert.ok(show.tickets.every(ticket => ticket.status === "refunded"));
  assert.deepEqual(show.sheets.slice(0, sheetBefore.length), sheetBefore); assert.equal(show.sheets.at(-1)!.changes.at(-1)!.resourceIds.length, 11); assert.ok(show.tasks.some(task => task.id === "strike" && !task.cancellation)); assert.deepEqual(show.crewNextCalls, before.crewNextCalls);
  assert.equal(refundWrites().length, writesBefore + 2);
  for (const call of refundWrites().slice(writesBefore)) { assert.deepEqual(call.body!.amount, { currency_code: "USD", value: "35.00" }); assert.ok(call.body!.custom_id); assert.ok(call.requestId); assert.ok(call.durable); }
  assert.ok(refundWrites().slice(writesBefore).some(call => call.path.includes(wire.orders.get(standard.orderId)!.purchase_units[0].payments.captures[0].id)));
});
test("support-only partial admission compensation can be escalated to full cancellation without refunding prior cents again", async () => {
  const value = await planned(); await capture(value, "vip");
  const partial = await decision(value, "support_only", 1000); assert.equal(partial.preview.newRefundMinor, 2500);
  assert.equal((await worker.runEventRemedy(value.actor.tenantId, partial.result.receipt.recordId!, partial.items[0]!.allocation.id, signal())).status, "complete");
  const full = await decision(value, "cancel_show", 3500); assert.equal(full.preview.newRefundMinor, 2500); assert.equal(full.preview.alreadyRefundedMinor, 2500); assert.equal(full.preview.perkMinor, 0);
  assert.equal((await worker.runEventRemedy(value.actor.tenantId, full.result.receipt.recordId!, full.items[0]!.allocation.id, signal())).status, "complete");
  const show = await store.getShow(value.actor.tenantId); assert.equal(financialSummary(show).ledgerTicketNetMinor, 0); assert.equal(show.financialEvidence.filter(entry => entry.purpose === "event_remedy").length, 2);
});
test("a new provider refund blocks dispatch even when the saved preview and application ledger appear unchanged", async () => {
  const value = await planned(), ticket = await capture(value, "vip"), approved = await decision(value), before = refundWrites().length;
  const payment = wire.orders.get(ticket.orderId)!.purchase_units[0].payments;
  payment.refunds.push({ id: "CONTROLLED-OUTSIDE-REFUND", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" }, custom_id: "outside-operation" }); payment.captures[0].status = "PARTIALLY_REFUNDED";
  await assert.rejects(() => worker.runEventRemedy(value.actor.tenantId, approved.result.receipt.recordId!, approved.items[0]!.allocation.id, signal()), /new, pending, or unattributed/);
  assert.equal(refundWrites().length, before);
});
test("a lost response reconciles the same original refund and a pending refund blocks another decision", async () => {
  const lost = await planned(); await capture(lost, "standard"); const approved = await decision(lost), before = refundWrites().length;
  wire.failNext = "refund_lost"; assert.equal((await worker.runEventRemedy(lost.actor.tenantId, approved.result.receipt.recordId!, approved.items[0]!.allocation.id, signal())).status, "complete");
  assert.equal(refundWrites().length, before + 1); assert.equal((await worker.runEventRemedy(lost.actor.tenantId, approved.result.receipt.recordId!, approved.items[0]!.allocation.id, signal())).status, "complete"); assert.equal(refundWrites().length, before + 1);
  const pending = await planned(); await capture(pending, "vip"); const part = await decision(pending, "support_only", 1000);
  wire.failNext = "refund_pending"; assert.equal((await worker.runEventRemedy(pending.actor.tenantId, part.result.receipt.recordId!, part.items[0]!.allocation.id, signal())).status, "waiting");
  const preview = await service.previewCancellation(pending.authority, "cancel_show", 3500); assert.equal(preview.ready, false); assert.match(preview.blockers.join(" "), /unresolved provider outcome/);
});
test("exact approving-session expiry blocks a new dispatch even when the same actor has another active session", async () => {
  const value = await planned(); await capture(value, "standard"); const approved = await decision(value), before = refundWrites().length;
  const other = randomBytes(32).toString("base64url"); await database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [sessionTokenHash(other), value.actor.tenantId, value.actor]);
  await database.pool.query("UPDATE on_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [value.authority.sessionHash]);
  await assert.rejects(() => worker.runEventRemedy(value.actor.tenantId, approved.result.receipt.recordId!, approved.items[0]!.allocation.id, signal()), /exact session expired/);
  assert.equal(refundWrites().length, before); assert.equal((await ledger.readRemedyItem(value.actor.tenantId, approved.items[0]!.allocation.id)).progress.intentId, null);
});
test("stopping unstarted compensation retains the cancellation, previous payment and crew records", async () => {
  const value = await planned(); await capture(value, "vip"); const approved = await decision(value), before = await store.getShow(value.actor.tenantId), count = refundWrites().length;
  await act(value.authority, { type: "stop_remedies", decisionId: approved.result.receipt.recordId!, detail: "Pause unstarted refunds while reviewing the original ticket allocation." });
  assert.deepEqual(await worker.runEventRemedy(value.actor.tenantId, approved.result.receipt.recordId!, approved.items[0]!.allocation.id, signal()), { status: "needs_attention", code: "EVENT_REMEDY_AUTHORITY_ENDED" });
  const show = await store.getShow(value.actor.tenantId); assert.equal(show.cancellationDecision!.mode, "cancel_show"); assert.ok(show.cancellationDecision!.remediesStoppedAt); assert.deepEqual(show.financialEvidence, before.financialEvidence); assert.deepEqual(show.sheets, before.sheets); assert.equal(refundWrites().length, count);
});
test("a committed supplier can withdraw only its exact execution; explicit producer cancellation voids its one original authorization", async () => {
  const value = await committedRental(), before = await store.getShow(value.actor.tenantId), offer = before.offers.find(item => item.supplierId === "brightline")!;
  const authorization = before.financialEvidence.find(entry => entry.purpose === "rental" && entry.kind === "authorization")!;
  const changed = await act(value.supplierAuthority, { type: "report", offerId: offer.id, offerRevision: offer.revision, executionId: value.executionId, availability: "unavailable", earliestAt: null, observedAt: new Date().toISOString(), reference: "Controlled supplier second failure after commitment", detail: "The held console is no longer available after the original authorization and reservation confirmation.", confirmed: true });
  assert.equal(changed.workspace.reports.at(-1)!.attribution, "supplier_client");
  const current = await store.getShow(value.actor.tenantId); assert.equal(current.rentalExecutions![0]!.state, "reconfirmation_required"); assert.deepEqual(current.financialEvidence, before.financialEvidence);
  await assert.rejects(() => value.protocol.callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: value.actor.tenantId, actorId: value.actor.id, action: { type: "reconfirm", executionId: value.executionId } }, signal(), value.transport), /supplier or program changed/);
  const desk = await service.readDisruptionWorkspace(value.authority); assert.equal(desk.rentalCommitments[0]!.canCancel, true);
  const cancelled = await act(value.authority, { type: "cancel_rental", executionId: value.executionId, detail: "Producer approved the cancellation of the exact fully uncaptured original authorization.", confirmed: true });
  const intent = await payments.readIntent(value.actor.tenantId, cancelled.receipt.recordId!);
  assert.equal(intent.approvedSessionHash, value.authority.sessionHash); assert.equal(intent.parentId, value.root.id); assert.equal(intent.command.action.kind, "void_authorization");
  const writesBefore = wire.calls.filter(call => call.path.endsWith("/void")).length;
  assert.equal((await paymentService.reconcilePaymentIntent(value.actor.tenantId, intent.id, signal(), true)).status, "complete");
  assert.equal((await paymentService.reconcilePaymentIntent(value.actor.tenantId, intent.id, signal(), true)).status, "complete");
  const writes = wire.calls.filter(call => call.path.endsWith("/void")); assert.equal(writes.length, writesBefore + 1); assert.equal(writes.at(-1)!.path, `/v2/payments/authorizations/${authorization.providerResourceId}/void`); assert.ok(writes.at(-1)!.durable);
  const final = await store.getShow(value.actor.tenantId); assert.equal(final.rentalExecutions![0]!.state, "cancelled"); assert.equal(financialSummary(final).cancelledAuthorizationMinor, 78000); assert.equal(financialSummary(final).remainingRentalAuthorizationMinor, 0); assert.equal(final.financialEvidence.filter(entry => entry.kind === "refund").length, 0);
});
test("revocation during fresh provider budget reads is rechecked before any refund dispatch", async () => {
  const value = await planned(); await capture(value, "standard"); const approved = await decision(value), before = refundWrites().length;
  let revoked = false; wire.before = async call => { if (!revoked && call.method === "GET" && call.path.startsWith("/v2/checkout/orders/")) { revoked = true; await database.pool.query("UPDATE on_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [value.authority.sessionHash]); } };
  try { await assert.rejects(() => worker.runEventRemedy(value.actor.tenantId, approved.result.receipt.recordId!, approved.items[0]!.allocation.id, signal()), /exact session expired/); }
  finally { wire.before = null; }
  assert.equal(revoked, true); assert.equal(refundWrites().length, before);
});
test("original rental cancellation rechecks its exact approving session after provider readback", async () => {
  const value = await committedRental();
  const approved = await act(value.authority, { type: "cancel_rental", executionId: value.executionId, detail: "Controlled exact cancellation approval for the original uncaptured authorization.", confirmed: true });
  const anotherToken = randomBytes(32).toString("base64url"); await database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [sessionTokenHash(anotherToken), value.actor.tenantId, value.actor]);
  const before = wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/void")).length;
  let revoked = false;
  wire.before = async call => { if (!revoked && call.method === "GET" && call.path.startsWith("/v2/checkout/orders/")) { revoked = true; await database.pool.query("UPDATE on_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [value.authority.sessionHash]); } };
  try { await assert.rejects(() => paymentService.reconcilePaymentIntent(value.actor.tenantId, approved.receipt.recordId!, signal(), true), /exact approving session ended/); }
  finally { wire.before = null; }
  assert.equal(revoked, true); assert.equal(wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/void")).length, before);
});
test("eighty original captures retain $3,370 gross while cancellation adds only $2,800 after the 38 VIP remedies", async () => {
  const value = await planned(); const vipTickets: string[] = [];
  for (let index = 0; index < 80; index++) { const item = await capture(value, index < 42 ? "standard" : "vip"); if (index >= 42) vipTickets.push(item.ticketId); }
  for (const ticketId of vipTickets) await paymentService.handlePayment(value.actor, { type: "refund_perk", ticketId, expectedRevision: (await store.getShow(value.actor.tenantId)).revision }, "http://localhost:4105");
  const approved = await decision(value); assert.equal(approved.preview.capturedTickets, 80); assert.equal(approved.preview.alreadyRefundedMinor, 57000); assert.equal(approved.preview.newRefundMinor, 280000); assert.equal(approved.items.length, 80);
  const before = refundWrites().length;
  for (const { allocation } of approved.items) assert.equal((await worker.runEventRemedy(value.actor.tenantId, approved.result.receipt.recordId!, allocation.id, signal())).status, "complete");
  const show = await store.getShow(value.actor.tenantId), finance = financialSummary(show);
  assert.equal(refundWrites().length, before + 80); assert.equal(finance.grossCapturedMinor, 337000); assert.equal(finance.settledTicketRefundMinor, 337000); assert.equal(finance.ledgerTicketNetMinor, 0); assert.equal(show.tickets.length, 80); assert.equal(show.financialEvidence.filter(entry => entry.purpose === "vip_remedy").length, 38);
});
test("disruption assessment runs the actual Bryntum Node engine on all twelve bounded alternatives", async () => {
  const value = await planned(); for (const supplier of ["brightline", "northside", "sister"]) await report(value, supplier);
  const show = await store.getShow(value.actor.tenantId);
  const assessed = await service.executeDisruptionCommand(value.authority, { idempotencyKey: randomUUID(), expectedRevision: show.revision, command: { type: "assess" } });
  const current = await store.getShow(value.actor.tenantId), candidates = current.runs.at(-1)!.candidates;
  assert.equal(candidates.length, 12); assert.ok(candidates.every(candidate => candidate.report.engine && candidate.report.engine.status !== "unavailable" && candidate.report.engine.dates.length > 70));
  assert.equal(assessed.workspace.assessments.at(-1)!.conclusion, "no_feasible_candidate");
});
test("support-only recovery accepts fresh supplier terms and a new plan without resurrecting the cancelled headliner or releasing crew calls", async () => {
  const value = await committedRental(), original = await store.getShow(value.actor.tenantId), offer = original.offers.find(item => item.supplierId === "brightline")!;
  await capture(value, "vip");
  await act(value.supplierAuthority, { type: "report", offerId: offer.id, offerRevision: offer.revision, executionId: value.executionId, availability: "unavailable", earliestAt: null, observedAt: new Date().toISOString(), reference: "Controlled committed unit failure", detail: "The original held unit cannot fulfill its approved production window.", confirmed: true });
  const cancellation = await act(value.authority, { type: "cancel_rental", executionId: value.executionId, detail: "Producer reviewed the original uncaptured authorization before replacing this supplier commitment.", confirmed: true });
  await paymentService.reconcilePaymentIntent(value.actor.tenantId, cancellation.receipt.recordId!, signal(), true);
  const partial = await decision(value, "support_only", 1000);
  await act(value.supplierAuthority, { type: "report", offerId: offer.id, offerRevision: offer.revision, executionId: value.executionId, availability: "available", earliestAt: offer.deliveryAt, observedAt: new Date().toISOString(), reference: "Controlled supplier availability reconfirmation", detail: "The supplier has re-established availability and will issue a new independent quote for producer review.", confirmed: true });
  const rfq = await import("../src/server/supplier-rfq"), id = randomUUID(); let show = await store.getShow(value.actor.tenantId);
  await rfq.beginSupplierRfq(value.actor, id, show.revision); assert.equal((await rfq.collectSupplierRfq(value.actor.tenantId, id, signal(), value.transport)).status, "complete");
  show = await store.getShow(value.actor.tenantId); const candidates = await controlledEngine(show), candidate = candidates.find(item => item.family === "doors" && item.patch.offerId === offer.id)!;
  assert.equal(candidate.patch.programMode, "support_only"); assert.ok(["feasible", "feasible_with_approval"].includes(candidate.report.status), JSON.stringify(candidate.report.issues)); assert.ok(!candidate.patch.tasks.some(task => ["headliner", "headliner-arrival", "quiet-prep", "changeover"].includes(task.id)));
  assert.equal(candidate.patch.crewFinishAt, original.tasks.find(task => task.id === "strike")!.end);
  show = (await store.transactCommand(value.actor, randomUUID(), show.revision, { type: "controlled-support-recovery" }, current => recordRescueRun(current, value.actor, candidates))).show;
  show = await command(value.actor, { type: "approve", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: candidate.approvals.map(item => item.id) });
  assert.equal(hasCurrentSupportOnlyPlan(show), true); assert.equal(show.cancellationDecision!.id, partial.result.receipt.recordId!);
  assert.equal(readiness(show, "HEADLINER_START").gates.find(gate => gate.id === "disruption")!.complete, false);
  const fresh = show.offers.find(item => item.supplierId === "brightline")!;
  const held = await value.protocol.callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: value.actor.tenantId, actorId: value.actor.id, action: { type: "hold", quoteId: fresh.serviceQuote!.id, planDigest: show.approvedPlan!.digest, expectedRevision: show.revision, acceptCaptureTerms: true } }, signal(), value.transport);
  assert.equal(held.kind, "execution");
  show = await store.getShow(value.actor.tenantId); assert.equal(show.rentalExecutions!.length, 2); assert.equal(show.rentalExecutions![0]!.state, "cancelled");
  const next = await paymentService.handlePayment(value.actor, { type: "rental_checkout", expectedRevision: show.revision }, "http://localhost:4105"); assert.equal(next.status, "succeeded"); assert.notEqual(next.command.intentId, value.root.id);
  // The operating plan changed; the immutable customer remedy keeps its original financial grant.
  assert.equal(partial.items[0]!.allocation.amountMinor, 2500);
  assert.equal((await worker.runEventRemedy(value.actor.tenantId, partial.result.receipt.recordId!, partial.items[0]!.allocation.id, signal())).status, "complete");
  const originalRemedy = await ledger.readRemedyItem(value.actor.tenantId, partial.items[0]!.allocation.id);
  const remedyIntent = await payments.readIntent(value.actor.tenantId, originalRemedy.progress.intentId!);
  assert.equal(remedyIntent.planVersion, original.planVersion); assert.equal(remedyIntent.planDigest, original.approvedPlan!.digest);
  assert.equal(financialSummary(await store.getShow(value.actor.tenantId)).settledTicketRefundMinor, 2500);
});
test("an accepted captured rental survives show cancellation and can close its original damage hold only after an attributed return", async () => {
  const value = await committedRental(), delivery = await import("../src/server/delivery-service");
  const driverLink = await store.createDeliveryCapability(value.actor, "driver"), inspectorLink = await store.createDeliveryCapability(value.actor, "inspector");
  const driver = (await store.getActor(driverLink.token))!, inspector = (await store.getActor(inspectorLink.token))!;
  let show = await command(value.actor, { type: "advance", time: "17:15" });
  const issued = await delivery.issueDelivery(value.actor, value.executionId, randomUUID(), show.revision);
  const scanned = await delivery.scanDelivery(driver, issued.token!, randomUUID()); show = await store.getShow(value.actor.tenantId);
  await delivery.inspectDelivery(inspector, { executionId: value.executionId, deliveryId: scanned.id, version: scanned.version, commandId: randomUUID(), expectedRevision: show.revision, decision: "accept", condition: { report: "Controlled inspection fixture: safe desk, power-on check and all required accessories.", powerOn: true, accessories: true, safeCondition: true } });
  show = await store.getShow(value.actor.tenantId); const feeIntent = show.rentalExecutions![0]!.captureIntentId!;
  assert.equal((await paymentService.reconcilePaymentIntent(value.actor.tenantId, feeIntent, signal(), true)).status, "complete");
  show = await store.getShow(value.actor.tenantId); const offer = show.offers.find(item => item.supplierId === "brightline")!;
  await act(value.supplierAuthority, { type: "report", offerId: offer.id, offerRevision: offer.revision, executionId: value.executionId, availability: "unavailable", earliestAt: null, observedAt: new Date().toISOString(), reference: "Controlled later unit failure after acceptance", detail: "The accepted equipment is no longer usable for the remaining production; its original fee is still recorded.", confirmed: true });
  const desk = await service.readDisruptionWorkspace(value.authority); assert.equal(desk.rentalCommitments[0]!.canCancel, false); assert.equal(desk.rentalCommitments[0]!.capturedMinor, 48000);
  await assert.rejects(() => act(value.authority, { type: "cancel_rental", executionId: value.executionId, detail: "Attempting to void a captured rental is not an uncaptured cancellation.", confirmed: true }), /unfulfilled or supplier-returned rejected rental/);
  await decision(value); show = await store.getShow(value.actor.tenantId);
  await value.protocol.callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: value.actor.tenantId, actorId: value.supplierAuthority.actor.id, action: { type: "return", executionId: value.executionId, expectedRevision: show.revision, detail: "Controlled supplier return inspection after cancellation: original unit returned without damage." } }, signal(), value.transport);
  show = await store.getShow(value.actor.tenantId);
  const released = await paymentService.handlePayment(value.actor, { type: "release_rental_hold", intentId: value.root.id, expectedRevision: show.revision }, "http://localhost:4105"); assert.equal(released.status, "succeeded");
  const final = await store.getShow(value.actor.tenantId), finance = financialSummary(final);
  assert.equal(finance.rentalCapturedMinor, 48000); assert.equal(finance.releasedMinor, 30000); assert.equal(finance.cancelledAuthorizationMinor, 0); assert.equal(finance.remainingRentalAuthorizationMinor, 0);
  assert.equal(final.financialEvidence.filter(entry => entry.kind === "refund" && entry.purpose === "rental").length, 0);
});
