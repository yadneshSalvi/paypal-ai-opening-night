/** Mounted attendee banner and line states in jsdom. Only CSS-module loading is adapted; this is not layout proof. */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { act } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { AudienceEvent, AudienceRefund, AudienceTicketReceipt } from "../src/domain/audience/contracts";
import type { ShowSnapshot } from "../src/domain/contracts";
import { audienceEvent, receiptReference } from "../src/domain/audience/policy";
import { atVenue } from "../src/domain/time";
import { approved, base, publishForTest } from "./helpers";
register("../scripts/qa/audience-css-loader.mjs", import.meta.url);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/attendee", pretendToBeVisual: true });
for (const name of ["window", "document", "HTMLElement", "Element", "Node", "Event", "MutationObserver"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const { createRoot } = await import("react-dom/client");
const { DoorsBanner, ReceiptLineStates, doorsBanner, receiptLines } = await import("../src/components/audience/doors-banner");

let root: Root | null = null;
async function mount(node: React.ReactNode) { const host = document.body.appendChild(document.createElement("div")); root = createRoot(host); await act(async () => root!.render(node)); return host; }
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });
/** The same derivation the server projection adds to the attendee view. */
const originalDoors = (show: ShowSnapshot) => [...show.sheets].sort((a, b) => a.version - b.version)[0]?.tasks.find(task => task.id === "doors")?.baselineStart ?? null;

test("a published baseline reads exactly as the plan's show-day line", async () => {
  const { show } = base(), event = audienceEvent(show);
  assert.equal(event.scheduleStatus, "current");
  assert.equal(doorsBanner(event, originalDoors(show)).text, "Doors 19:00 as scheduled · Juniper Lane 20:00 · The Night Ferries 20:45");
  const host = await mount(<DoorsBanner event={event} originalDoorsAt={originalDoors(show)} />), banner = host.querySelector("section")!;
  assert.equal(banner.getAttribute("data-state"), "as_scheduled"); assert.equal(banner.querySelector("h2")!.textContent, "Doors 19:00 as scheduled");
  assert.deepEqual([...banner.querySelectorAll("li")].map(item => item.textContent), ["Juniper Lane 20:00", "The Night Ferries 20:45"]);
  assert.equal(document.getElementById(banner.getAttribute("aria-labelledby")!), banner.querySelector("h2"));
});

test("an approved and published Protect doors plan keeps 19:00 as scheduled", () => {
  const { show } = publishForTest(), event = audienceEvent(show);
  assert.equal(event.scheduleStatus, "current"); assert.equal(event.label, "Current approved program");
  const banner = doorsBanner(event, originalDoors(show));
  assert.equal(banner.state, "as_scheduled"); assert.equal(banner.text, "Doors 19:00 as scheduled · Juniper Lane 20:00 · The Night Ferries 20:45");
  assert.match(banner.detail, new RegExp(`approved plan ${show.planVersion}, published sheet ${show.sheets.at(-1)!.version}`));
});

test("an approved plan that moves doors never says as scheduled", async () => {
  const { show } = publishForTest(), current = audienceEvent(show);
  const moved: AudienceEvent = { ...current, doorsAt: atVenue("20:05"), performances: [{ ...current.performances[0], startsAt: atVenue("20:25") }, { ...current.performances[1], startsAt: atVenue("21:10") }] };
  const banner = doorsBanner(moved, originalDoors(show));
  assert.equal(banner.state, "moved"); assert.equal(banner.text, "Doors moved to 20:05 · was 19:00 · Juniper Lane 20:25 · The Night Ferries 21:10"); assert.doesNotMatch(banner.text, /as scheduled/);
  const host = await mount(<DoorsBanner event={moved} originalDoorsAt={originalDoors(show)} />);
  assert.equal(host.querySelector("section")!.getAttribute("data-state"), "moved"); assert.doesNotMatch(host.textContent!, /as scheduled/); assert.match(host.textContent!, /Time changed/);
  // Without a known original time the banner states the time and makes no comparison.
  assert.equal(doorsBanner(current, null).text, "Doors 19:00 · Juniper Lane 20:00 · The Night Ferries 20:45");
  // A cancelled headliner inside a support-only program is named, not timed.
  assert.match(doorsBanner({ ...current, program: "support_only", performances: [current.performances[0], { ...current.performances[1], cancelled: true }] }, originalDoors(show)).text, /Juniper Lane 20:00 · The Night Ferries cancelled$/);
});

