import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { act, useRef, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ConsoleData } from "../src/domain/contracts";
import type { DisruptionEnvelope, DisruptionResult, DisruptionWorkspace } from "../src/server/disruptions/contracts";
import { DisruptionDesk } from "../src/components/disruptions/disruption-desk";
import { SupplierDisruptionPanel } from "../src/components/disruptions/supplier-disruption-panel";
import { SupplierAccess } from "../src/components/supplier-access";
import { DisruptionStatus } from "../src/components/disruptions/shared";
import { useDisruptions } from "../src/components/disruptions/use-disruptions";
import { disruptionRecoveryKey, parseDisruption, prepareDisruption } from "../src/components/disruptions/recovery";
import { ACTIVE_REHEARSAL_STORAGE, PRODUCTION_CHANGED_EVENT } from "../src/components/production-fetch";
// Import before installing window, so Next's native touring canvas stays a loading boundary.
import { TourConsole } from "../src/components/tour/tour-console";
import { ProductionConsole } from "../src/components/production-console";
import { createFixture } from "../src/domain/fixture";
import { allReadiness } from "../src/domain/readiness";
import { disruptionPreviewFixture, disruptionResultFixture, disruptionUiFixture } from "./disruptions-ui-fixture";
import { rentalCardFixture, rentalResultFixture, rentalUiFixture } from "./rental-closeout-ui-fixture";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:4564/disruptions", pretendToBeVisual: true });
for (const name of ["window", "self", "document", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "StorageEvent", "location", "history", "localStorage", "sessionStorage", "MutationObserver"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
// JSDOM has no layout or native modal top layer. These shims test DOM, state and
// focus ownership; the integration owner verifies actual browser layout.
dom.window.HTMLElement.prototype.getClientRects = function () { return (this.isConnected && !this.closest("[hidden]") && getComputedStyle(this).display !== "none" ? [new dom.window.DOMRect(0, 0, 120, 30)] : []) as unknown as DOMRectList; };
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); this.querySelector<HTMLElement>("[autofocus], button:not([disabled]), input:not([disabled])")?.focus(); };
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
dom.window.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(this.download); };
const { createRoot } = await import("react-dom/client");
const originalFetch = globalThis.fetch, originalSet = dom.window.Storage.prototype.setItem, originalRemove = dom.window.Storage.prototype.removeItem;
let root: Root | null = null, container: HTMLDivElement, calls: Call[] = [], downloads: string[] = [], headerReads = 0;
type Call = { path: string; method: string; body: any; headers: Headers; credentials: RequestCredentials | undefined };
type Route = (call: Call) => Response | Promise<Response> | undefined;
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const consoleData = (workspace: DisruptionWorkspace) => ({ show: { tenantId: workspace.tenantId, revision: workspace.revision } }) as ConsoleData;
function ClientHarness({ workspace, bearer }: { workspace: DisruptionWorkspace; bearer?: string }) {
  const heading = useRef<HTMLHeadingElement>(null), client = useDisruptions({ tenantId: workspace.tenantId, ...(bearer ? { bearer } : {}), fallback: () => heading.current });
  return <div><h1 tabIndex={-1} ref={heading}>Current disruption review</h1><p>{client.data ? "Workspace ready" : "Opening workspace"}</p><DisruptionStatus client={client} /><button id="submit" disabled={client.blocked} onClick={event => void client.submit({ type: "assess" }, client.data?.revision, event.currentTarget)}>Save reviewed assessment</button><button id="refresh" disabled={Boolean(client.busy || client.ended)} onClick={event => void client.refresh(event.currentTarget)}>Refresh facts</button><button id="review" onClick={client.beginReview}>Open another review</button><input id="unrelated" aria-label="Unrelated note" /><span data-blocked={client.blocked} /></div>;
}
const button = (label: string, within: ParentNode = container) => { const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent?.trim() === label || value.getAttribute("aria-label") === label); assert.ok(found, `Missing button: ${label}`); return found; };
const field = (label: string, within: ParentNode = container) => { const found = [...within.querySelectorAll<HTMLLabelElement>("label")].find(value => value.textContent?.trim().startsWith(label)); assert.ok(found, `Missing field: ${label}`); const input = found.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea") ?? (found.htmlFor ? document.getElementById(found.htmlFor) as HTMLInputElement : null); assert.ok(input, `Missing input: ${label}`); return input; };
const dialogs = () => [...container.querySelectorAll<HTMLDialogElement>("dialog[open]")];
const postCalls = () => calls.filter(call => call.method === "POST" && call.path === "/api/disruptions/commands");
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
async function until(check: () => boolean) { for (let index = 0; index < 100 && !check(); index++) await flush(); assert.ok(check(), "Disruption UI did not settle"); }
async function click(element: HTMLElement) { await act(async () => { element.focus(); element.click(); }); }
async function fill(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { const prototype = element instanceof HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function mount(workspace: DisruptionWorkspace, route?: Route, node?: ReactNode) {
  container = document.createElement("div"); document.body.append(container); calls = []; downloads = []; headerReads = 0;
  globalThis.fetch = async (input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const call: Call = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers), credentials: init?.credentials }; calls.push(call);
    const routed = route?.(call); if (routed) return routed;
    if (path === "/api/disruptions") return Response.json(workspace);
    if (path === "/api/rental-closeout") return Response.json(rentalUiFixture({ tenantId: workspace.tenantId, actorId: workspace.actorId, sessionFingerprint: workspace.sessionFingerprint, access: workspace.access === "supplier" ? "supplier" : "producer", supplierId: workspace.access === "supplier" ? "brightline" : null, rentals: [] }));
    if (path === "/api/disruptions/preview") return Response.json(disruptionPreviewFixture(workspace, call.body.mode, call.body.admissionRefundMinor));
    if (path === "/api/show") { headerReads++; return Response.json(consoleData(workspace)); }
    throw new Error(`Unexpected controlled request ${call.method} ${path}`);
  };
  root = createRoot(container); await act(async () => root!.render(node ?? <DisruptionDesk data={consoleData(workspace)} onData={() => undefined} run={async () => null} busy={null} licenseKey="" />));
  if (!node) await until(() => container.textContent?.includes("Start with what changed.") ?? false);
}
async function harness(workspace: DisruptionWorkspace, route?: Route) { await mount(workspace, route, <ClientHarness workspace={workspace} />); await until(() => container.textContent?.includes("Workspace ready") ?? false); }
async function unmount() { if (root) { await act(async () => root!.unmount()); root = null; } document.body.replaceChildren(); }
afterEach(async () => { dom.window.Storage.prototype.setItem = originalSet; dom.window.Storage.prototype.removeItem = originalRemove; await unmount(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, "", "/disruptions"); globalThis.fetch = originalFetch; });
after(() => dom.window.close());

test("the supplier portal can report its own availability before a current rental plan exists", async () => {
  const workspace = disruptionUiFixture({ access: "supplier", actorId: "supplier:brightline:controlled", assessments: [], assessmentIsCurrent: false, obligations: [], rentalCommitments: [] }); workspace.offers = workspace.offers.slice(0, 1);
  history.replaceState(null, "", "/supplier/access#controlled-original-supplier");
  await mount(workspace, call => call.path === "/api/supplier" ? Response.json({ code: "PLAN_APPROVAL_REQUIRED", error: "Review the recovery plan first." }, { status: 409 }) : undefined, <SupplierAccess />);
  await until(() => container.textContent?.includes("No current approved reservation is available") ?? false);
  await until(() => !button("Report availability for Brightline Rentals LX-204").disabled);
  assert.match(container.textContent!, /Your availability, on the record/);
  assert.doesNotMatch(container.textContent!, /Northside AV|Sister Venue|Review the recovery plan first/);
  await click(button("Report availability for Brightline Rentals LX-204")); assert.match(dialogs().at(-1)!.textContent!, /Available again/);
  assert.ok(calls.filter(call => call.path === "/api/disruptions").every(call => call.headers.get("authorization") === "Bearer controlled-original-supplier"));
});

test("an accepted rental disrupted after capture uses a separate exact original-unit return, preserving its fee", async () => {
  const workspace = disruptionUiFixture({ access: "supplier", actorId: "supplier:brightline:controlled", assessments: [], assessmentIsCurrent: false, obligations: [], rentalCommitments: [] }); workspace.offers = workspace.offers.slice(0, 1);
  const show = createFixture(workspace.tenantId), projection = { revision: workspace.revision, planVersion: 3, planDigest: "e".repeat(64), show: show.title, venue: show.venue, clock: workspace.clock, offer: show.offers[0], facts: [], payments: [{ purpose: "rental_fee", status: "succeeded" }], protocol: 2, operatingMode: "cancel_show", execution: { id: workspace.offers[0]!.executionId, state: "needs_attention", deliveryAt: show.offers[0]!.deliveryAt, acceptedAt: "2026-11-12T04:00:00Z", lastCode: "SUPPLIER_DISRUPTION" } };
  const rental = rentalUiFixture({ tenantId: workspace.tenantId, actorId: workspace.actorId, sessionFingerprint: workspace.sessionFingerprint, access: "supplier", supplierId: "brightline", rentals: [rentalCardFixture({ id: workspace.offers[0]!.executionId! })] });
  history.replaceState(null, "", "/supplier/access#controlled-original-supplier");
  await mount(workspace, call => call.path === "/api/supplier" ? Response.json(projection) : call.path === "/api/rental-closeout" ? Response.json(rental) : call.path === "/api/rental-closeout/commands" ? rentalResultFixture(rental, call.body).then(value => Response.json(value)) : undefined, <SupplierAccess />);
  await until(() => Boolean(container.querySelector(".rental-card")) && !button("Inspect original return").disabled);
  assert.doesNotMatch(container.textContent!, /Receive the rejected console|Condition rejected|Record controlled undamaged return/); assert.match(container.textContent!, /Rental fee captured/);
  await click(button("Inspect original return")); const dialog = dialogs().at(-1)!;
  await click(field("Returned undamaged", dialog));
  await fill(field("Inspection and condition note", dialog), "Controlled UI fixture: inspect the original accepted unit on return; preserve its captured fee.");
  await click(field("I reviewed this original unit", dialog));
  await until(() => !button("Record return inspection", dialog).disabled); await click(button("Record return inspection", dialog));
  await until(() => calls.some(call => call.method === "POST" && call.path === "/api/rental-closeout/commands"));
  assert.equal(calls.find(call => call.method === "POST" && call.path === "/api/rental-closeout/commands")!.body.command.type, "record_return");
  assert.ok(!calls.some(call => call.method === "POST" && call.path === "/api/supplier"));
});

test("the desk separates attributed evidence, bounded search and an explicit operating decision", async () => {
  const workspace = disruptionUiFixture(); await mount(workspace);
  assert.match(container.textContent!, /Production operator report/);
  assert.match(container.textContent!, /No feasible candidate in this tested set/);
  assert.match(container.textContent!, /bounded search is not a proof about every possible production/);
  assert.match(container.textContent!, /Reason counts can overlap/);
  assert.match(container.textContent!, /Provider actions are disabled/);
  assert.equal(button("Review support-only policy").disabled, false);
  assert.equal(button("Review full cancellation").disabled, false);
  assert.equal(postCalls().length, 0);
  assert.match(container.textContent!, /Captured rental fees remain actual costs/);
  assert.equal(container.querySelectorAll("[aria-labelledby]").length > 3, true);
});

test("a producer report uses the exact offer, source observation time and Chicago scenario delivery", async () => {
  const workspace = disruptionUiFixture(); let saved: DisruptionEnvelope | null = null;
  await mount(workspace, call => {
    if (call.path === "/api/disruptions/commands") { saved = call.body; assert.ok(localStorage.getItem(disruptionRecoveryKey(workspace))); return disruptionResultFixture(workspace, call.body).then(value => Response.json(value)); }
  });
  await click(button("Report availability for Brightline Rentals LX-204"));
  const dialog = dialogs().at(-1)!; assert.ok(dialog); assert.doesNotMatch(dialog.textContent!, /Available again/);
  await fill(field("Earliest delivery", dialog), "2026-11-14T21:15");
  await fill(field("Source observed at", dialog), "2026-11-12T06:00:00");
  await fill(field("Source reference", dialog), "  Call note 014  ");
  await fill(field("What is known", dialog), "  Driver availability changed; the source needs production review.  ");
  await click(field("I reviewed this source", dialog)); await click(button("Save attributed report", dialog));
  await until(() => dialogs().length === 0);
  assert.ok(saved); const command = (saved as DisruptionEnvelope).command; assert.equal(command.type, "report"); if (command.type !== "report") return;
  assert.equal(command.offerId, workspace.offers[0]!.id); assert.equal(command.offerRevision, 2); assert.equal(command.executionId, workspace.offers[0]!.executionId);
  assert.equal(command.earliestAt, "2026-11-15T03:15:00Z"); assert.equal(command.observedAt, "2026-11-12T06:00:00.000Z");
  assert.equal(command.reference, "Call note 014"); assert.equal(command.confirmed, true); assert.equal(command.detail.startsWith(" "), false);
  assert.equal(postCalls()[0]!.headers.get("X-Opening-Night-Production"), workspace.tenantId); assert.ok(headerReads > 0);
});

test("support-only review prepares read-only exact-cent allocations before approval", async () => {
  const workspace = disruptionUiFixture(); let saved: DisruptionEnvelope | null = null;
  await mount(workspace, call => {
    if (call.path !== "/api/disruptions/commands") return;
    saved = call.body; assert.ok(localStorage.getItem(disruptionRecoveryKey(workspace)));
    const command = call.body.command; assert.equal(command.type, "decide");
    const preview = disruptionPreviewFixture(workspace, command.mode, command.admissionRefundMinor), now = new Date().toISOString();
    const next: DisruptionWorkspace = { ...workspace, revision: workspace.revision + 1, decision: { id: randomUUID(), digest: "e".repeat(64), mode: command.mode, detail: command.detail, actorId: workspace.actorId, approvedAt: now, expiresAt: workspace.expiresAt, assessmentId: command.assessmentId, disruptionDigest: "c".repeat(64), admissionRefundMinor: command.admissionRefundMinor, targets: preview.lines.map(line => ({ ticketId: line.ticketId, admissionMinor: command.admissionRefundMinor, perkMinor: line.tier === "vip" ? 1500 : 0 })), newRefundMinor: preview.newRefundMinor, newRefundCount: 3, cancelledTaskIds: ["headliner", "vip"], noticeSheetVersion: 4, remediesStoppedAt: null } };
    return disruptionResultFixture(next, call.body).then(result => Response.json(result));
  });
  await click(button("Review support-only policy"));
  await fill(field("Admission refund per captured ticket"), "12.35");
  await click(button("Prepare exact refund review")); await until(() => dialogs().length === 2);
  const exact = dialogs().at(-1)!;
  assert.equal(postCalls().length, 0); assert.equal(calls.find(call => call.path === "/api/disruptions/preview")!.body.admissionRefundMinor, 1235);
  assert.match(exact.textContent!, /\$52\.05/); assert.match(exact.textContent!, /Verified prior refunds accounted for/); assert.match(exact.textContent!, /\$15\.00/);
  assert.match(exact.textContent!, /Crew obligations/); assert.match(exact.textContent!, /Audience delivery and physical safety need their own evidence/);
  assert.match(exact.textContent!, /Support and doors remain blocked until/);
  assert.equal(button("Approve support-only decision", exact).disabled, true);
  await fill(field("Producer decision", exact), "Keep only the support act under full clearance; retain crew and supplier closeout.");
  await click(field("I reviewed the exact capture", exact)); await click(button("Approve support-only decision", exact));
  await until(() => dialogs().length === 0); assert.ok(saved);
  const command = (saved as DisruptionEnvelope).command; assert.equal(command.type, "decide"); if (command.type !== "decide") return;
  assert.equal(command.admissionRefundMinor, 1235); assert.equal(command.previewDigest, "d".repeat(64)); assert.equal(command.assessmentId, workspace.assessments[0]!.id); assert.equal(command.confirmed, true);
  assert.match(container.textContent!, /CURRENT INTERNAL OPERATING NOTICE/); assert.match(container.textContent!, /Support act only\. Headliner cancelled/);
  assert.equal(localStorage.getItem(disruptionRecoveryKey(workspace)), null);
});

test("full cancellation locks the $35 policy and blockers cannot be approved", async () => {
  const workspace = disruptionUiFixture(); await mount(workspace, call => call.path === "/api/disruptions/preview" ? Response.json({ ...disruptionPreviewFixture(workspace, "cancel_show", 3500), ready: false, blockers: ["An original capture has an unresolved provider outcome."] }) : undefined);
  await click(button("Review full cancellation")); const amount = field("Admission refund per captured ticket") as HTMLInputElement;
  assert.equal(amount.value, "35.00"); assert.equal(amount.readOnly, true);
  await click(button("Prepare exact refund review")); await until(() => dialogs().length === 2);
  const exact = dialogs().at(-1)!; assert.match(exact.textContent!, /All performance cues remain permanently blocked/);
  assert.match(exact.textContent!, /unresolved provider outcome/); assert.equal(calls.find(call => call.path === "/api/disruptions/preview")!.body.admissionRefundMinor, 3500);
  await fill(field("Producer decision", exact), "The unresolved original result must be reconciled before any approval."); await click(field("I reviewed the exact capture", exact));
  assert.equal(button("Approve cancellation", exact).disabled, true); assert.equal(postCalls().length, 0);
  await click(button("Back to policy", exact)); assert.equal(dialogs().length, 1); assert.equal(document.activeElement, button("Prepare exact refund review"));
});

test("a refreshed revision retires the nested preview and its confirmation", async () => {
  const workspace = disruptionUiFixture(); let revision = workspace.revision;
  await mount(workspace, call => call.path === "/api/disruptions" ? Response.json({ ...workspace, revision }) : undefined);
  await click(button("Review support-only policy")); await click(button("Prepare exact refund review")); await until(() => dialogs().length === 2);
  revision++; await act(async () => window.dispatchEvent(new Event("focus"))); await until(() => dialogs().length === 1);
  assert.equal(container.textContent!.includes("Review the exact refund policy"), false); assert.equal(postCalls().length, 0);
  assert.equal(button("Prepare exact refund review").disabled, false);
});

test("refreshing unchanged facts also retires a previously prepared policy preview", async () => {
  const workspace = disruptionUiFixture(); await mount(workspace);
  await click(button("Review support-only policy")); await click(button("Prepare exact refund review")); await until(() => dialogs().length === 2);
  await act(async () => window.dispatchEvent(new Event("focus"))); await until(() => dialogs().length === 1);
  assert.equal(container.textContent!.includes("Review the exact refund policy"), false); assert.equal(postCalls().length, 0);
});

test("the active nested review owns Tab and returns focus to its policy opener", async () => {
  const workspace = disruptionUiFixture(); await mount(workspace);
  await click(button("Review support-only policy")); await click(button("Prepare exact refund review")); await until(() => dialogs().length === 2);
  const exact = dialogs().at(-1)!; await fill(field("Producer decision", exact), "Review the exact customer remedy and retain outstanding obligations."); await click(field("I reviewed the exact capture", exact));
  const first = exact.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')!, last = button("Approve support-only decision", exact);
  await act(async () => { last.focus(); const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }); last.dispatchEvent(event); assert.equal(event.defaultPrevented, true); });
  assert.equal(document.activeElement, first);
  await act(async () => { const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }); first.dispatchEvent(event); assert.equal(event.defaultPrevented, true); });
  assert.equal(document.activeElement, last);
  await act(async () => exact.dispatchEvent(new Event("cancel", { bubbles: false, cancelable: true })));
  assert.equal(dialogs().length, 1); assert.equal(document.activeElement, button("Prepare exact refund review")); assert.equal(postCalls().length, 0);
});

