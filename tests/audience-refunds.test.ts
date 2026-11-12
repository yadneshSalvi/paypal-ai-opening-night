/** Positive financial fixtures use actual commerce services, installed SDK and controlled wire only. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { audienceHarness } from "./audience-harness";
const h = await audienceHarness(); after(h.close);
const disruptions = await import("../src/server/disruptions/service"), disruptionStore = await import("../src/server/disruptions/store"), worker = await import("../src/server/disruptions/worker");
async function published() {
  const value = await h.accepted({ replacePlan: false });
  await h.command(value.actor, { type: "publish" });
  const show = await h.store.getShow(value.actor.tenantId), candidate = show.runs.flatMap(run => run.candidates).find(item => item.id === show.approvedPlan!.candidateId)!;
  assert.equal(candidate.report.engine?.status, "passed"); assert.equal((await h.audience.readAudienceWorkspace(value.authority)).event.scheduleStatus, "current");
  return value;
}
async function refund(value: Awaited<ReturnType<typeof published>>, ticketId: string) {
  return h.paymentService.handlePayment(value.actor, { type: "refund_perk", ticketId, expectedRevision: (await h.store.getShow(value.actor.tenantId)).revision }, "http://127.0.0.1:4594");
}
async function cancel(value: Awaited<ReturnType<typeof published>>, mode: "cancel_show" | "support_only", admissionRefundMinor: number) {
  let show = await h.store.getShow(value.actor.tenantId), offer = show.offers.find(item => item.supplierId === "brightline")!, execution = show.rentalExecutions!.find(item => item.supplierId === "brightline")!;
  await disruptions.executeDisruptionCommand(value.authority, { idempotencyKey: randomUUID(), expectedRevision: show.revision, command: { type: "report", offerId: offer.id, offerRevision: offer.revision, executionId: execution.id, availability: "unavailable", earliestAt: null, observedAt: new Date().toISOString(), reference: "Controlled audience cancellation prerequisite", detail: "Controlled supplier service reports the exact original unit unavailable. Actual equipment and people are not claimed.", confirmed: true } });
  show = await h.store.getShow(value.actor.tenantId);
  const assessed = await disruptions.executeDisruptionCommand(value.authority, { idempotencyKey: randomUUID(), expectedRevision: show.revision, command: { type: "assess" } });
  const preview = await disruptions.previewCancellation(value.authority, mode, admissionRefundMinor); assert.equal(preview.ready, true, preview.blockers.join("; "));
  const decision = await disruptions.executeDisruptionCommand(value.authority, { idempotencyKey: randomUUID(), expectedRevision: (await h.store.getShow(value.actor.tenantId)).revision, command: { type: "decide", mode, assessmentId: assessed.receipt.recordId!, previewDigest: preview.digest, admissionRefundMinor, detail: "Producer reviewed the controlled cancellation and every original capture allocation; no physical show or actual provider outcome is claimed.", confirmed: true } });
  return { decisionId: decision.receipt.recordId!, preview, items: await disruptionStore.remedyItems(value.actor.tenantId, decision.receipt.recordId!) };
}

test("native-validated publication and exact controlled VIP refund retain the original admission/perk receipt", async () => {
  const value = await published(), original = await h.capture(value), link = await h.invite(value, original.ticket.id), before = await h.attendee.readAttendee(link.reader);
  assert.equal((await refund(value, original.ticket.id)).status, "succeeded");
  const wireBefore = h.wire.calls.length, read = await h.attendee.readAttendee(link.reader);
  assert.equal(read.receipt.originalDigest, before.receipt.originalDigest); assert.equal(read.receipt.confirmedRefundMinor, 1500); assert.equal(read.receipt.currentlyVerifiedRefundMinor, 1500);
  assert.equal(read.receipt.refunds.length, 1); assert.equal(read.receipt.refunds[0]!.admissionMinor, 0); assert.equal(read.receipt.refunds[0]!.perkMinor, 1500); assert.equal(read.receipt.refunds[0]!.status, "confirmed"); assert.equal(read.receipt.instructions[0]!.status, "confirmed");
  assert.equal(read.receipt.remainingAdmissionMinor, 3500); assert.equal(read.receipt.remainingPerkMinor, 0); assert.equal(read.receipt.admission, "eligible"); assert.equal(read.event.vip, "cancelled"); assert.equal(read.event.admission, "not_open"); assert.equal(h.wire.calls.length, wireBefore);
  const draft = await h.draft(value, [link.capabilityId], "vip_remedy"); assert.match(draft.draft.recipients[0]!.content.body, /Historical confirmed refunds: \$15\.00/); assert.match(draft.draft.recipients[0]!.content.body, /admission \$35\.00/);
});

test("pending controlled refund is an unknown original instruction, never a completed refund or fresh paid eligibility", async () => {
  const value = await published(), original = await h.capture(value), link = await h.invite(value, original.ticket.id), draft = await h.draft(value, [link.capabilityId], "vip_remedy"), before = await h.audience.readAudienceWorkspace(value.authority);
  h.wire.failNext = "refund_pending"; const operation = await refund(value, original.ticket.id); assert.equal(operation.status, "pending_reconciliation");
  const callsBefore = h.wire.calls.length, read = await h.attendee.readAttendee(link.reader), after = await h.audience.readAudienceWorkspace(value.authority);
  assert.equal(read.receipt.confirmedRefundMinor, 0); assert.equal(read.receipt.currentlyVerifiedRefundMinor, 0); assert.equal(read.receipt.refunds.length, 0); assert.equal(read.receipt.instructions.length, 1); assert.equal(read.receipt.instructions[0]!.amountMinor, 1500); assert.equal(read.receipt.instructions[0]!.status, "unknown"); assert.equal(read.receipt.remedy.status, "unknown"); assert.equal(read.receipt.admission, "unverified");
  assert.notEqual(after.sourceDigest, before.sourceDigest); assert.equal((await h.audience.readAudienceMessage(value.authority, draft.draft.id)).preview.ready, false); assert.equal(h.wire.calls.length, callsBefore);
  await assert.rejects(h.audienceAct(value.authority, { type: "create_invite", ticketId: original.ticket.id, receiptDigest: read.receipt.originalDigest, validForMinutes: 60, confirmed: true }), { code: "AUDIENCE_ORIGINAL_CAPTURE_REQUIRED" });
});

test("full cancellation preserves the prior perk refund and shows each original residual admission refund exactly once", async () => {
  const value = await published(), vip = await h.capture(value), standard = await h.capture(value, "standard"), a = await h.invite(value, vip.ticket.id), b = await h.invite(value, standard.ticket.id);
  await refund(value, vip.ticket.id); const original = await h.attendee.readAttendee(a.reader), cancellation = await cancel(value, "cancel_show", 3500);
  assert.equal(cancellation.preview.alreadyRefundedMinor, 1500); assert.equal(cancellation.preview.newRefundMinor, 7000);
  const pending = await h.attendee.readAttendee(a.reader); assert.equal(pending.event.program, "cancelled"); assert.equal(pending.event.doorsAt, null); assert.equal(pending.event.admission, "cancelled"); assert.equal(pending.receipt.confirmedRefundMinor, 1500); assert.equal(pending.receipt.remedy.remainingMinor, 3500);
  const refundWrites = () => h.wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/refund")), before = refundWrites().length;
  for (const item of cancellation.items) assert.equal((await worker.runEventRemedy(value.actor.tenantId, cancellation.decisionId, item.allocation.id, AbortSignal.timeout(15000))).status, "complete");
  for (const item of cancellation.items) assert.equal((await worker.runEventRemedy(value.actor.tenantId, cancellation.decisionId, item.allocation.id, AbortSignal.timeout(15000))).status, "complete");
  assert.equal(refundWrites().length, before + 2);
  const vipRead = await h.attendee.readAttendee(a.reader), standardRead = await h.attendee.readAttendee(b.reader);
  assert.equal(vipRead.receipt.originalDigest, original.receipt.originalDigest); assert.equal(vipRead.receipt.grossMinor, 5000); assert.equal(vipRead.receipt.refunds.length, 2); assert.equal(vipRead.receipt.confirmedRefundMinor, 5000); assert.equal(vipRead.receipt.remainingAdmissionMinor, 0); assert.equal(vipRead.receipt.remainingPerkMinor, 0); assert.equal(vipRead.receipt.admission, "refunded"); assert.equal(vipRead.receipt.remedy.status, "complete");
  assert.equal(standardRead.receipt.grossMinor, 3500); assert.equal(standardRead.receipt.confirmedRefundMinor, 3500); assert.equal(standardRead.receipt.refunds.length, 1); assert.equal(standardRead.receipt.admission, "refunded");
  const draft = await h.draft(value, [a.capabilityId, b.capabilityId]); assert.match(draft.draft.recipients[0]!.content.body, /event cancelled|Event cancelled/);
});

test("support-only cancellation keeps the headliner cancelled and unreconciled compensation visibly separate", async () => {
  const value = await published(), original = await h.capture(value), link = await h.invite(value, original.ticket.id);
  const cancellation = await cancel(value, "support_only", 1000), before = h.wire.calls.length, read = await h.attendee.readAttendee(link.reader);
  assert.equal(read.event.program, "support_only"); assert.equal(read.event.scheduleStatus, "under_review"); assert.equal(read.event.performances.find(item => item.id === "headliner")!.cancelled, true);
  assert.equal(read.receipt.remedy.admissionMinor, 1000); assert.equal(read.receipt.remedy.perkMinor, 1500); assert.equal(read.receipt.remedy.remainingMinor, 2500); assert.equal(read.receipt.confirmedRefundMinor, 0); assert.equal(h.wire.calls.length, before);
  assert.equal((await worker.runEventRemedy(value.actor.tenantId, cancellation.decisionId, cancellation.items[0]!.allocation.id, AbortSignal.timeout(15000))).status, "complete");
  const completed = await h.attendee.readAttendee(link.reader); assert.equal(completed.receipt.confirmedRefundMinor, 2500); assert.equal(completed.receipt.remainingAdmissionMinor, 2500); assert.equal(completed.receipt.remainingPerkMinor, 0); assert.equal(completed.event.admission, "suspended");
});
