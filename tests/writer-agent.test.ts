/** Deterministic writer fact check. Pure domain logic: no database, provider or clock. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWriterDraft, checkWriterText, writerBlockers, writerDraftSchema, writerFacts, type WriterFacts } from "../src/domain/audience/writer";
import type { AudienceEvent, AudienceTicketReceipt } from "../src/domain/audience/contracts";

const zone = "America/Chicago", at = (time: string) => new Date(`2026-11-14T${time}:00-06:00`).toISOString();
const event = (value: Partial<AudienceEvent> = {}): AudienceEvent => ({ title: "The Night Ferries", support: "Juniper Lane", venue: "Alder Hall", showDate: "2026-11-14", zone, program: "full", scheduleStatus: "current", label: "Current approved program", notice: "", doorsAt: at("19:00"), performances: [{ id: "support", title: "Juniper Lane", startsAt: at("20:00"), endsAt: at("20:25"), cancelled: false }, { id: "headliner", title: "The Night Ferries", startsAt: at("20:45"), endsAt: at("22:15"), cancelled: false }], vip: "cancelled", admission: "not_open", admissionLabel: "", source: { planVersion: 2, sheetVersion: 2, publishedAt: at("16:30"), digest: "0".repeat(64), provenance: "sample" }, ...value });
const receipt = (id: string, status: AudienceTicketReceipt["remedy"]["status"], tier: "vip" | "standard" = "vip"): AudienceTicketReceipt => ({ ticketId: id, tier, captureReference: "••••" + id, capturedAt: at("12:00"), currency: "USD", admissionMinor: 3500, perkMinor: tier === "vip" ? 1500 : 0, grossMinor: tier === "vip" ? 5000 : 3500, originalDigest: "1".repeat(64), provenance: "sample", verification: "verified", refunds: [], instructions: [], confirmedRefundMinor: status === "complete" ? 1500 : 0, currentlyVerifiedRefundMinor: status === "complete" ? 1500 : 0, unallocatedRefundMinor: 0, remainingAdmissionMinor: 3500, remainingPerkMinor: status === "complete" ? 0 : 1500, remedy: tier === "vip" ? { admissionMinor: 0, perkMinor: 1500, confirmedMinor: status === "complete" ? 1500 : 0, remainingMinor: status === "complete" ? 0 : 1500, status } : { admissionMinor: 0, perkMinor: 0, confirmedMinor: 0, remainingMinor: 0, status: "not_applicable" }, admission: "eligible", notice: "" });
const show = (doors = "19:00") => ({ showDate: "2026-11-14", sheets: [{ tasks: [{ id: "doors", start: at(doors) }] }] }) as unknown as Parameters<typeof writerFacts>[0];
const pendingFacts = () => writerFacts(show(), event(), [receipt("a", "pending"), receipt("b", "complete"), receipt("c", "pending"), receipt("s", "not_applicable", "standard")], "vip_soundcheck_refund", "vip");
const confirmedFacts = () => writerFacts(show(), event(), [receipt("a", "complete"), receipt("b", "complete")], "vip_soundcheck_refund", "vip");
const failed = (facts: WriterFacts, text: string) => checkWriterText(facts, text).checks.filter(row => row.status === "fail").map(row => row.id);
const good = "The VIP soundcheck for The Night Ferries at Alder Hall has been cancelled. A $15.00 refund for soundcheck access has been approved, and your ticket page shows its current status. Doors open at 7:00 PM as scheduled.";

test("facts are derived from the approved plan and ledger projection, with no ticket or payment identity", () => {
  const facts = pendingFacts();
  assert.equal(facts.doors.time, "7:00 PM"); assert.equal(facts.doors.changed, false); assert.equal(facts.event.date, "Saturday, November 14, 2026");
  assert.deepEqual(facts.remedy, { item: "soundcheck access", amount: "$15.00", amountMinor: 1500, tickets: 3, confirmed: 1, notYetConfirmed: 2, unknown: 0, state: "not_all_confirmed" });
  assert.deepEqual(facts.performances.map(row => [row.act, row.start, row.end]), [["support", "8:00 PM", "8:25 PM"], ["headliner", "8:45 PM", "10:15 PM"]]);
  const sent = JSON.stringify(facts); for (const forbidden of ["••••", "ticketId", "capture", "1".repeat(64), "0".repeat(64)]) assert.ok(!sent.includes(forbidden));
  assert.equal(confirmedFacts().remedy!.state, "all_confirmed");
  assert.deepEqual(writerBlockers(facts, event()), []);
});

test("a draft that restates the approved facts passes every check", () => {
  const result = checkWriterDraft(pendingFacts(), writerDraftSchema.parse({ subject: "The Night Ferries: VIP soundcheck update", body: good, shortVariant: "VIP soundcheck cancelled. $15.00 refund approved; see your ticket page for its status. Doors 7:00 PM.", factsUsed: ["event_title", "venue", "doors_time", "refund_amount", "refund_status", "vip_soundcheck_status"] }));
  assert.equal(result.passed, true, JSON.stringify(result.checks.filter(row => row.status === "fail")));
  assert.deepEqual(result.checks.map(row => row.id), ["times", "durations", "amounts", "refund_status", "counts", "programme", "promises", "private_data", "facts_used"]);
  assert.deepEqual(failed(pendingFacts(), "Doors open at 7:00. Juniper Lane is on stage at 8:00 PM and The Night Ferries at 8:45 PM."), []);
});

test("wrong times are rejected, including an approved performance time stated as the doors time", () => {
  assert.deepEqual(failed(pendingFacts(), good.replace("7:00 PM", "7:30 PM")), ["times"]);
  assert.deepEqual(failed(pendingFacts(), "Doors open at 8:00 PM."), ["times"]);
  assert.deepEqual(failed(pendingFacts(), "Doors open at 19:30."), ["times"]);
  assert.deepEqual(failed(pendingFacts(), "Doors open at 7:00 PM. Please arrive 30 minutes early."), ["durations"]);
  const moved = writerFacts(show("19:00"), event({ doorsAt: at("19:20") }), [receipt("a", "pending")], "doors_delay", "all");
  assert.equal(moved.doors.delayMinutes, 20); assert.deepEqual(writerBlockers(moved, event({ doorsAt: at("19:20") })), []);
  assert.deepEqual(failed(moved, "Doors now open at 7:20 PM, 20 minutes later than the originally published 7:00 PM."), []);
  assert.deepEqual(failed(moved, "Doors now open at 7:20 PM, 45 minutes later than planned."), ["durations"]);
  assert.deepEqual(failed(moved, "Doors open at 7:20 PM as scheduled."), ["programme"]);
  assert.deepEqual(failed(pendingFacts(), "Doors are delayed until 7:00 PM."), ["programme"]);
});

test("wrong amounts are rejected, including a real ticket amount stated as the refund", () => {
  assert.deepEqual(failed(pendingFacts(), good.replace("$15.00", "$25.00")), ["amounts"]);
  assert.deepEqual(failed(pendingFacts(), good.replace("$15.00", "$35.00")), ["amounts"]);
  assert.deepEqual(failed(pendingFacts(), good.replace("A $15.00 refund", "A 20 dollars refund")), ["amounts"]);
  assert.deepEqual(failed(pendingFacts(), "Your $35.00 admission is unchanged. A $15.00 refund for soundcheck access has been approved."), []);
});

test("a premature completion claim is rejected while the ledger shows unconfirmed refunds, and allowed only when all are confirmed", () => {
  for (const claim of ["Your $15.00 has been refunded.", "Your refund has been issued.", "We have refunded your $15.00 soundcheck access.", "Your $15.00 refund is complete.", "The refund of $15.00 was processed."]) {
    assert.deepEqual(failed(pendingFacts(), claim), ["refund_status"], claim);
    assert.deepEqual(failed(confirmedFacts(), claim), [], claim);
  }
  assert.deepEqual(failed(pendingFacts(), "Your $15.00 refund has been approved and is not yet complete."), []);
  assert.deepEqual(failed(confirmedFacts(), "Your $15.00 refund is pending."), ["refund_status"]);
  assert.deepEqual(failed(pendingFacts(), "Your $15.00 refund will arrive within 3 business days."), ["refund_status"]);
  const none = writerFacts(show(), event({ vip: "scheduled" }), [receipt("s", "not_applicable", "standard")], "doors_as_scheduled", "all");
  assert.equal(none.remedy, null); assert.deepEqual(failed(none, "Doors open at 7:00 PM. A refund is on its way."), ["refund_status"]);
});

test("counts, unapproved promises, programme contradictions and private data are rejected", () => {
  assert.deepEqual(failed(pendingFacts(), "All 38 VIP refunds were approved at $15.00 each."), ["counts"]);
  assert.deepEqual(failed(pendingFacts(), "All 3 VIP refunds were approved at $15.00 each."), []);
  assert.deepEqual(failed(pendingFacts(), good + " You will also receive a complimentary drink voucher."), ["promises"]);
  assert.deepEqual(failed(pendingFacts(), "Tonight's show is cancelled."), ["programme"]);
  assert.deepEqual(failed(writerFacts(show(), event({ vip: "scheduled" }), [receipt("a", "not_applicable")], "doors_as_scheduled", "all"), "The VIP soundcheck is cancelled."), ["programme"]);
  assert.deepEqual(failed(pendingFacts(), good + " Questions? Write to help@example.com."), ["private_data"]);
  assert.deepEqual(checkWriterText(pendingFacts(), good, ["doors_time", "artist_apology"]).checks.filter(row => row.status === "fail").map(row => row.id), ["facts_used"]);
});

test("a purpose the approved state does not support is blocked before any model request", () => {
  const unchanged = event(), receipts = [receipt("a", "pending")];
  assert.match(writerBlockers(writerFacts(show(), unchanged, receipts, "doors_delay", "all"), unchanged)[0]!, /does not move doors later/);
  assert.match(writerBlockers(writerFacts(show(), unchanged, receipts, "event_cancellation", "all"), unchanged)[0]!, /No cancellation/);
  assert.match(writerBlockers(writerFacts(show(), unchanged, receipts, "vip_soundcheck_refund", "all"), unchanged)[0]!, /VIP ticket holders/);
  const scheduled = event({ vip: "scheduled" }); assert.match(writerBlockers(writerFacts(show(), scheduled, receipts, "vip_soundcheck_refund", "vip"), scheduled)[0]!, /does not cancel/);
  const review = event({ scheduleStatus: "under_review" }); assert.match(writerBlockers(writerFacts(show(), review, receipts, "doors_as_scheduled", "all"), review)[0]!, /under review/);
});