test("a changed planning source requires reassessment even when its report revisions are unchanged", async () => {
  const workspace = disruptionUiFixture({ assessmentIsCurrent: false }); await mount(workspace);
  assert.match(container.textContent!, /Current production facts changed after this assessment/);
  assert.equal(button("Review support-only policy").disabled, true); assert.equal(button("Review full cancellation").disabled, true); assert.equal(button("Reassess current alternatives").disabled, false);
});

test("only an exact 404 enables a manual retry after a lost response and remount", async () => {
  const workspace = disruptionUiFixture(); let original: DisruptionEnvelope | null = null;
  await harness(workspace, call => call.method === "POST" ? (original = call.body, Promise.reject(new TypeError("Controlled network loss"))) : undefined);
  await click(button("Save reviewed assessment")); await until(() => container.textContent!.includes("Controlled network loss"));
  const raw = localStorage.getItem(disruptionRecoveryKey(workspace)); assert.ok(raw); assert.ok(original);
  assert.equal(button("Save reviewed assessment").disabled, true); await unmount();
  let exact404 = false;
  await harness(workspace, call => {
    if (call.path.startsWith("/api/disruptions/commands/")) return Response.json({ code: exact404 ? "DISRUPTION_COMMAND_NOT_FOUND" : "OTHER_NOT_FOUND", error: "Controlled missing result" }, { status: 404 });
    if (call.method === "POST") { assert.ok(original); assert.deepEqual(call.body, original); return disruptionResultFixture(workspace, call.body, { replayed: true }).then(result => Response.json(result)); }
  });
  assert.equal(postCalls().length, 0); assert.equal(button("Retry the same instruction").disabled, true);
  await click(button("Check original status")); await until(() => container.textContent!.includes("Controlled missing result")); assert.equal(button("Retry the same instruction").disabled, true);
  exact404 = true; await click(button("Check original status")); await until(() => !button("Retry the same instruction").disabled);
  assert.equal(localStorage.getItem(disruptionRecoveryKey(workspace)), raw); await click(button("Retry the same instruction"));
  await until(() => !container.textContent!.includes("Check the original result.")); assert.equal(postCalls().length, 1); assert.equal(localStorage.getItem(disruptionRecoveryKey(workspace)), null);
});