test("with no current approved plan the doors time is under review", async () => {
  // Approved but not yet published, and merely disrupted, are both unconfirmed for an attendee.
  for (const show of [approved().show, (() => { const value = base().show; value.incidents.push({ id: "x", kind: "console", title: "", summary: "", receivedAt: value.clock, sourceZone: value.zone, sourceText: "", earliestAvailable: value.clock, resourceIds: [], affectedTaskIds: [], confirmed: true, source: "sample" }); return value; })()]) {
    const event = audienceEvent(show), banner = doorsBanner(event, originalDoors(show));
    assert.equal(event.scheduleStatus, "under_review"); assert.equal(banner.state, "under_review");
    assert.equal(banner.text, "Doors time under review · last published 19:00"); assert.doesNotMatch(banner.text + banner.detail, /as scheduled/); assert.deepEqual(banner.acts, []);
  }
  const event = audienceEvent(approved().show), host = await mount(<DoorsBanner event={event} originalDoorsAt={event.doorsAt} />);
  assert.equal(host.querySelector("section")!.getAttribute("data-state"), "under_review"); assert.equal(host.querySelectorAll("li").length, 0); assert.match(host.textContent!, /not a confirmed time/); assert.match(host.textContent!, /Under review/);
  assert.equal(doorsBanner({ ...event, doorsAt: null }, null).headline, "Doors time under review");
});

test("a cancelled show says doors will not open, whatever the last times were", async () => {
  const { show } = publishForTest(), current = audienceEvent(show);
  for (const scheduleStatus of ["current", "under_review"] as const) {
    const cancelled: AudienceEvent = { ...current, program: "cancelled", scheduleStatus, doorsAt: scheduleStatus === "current" ? null : current.doorsAt, performances: current.performances.map(row => ({ ...row, cancelled: true })) };
    const banner = doorsBanner(cancelled, originalDoors(show));
    assert.equal(banner.state, "cancelled"); assert.equal(banner.text, "Event cancelled · doors will not open"); assert.doesNotMatch(banner.text + banner.detail, /as scheduled|19:00/);
  }
  const host = await mount(<DoorsBanner event={{ ...current, program: "cancelled", doorsAt: null }} originalDoorsAt={originalDoors(show)} />);
  assert.equal(host.querySelector("section")!.getAttribute("data-state"), "cancelled"); assert.equal(host.querySelector("h2")!.textContent, "Event cancelled · doors will not open");
});

const refund = (value: Partial<AudienceRefund>): AudienceRefund => ({ id: "r1", reference: receiptReference("REFUND-9XK27Q41AB"), amountMinor: 1500, admissionMinor: 0, perkMinor: 1500, recordedAt: "2026-11-14T22:41:07Z", status: "confirmed", historicallyConfirmed: true, source: "live_sandbox", decision: "vip_perk", ...value });
const vip = (value: Partial<AudienceTicketReceipt> = {}): AudienceTicketReceipt => ({ ticketId: "t1", tier: "vip", captureReference: "••••CAP001", capturedAt: "2026-11-01T10:00:00Z", currency: "USD", admissionMinor: 3500, perkMinor: 1500, grossMinor: 5000, originalDigest: "0".repeat(64), provenance: "live_sandbox", verification: "verified", refunds: [], instructions: [], confirmedRefundMinor: 0, currentlyVerifiedRefundMinor: 0, unallocatedRefundMinor: 0, remainingAdmissionMinor: 3500, remainingPerkMinor: 1500, remedy: { admissionMinor: 0, perkMinor: 0, confirmedMinor: 0, remainingMinor: 0, status: "not_applicable" }, admission: "eligible", notice: "", ...value });

test("a VIP receipt shows the refunded perk with its redacted refund ID and date while admission stays paid", async () => {
  const receipt = vip({ refunds: [refund({})], confirmedRefundMinor: 1500, currentlyVerifiedRefundMinor: 1500, remainingPerkMinor: 0 }), lines = receiptLines(receipt);
  assert.deepEqual(lines.map(row => row.text), ["Admission: Paid $35.00", "Soundcheck access: refunded $15.00"]);
  assert.deepEqual([lines[1].reference, lines[1].refundedAt, lines[0].reference], ["••••7Q41AB", "2026-11-14T22:41:07Z", null]);
  const host = await mount(<ReceiptLineStates receipt={receipt} />), items = [...host.querySelectorAll("li")];
  assert.deepEqual(items.map(item => item.getAttribute("data-state")), ["paid", "refunded"]);
  assert.equal(items[0].textContent, "Admission: Paid $35.00"); assert.match(items[1].textContent!, /^Soundcheck access: refunded \$15\.00Refund ••••7Q41AB · 14 Nov 2026, 22:41:07 UTC$/);
  assert.equal(items[1].querySelector("time")!.getAttribute("datetime"), "2026-11-14T22:41:07Z"); assert.equal(host.textContent!.includes("REFUND-9XK27Q41AB"), false);
});