test("the original committed receipt recovers without another POST", async () => {
  const workspace = disruptionUiFixture(), pending = await prepareDisruption(workspace, { idempotencyKey: randomUUID(), expectedRevision: workspace.revision, command: { type: "assess" } });
  localStorage.setItem(disruptionRecoveryKey(workspace), JSON.stringify(pending));
  await harness(workspace, call => call.path.startsWith("/api/disruptions/commands/") ? disruptionResultFixture(workspace, pending.envelope, { replayed: true }).then(value => Response.json(value)) : undefined);
  await until(() => container.textContent!.includes("Check the original result.")); await click(button("Check original status"));
  await until(() => !container.textContent!.includes("Check the original result.")); assert.equal(postCalls().length, 0); assert.match(container.textContent!, /Original receipt recovered/);
});

test("a failed follow-up status check retires an earlier not-recorded retry allowance", async () => {
  const workspace = disruptionUiFixture(), pending = await prepareDisruption(workspace, { idempotencyKey: randomUUID(), expectedRevision: 12, command: { type: "assess" } }); let fail = false;
  localStorage.setItem(disruptionRecoveryKey(workspace), JSON.stringify(pending));
  await harness(workspace, call => call.path.startsWith("/api/disruptions/commands/") ? Response.json({ code: fail ? "TEMPORARY_ERROR" : "DISRUPTION_COMMAND_NOT_FOUND", error: fail ? "Controlled status failure" : "No original receipt" }, { status: fail ? 503 : 404 }) : undefined);
  await until(() => container.textContent!.includes("Check the original result."));
  await click(button("Check original status")); await until(() => !button("Retry the same instruction").disabled);
  fail = true; await click(button("Check original status")); await until(() => container.textContent!.includes("Controlled status failure")); assert.equal(button("Retry the same instruction").disabled, true); assert.equal(postCalls().length, 0);
});

for (const fault of ["unreadable", "server error", "wrong action", "wrong hash", "different session"] as const) test(`${fault} leaves the reviewed instruction retained and competing actions disabled`, async () => {
  const workspace = disruptionUiFixture();
  await harness(workspace, call => {
    if (call.method !== "POST") return;
    if (fault === "unreadable") return new Response("Interrupted response", { status: 200 });
    if (fault === "server error") return Response.json({ code: "CONTROLLED_503", error: "Controlled server failure" }, { status: 503 });
    return disruptionResultFixture(workspace, call.body).then(result => {
      if (fault === "wrong action") result.receipt.action = "report";
      if (fault === "wrong hash") result.receipt.requestDigest = "0".repeat(64);
      if (fault === "different session") result.workspace.sessionFingerprint = "f".repeat(64);
      return Response.json(result);
    });
  });
  await click(button("Save reviewed assessment")); await until(() => container.querySelector("[role=alert]") !== null);
  const raw = localStorage.getItem(disruptionRecoveryKey(workspace)); assert.ok(raw); await parseDisruption(raw, workspace);
  assert.equal(button("Save reviewed assessment").disabled, true); assert.equal(button("Retry the same instruction").disabled, true); assert.equal(postCalls().length, 1);
});

test("failed durable storage blocks dispatch before any command POST", async () => {
  const workspace = disruptionUiFixture(); await harness(workspace);
  dom.window.Storage.prototype.setItem = function (key, value) { if (key.startsWith("opening-night:disruption:")) throw new Error("Controlled durable storage failure"); return originalSet.call(this, key, value); };
  await click(button("Save reviewed assessment")); await until(() => container.textContent!.includes("Controlled durable storage failure"));
  assert.equal(postCalls().length, 0); assert.equal(button("Save reviewed assessment").disabled, true);
});