test("a line is refunded only by a currently confirmed refund allocated to it", () => {
  const event = audienceEvent(publishForTest().show); assert.equal(event.vip, "cancelled");
  assert.deepEqual(receiptLines(vip(), event).map(row => row.state), ["paid", "cancelled_unrefunded"]);
  assert.equal(receiptLines(vip(), event)[1].text, "Soundcheck access: cancelled · Paid $15.00, no refund recorded yet");
  assert.deepEqual(receiptLines(vip({ instructions: [{ id: "i", createdAt: "2026-11-14T22:00:00Z", amountMinor: 1500, admissionMinor: 0, perkMinor: 1500, status: "pending" }] }), event).map(row => row.state), ["paid", "refund_pending"]);
  assert.deepEqual(receiptLines(vip({ refunds: [refund({ status: "pending", historicallyConfirmed: false })] })).map(row => [row.state, row.reference]), [["paid", null], ["refund_pending", null]]);
  assert.deepEqual(receiptLines(vip({ refunds: [refund({ status: "unknown" })] })).map(row => row.state), ["paid", "refund_unverified"]);
  assert.deepEqual(receiptLines(vip({ refunds: [refund({ admissionMinor: null, perkMinor: null })], unallocatedRefundMinor: 1500 })).map(row => row.state), ["paid", "paid"]);
  assert.deepEqual(receiptLines(vip({ refunds: [refund({ amountMinor: 5000, admissionMinor: 3500, perkMinor: 1500, decision: "event_remedy" })] })).map(row => row.text), ["Admission: refunded $35.00", "Soundcheck access: refunded $15.00"]);
  assert.deepEqual(receiptLines(vip({ refunds: [refund({ amountMinor: 500, perkMinor: 500 })] })).map(row => row.text), ["Admission: Paid $35.00", "Soundcheck access: refunded $5.00 of $15.00"]);
  assert.deepEqual(receiptLines(vip({ verification: "unknown", refunds: [refund({})] })).map(row => row.state), ["unverified", "unverified"]);
  assert.deepEqual(receiptLines(vip({ tier: "standard", perkMinor: 0, grossMinor: 3500 })).map(row => row.text), ["Admission: Paid $35.00"]);
});

test("the attendee contract carries the original doors time and the strict reader requires it", async () => {
  const { parseAttendeeView } = await import("../src/components/audience/validation");
  const { show } = publishForTest(), view = { capabilityId: "7b0a9a52-3f0e-4a59-9d55-0f6a1e6c8c11", expiresAt: "2026-11-15T06:00:00Z", observedAt: "2026-11-14T22:45:00Z", sourceDigest: "a".repeat(64), event: audienceEvent(show), receipt: vip({ refunds: [refund({})] }), originalDoorsAt: originalDoors(show), inbox: [], inboxPage: { hasMore: false, cursor: null }, transport: "controlled_inbox", controlledQa: false };
  const parsed = await parseAttendeeView(JSON.parse(JSON.stringify(view)));
  assert.equal(parsed.originalDoorsAt, atVenue("19:00")); assert.equal(doorsBanner(parsed.event, parsed.originalDoorsAt).state, "as_scheduled");
  assert.equal((await parseAttendeeView({ ...JSON.parse(JSON.stringify(view)), originalDoorsAt: null })).originalDoorsAt, null);
  const { originalDoorsAt: _omitted, ...missing } = view;
  await assert.rejects(parseAttendeeView(JSON.parse(JSON.stringify(missing))), /could not be verified/);
  await assert.rejects(parseAttendeeView({ ...JSON.parse(JSON.stringify(view)), originalDoorsAt: "19:00" }), /could not be verified/);
  // The server projection reads the first published sheet, so a later approved sheet cannot redefine "scheduled".
  const server = readFileSync(new URL("../src/server/audience/attendee.ts", import.meta.url), "utf8");
  assert.match(server, /originalDoorsAt: \[\.\.\.context\.show\.sheets\]\.sort\(\(a, b\) => a\.version - b\.version\)\[0\]\?\.tasks\.find\(task => task\.id === "doors"\)\?\.baselineStart \?\? null/);
  assert.equal(show.sheets.length > 1, true); assert.equal(originalDoors(show), atVenue("19:00"));
});