test("failed recovery removal preserves the known receipt and never offers another send", async () => {
  const workspace = disruptionUiFixture(); let saved: DisruptionEnvelope | null = null;
  await harness(workspace, call => {
    if (call.method === "POST") { saved = call.body; return disruptionResultFixture(workspace, call.body).then(result => Response.json(result)); }
    if (call.path.startsWith("/api/disruptions/commands/") && saved) return disruptionResultFixture(workspace, saved, { replayed: true }).then(result => Response.json(result));
  });
  dom.window.Storage.prototype.removeItem = function (key) { if (key.startsWith("opening-night:disruption:")) throw new Error("Controlled recovery removal failure"); return originalRemove.call(this, key); };
  await click(button("Save reviewed assessment")); await until(() => container.textContent!.includes("Controlled recovery removal failure"));
  assert.match(container.textContent!, /Reviewed instruction recorded/); assert.ok(localStorage.getItem(disruptionRecoveryKey(workspace)));
  assert.equal(button("Retry the same instruction").disabled, true); assert.equal(postCalls().length, 1);
  dom.window.Storage.prototype.removeItem = originalRemove; await click(button("Check original status")); await until(() => !container.textContent!.includes("Check the original result.")); assert.equal(postCalls().length, 1);
});

test("a definite stale rejection requires refreshed facts before a new instruction", async () => {
  const workspace = disruptionUiFixture(); await harness(workspace, call => call.method === "POST" ? Response.json({ code: "STALE_REVISION", error: "The production changed before this review." }, { status: 409 }) : undefined);
  await click(button("Save reviewed assessment")); await until(() => container.textContent!.includes("production changed before this review"));
  assert.equal(localStorage.getItem(disruptionRecoveryKey(workspace)), null); assert.equal(button("Save reviewed assessment").disabled, true);
  await click(button("Refresh facts")); await until(() => !button("Save reviewed assessment").disabled);
});

test("a session change suppresses a late receipt and preserves its original instruction", async () => {
  const workspace = disruptionUiFixture(), response = deferred<Response>(); await harness(workspace, call => call.method === "POST" ? response.promise : undefined);
  await click(button("Save reviewed assessment")); await until(() => postCalls().length === 1); const original = postCalls()[0]!.body;
  await act(async () => window.dispatchEvent(new Event(PRODUCTION_CHANGED_EVENT)));
  response.resolve(Response.json(await disruptionResultFixture(workspace, original))); await flush();
  assert.match(container.textContent!, /exact production access has ended/); assert.doesNotMatch(container.textContent!, /Reviewed instruction recorded/); assert.ok(localStorage.getItem(disruptionRecoveryKey(workspace))); assert.equal(button("Save reviewed assessment").disabled, true);
});

test("an expired server session retains an uncertain original command", async () => {
  const workspace = disruptionUiFixture(); await harness(workspace, call => call.method === "POST" ? Response.json({ code: "DISRUPTION_SESSION_ENDED", error: "This exact session expired or was revoked." }, { status: 401 }) : undefined);
  await click(button("Save reviewed assessment")); await until(() => container.textContent!.includes("exact production access has ended")); assert.ok(localStorage.getItem(disruptionRecoveryKey(workspace))); assert.equal(button("Retry the same instruction").disabled, true); assert.equal(postCalls().length, 1);
});

test("a receipt check finishing after a rehearsal switch cannot authorize retry", async () => {
  const workspace = disruptionUiFixture(), pending = await prepareDisruption(workspace, { idempotencyKey: randomUUID(), expectedRevision: 12, command: { type: "assess" } }), response = deferred<Response>();
  localStorage.setItem(disruptionRecoveryKey(workspace), JSON.stringify(pending)); await harness(workspace, call => call.path.startsWith("/api/disruptions/commands/") ? response.promise : undefined);
  await until(() => container.textContent!.includes("Check the original result.")); await click(button("Check original status"));
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: ACTIVE_REHEARSAL_STORAGE, newValue: JSON.stringify({ tenantId: randomUUID() }) })));
  response.resolve(Response.json({ code: "DISRUPTION_COMMAND_NOT_FOUND" }, { status: 404 })); await flush(); assert.equal(button("Retry the same instruction").disabled, true); assert.equal(postCalls().length, 0); assert.ok(localStorage.getItem(disruptionRecoveryKey(workspace)));
});

test("a different session does not adopt a retained instruction from the same actor and tenant", async () => {
  const prior = disruptionUiFixture(), saved = await prepareDisruption(prior, { idempotencyKey: randomUUID(), expectedRevision: 12, command: { type: "assess" } }), raw = JSON.stringify(saved);
  localStorage.setItem(disruptionRecoveryKey(prior), raw); await harness({ ...prior, sessionFingerprint: "f".repeat(64) });
  assert.doesNotMatch(container.textContent!, /Check the original result/); assert.equal(button("Save reviewed assessment").disabled, false); assert.equal(postCalls().length, 0); assert.equal(localStorage.getItem(disruptionRecoveryKey(prior)), raw);
});

test("an unreadable retained file pauses actions and is never discarded", async () => {
  const workspace = disruptionUiFixture(); localStorage.setItem(disruptionRecoveryKey(workspace), "{controlled-corrupt-file"); await harness(workspace);
  await until(() => container.textContent!.includes("Instructions are paused")); assert.equal(button("Save reviewed assessment").disabled, true); assert.equal(localStorage.getItem(disruptionRecoveryKey(workspace)), "{controlled-corrupt-file"); assert.equal(postCalls().length, 0);
  await click(button("Save recovery file")); assert.deepEqual(downloads, ["opening-night-disruption-instruction.json"]);
});

test("starting another review clears its old receipt notice without clearing uncertain recovery", async () => {
  const workspace = disruptionUiFixture(); let fail = false;
  await harness(workspace, call => call.method === "POST" ? fail ? Promise.reject(new Error("Controlled connection loss")) : disruptionResultFixture(workspace, call.body).then(value => Response.json(value)) : undefined);
  await click(button("Save reviewed assessment")); await until(() => container.textContent!.includes("Reviewed instruction recorded")); await click(button("Open another review")); assert.doesNotMatch(container.textContent!, /Reviewed instruction recorded/);
  fail = true; await click(button("Save reviewed assessment")); await until(() => container.textContent!.includes("Controlled connection loss")); await click(button("Open another review")); assert.match(container.textContent!, /Controlled connection loss/); assert.match(container.textContent!, /Check the original result/);
});

test("an asynchronous result respects focus moved to another field", async () => {
  const workspace = disruptionUiFixture(), response = deferred<Response>(); await harness(workspace, call => call.method === "POST" ? response.promise : undefined);
  await click(button("Save reviewed assessment")); await until(() => postCalls().length === 1); const target = container.querySelector<HTMLInputElement>("#unrelated")!; await click(target); target.blur();
  response.resolve(Response.json(await disruptionResultFixture(workspace, postCalls()[0]!.body))); await until(() => !button("Save reviewed assessment").disabled); assert.equal(document.activeElement, document.body);
});

test("supplier reporting uses only its capability and offers its own availability reconfirmation", async () => {
  const source = disruptionUiFixture(), workspace: DisruptionWorkspace = { ...source, access: "supplier", actorId: "supplier:brightline:ui", sessionFingerprint: "b".repeat(64), offers: [source.offers[0]!], reports: [], assessments: [], decision: null, remedies: [], historicalDecisions: [], rentalCommitments: [], obligations: [] };
  let blocked = false;
  await mount(workspace, call => call.path === "/api/disruptions/commands" ? disruptionResultFixture(workspace, call.body).then(value => Response.json(value)) : undefined, <SupplierDisruptionPanel bearer={"T".repeat(43)} onSaved={() => undefined} onBlockedChange={value => { blocked = value; }} />);
  await until(() => container.textContent!.includes("Brightline Rentals")); assert.doesNotMatch(container.textContent!, /Northside|support-only|refund|Crew obligations/);
  await click(button("Report availability for Brightline Rentals LX-204")); await click(field("Available again")); await fill(field("Source reference"), "Supplier reconfirmation 015"); await fill(field("What is known"), "The scoped supplier has reviewed its own revised availability."); await click(field("I reviewed my own exact offer"));
  await click(button("Save attributed report")); await until(() => dialogs().length === 0);
  assert.equal(postCalls()[0]!.body.command.availability, "available");
  for (const call of calls) { assert.equal(call.headers.get("Authorization"), `Bearer ${"T".repeat(43)}`); assert.equal(call.credentials, "omit"); }
  assert.equal(postCalls()[0]!.headers.get("X-Opening-Night-Production"), workspace.tenantId); assert.equal(blocked, false); assert.equal(calls.some(call => call.path === "/api/show" || call.path === "/api/disruptions/preview"), false);
});

test("only explicitly refused originals expose refund retries, and supplier void needs a review", async () => {
  const workspace = disruptionUiFixture(), decisionId = randomUUID(), now = new Date().toISOString();
  workspace.decision = { id: decisionId, digest: "e".repeat(64), mode: "support_only", detail: "Keep support under complete review; retain the original crew obligations.", actorId: workspace.actorId, approvedAt: now, expiresAt: workspace.expiresAt, assessmentId: workspace.assessments[0]!.id, disruptionDigest: "c".repeat(64), admissionRefundMinor: 0, targets: [], newRefundMinor: 3000, newRefundCount: 2, cancelledTaskIds: ["headliner", "vip"], noticeSheetVersion: 4, remediesStoppedAt: null };
  workspace.remedies = [{ id: randomUUID(), ticketId: "T-ambiguous", tier: "vip", captureReference: "••••123456", amountMinor: 1500, admissionMinor: 0, perkMinor: 1500, state: "pending", code: "RESULT_UNKNOWN", refundReference: null, canRetry: false }, { id: randomUUID(), ticketId: "T-refused", tier: "vip", captureReference: "••••654321", amountMinor: 1500, admissionMinor: 0, perkMinor: 1500, state: "needs_attention", code: "EXPLICIT_RETRY_REQUIRED", refundReference: null, canRetry: true }];
  await mount(workspace, call => call.path === "/api/disruptions/commands" ? disruptionResultFixture(workspace, call.body).then(value => Response.json(value)) : undefined);
  assert.equal([...container.querySelectorAll("button")].filter(value => value.textContent === "Review original retry").length, 1);
  const unknownRow = [...container.querySelectorAll("li")].find(value => value.textContent!.includes("T-ambiguous"))!; assert.equal(unknownRow.querySelector("button"), null);
  await click(button("Review original authorization")); assert.equal(postCalls().length, 0); assert.match(dialogs()[0]!.textContent!, /does not mean the hold is released/);
  await fill(field("Producer review note"), "Review and close only the original fully uncaptured authorization."); await click(field("I reviewed this original fully")); await click(button("Record authorization cancellation"));
  await until(() => dialogs().length === 0); assert.equal(postCalls()[0]!.body.command.type, "cancel_rental"); assert.equal(postCalls()[0]!.body.command.executionId, workspace.rentalCommitments[0]!.id);
});

test("operators can assess evidence but cannot open producer cancellation or supplier void review", async () => {
  const workspace = disruptionUiFixture({ access: "operator" }); await mount(workspace);
  assert.equal(button("Reassess current alternatives").disabled, false); assert.equal(button("Review support-only policy").disabled, true); assert.equal(button("Review full cancellation").disabled, true);
  assert.equal([...container.querySelectorAll("button")].some(value => value.textContent!.includes("Review original authorization")), false);
});

test("a confirmed disruption receipt stays confirmed when the shared header refresh fails", async () => {
  const workspace = disruptionUiFixture(); let failHeader = true;
  await mount(workspace, call => {
    if (call.path === "/api/disruptions/commands") return disruptionResultFixture(workspace, call.body).then(value => Response.json(value));
    if (call.path === "/api/show") return failHeader ? Response.json({ error: "Controlled read failure" }, { status: 503 }) : Response.json(consoleData({ ...workspace, revision: workspace.revision + 1 }));
  });
  await click(button("Reassess current alternatives")); await until(() => container.textContent!.includes("shared production header could not refresh")); assert.match(container.textContent!, /Reviewed instruction recorded/); assert.equal(localStorage.getItem(disruptionRecoveryKey(workspace)), null); assert.equal(postCalls().length, 1);
  failHeader = false; await click(button("Refresh production header")); await until(() => !container.textContent!.includes("shared production header could not refresh")); assert.equal(postCalls().length, 1);
});

test("the shared production header uses the actual readiness gate count", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const show = createFixture(randomUUID()), readiness = allReadiness(show), doors = readiness.find(value => value.scope === "DOORS")!;
  doors.gates.push({ ...doors.gates[0]!, id: "additional-disruption-test-gate", complete: false });
  const initial: ConsoleData = { show, readiness, currentActor: { id: "producer:test", tenantId: show.tenantId, roles: ["producer"], personId: null }, serverAt: new Date().toISOString() };
  const markup = renderToStaticMarkup(<ProductionConsole initial={initial} view="disruptions" licenseKey="" />), document = new JSDOM(markup).window.document;
  assert.equal(document.querySelector(".cue-badge > span:last-child")?.textContent, `${doors.gates.filter(value => value.complete).length}/${doors.gates.length}`);
});

test("first touring entry asks to open a rehearsal without claiming an expired session", async () => {
  const workspace = disruptionUiFixture(); history.replaceState(null, "", "/tour"); await mount(workspace, call => call.path === "/api/tour" ? Response.json({ code: "SESSION_REQUIRED", error: "Open a rehearsal session to continue." }, { status: 401 }) : undefined, <TourConsole licenseKey="" />);
  await until(() => container.textContent!.includes("Open a rehearsal to use the library.")); assert.doesNotMatch(container.textContent!, /exact session has ended/); assert.equal(container.querySelector("a.button")?.getAttribute("href"), "/");
});

test("retained touring instructions keep expired-session recovery wording and are not adopted", async () => {
  const workspace = disruptionUiFixture(); sessionStorage.setItem("opening-night:tour:v1:old:producer:original-fingerprint", "retained-original-instruction"); history.replaceState(null, "", "/tour");
  await mount(workspace, call => call.path === "/api/tour" ? Response.json({ code: "SESSION_REQUIRED", error: "Open a rehearsal session to continue." }, { status: 401 }) : undefined, <TourConsole licenseKey="" />);
  await until(() => container.textContent!.includes("This exact session has ended.")); assert.match(container.textContent!, /reviewed instruction remains on this device for its original session/); assert.doesNotMatch(container.textContent!, /Open a rehearsal to use the library/); assert.equal(sessionStorage.getItem("opening-night:tour:v1:old:producer:original-fingerprint"), "retained-original-instruction"); assert.equal(calls.some(call => call.method === "POST"), false);
});

test("explicit touring expiry keeps its session-ended wording even without a retained draft", async () => {
  const workspace = disruptionUiFixture(); history.replaceState(null, "", "/tour");
  await mount(workspace, call => call.path === "/api/tour" ? Response.json({ code: "TOUR_SESSION_ENDED", error: "This exact session expired or was revoked." }, { status: 401 }) : undefined, <TourConsole licenseKey="" />);
  await until(() => container.textContent!.includes("This exact session has ended.")); assert.doesNotMatch(container.textContent!, /Open a rehearsal to use the library/);
});
