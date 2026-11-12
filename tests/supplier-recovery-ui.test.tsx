/** Mounted DOM, authority-state, recovery and keyboard checks. Native layout is a separate root review. */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { act, useRef, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SupplierRecoveryEnvelope, SupplierRecoveryResult, SupplierRecoveryWorkspace } from "../src/server/supplier-recovery/contracts";
import { supplierRecoveryResultFixture, supplierRecoveryUiFixture, supplierTermsCard } from "./supplier-recovery-ui-fixture";
import { ProducerSupplierRecovery, SupplierTermsPanel } from "../src/components/supplier-recovery/supplier-recovery-panel";
import { SupplierRecoveryStatus } from "../src/components/supplier-recovery/shared";
import { useSupplierRecovery } from "../src/components/supplier-recovery/use-supplier-recovery";
import { prepareSupplierRecovery, supplierRecoveryRecoveryKey } from "../src/components/supplier-recovery/recovery";
import { PRODUCTION_CHANGED_EVENT } from "../src/components/production-fetch";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:4586/recovery", pretendToBeVisual: true });
for (const name of ["window", "self", "document", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "StorageEvent", "location", "history", "localStorage", "sessionStorage", "MutationObserver"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) }); Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
dom.window.HTMLElement.prototype.getClientRects = function () { return (this.isConnected && !this.closest("[hidden]") && getComputedStyle(this).display !== "none" ? [new dom.window.DOMRect(0, 0, 120, 30)] : []) as unknown as DOMRectList; };
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); this.querySelector<HTMLElement>("[autofocus], button:not([disabled]), input:not([disabled])")?.focus(); }; dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
dom.window.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(this.download); };
const { createRoot } = await import("react-dom/client"), originalFetch = globalThis.fetch, originalSet = dom.window.Storage.prototype.setItem, originalRemove = dom.window.Storage.prototype.removeItem;
let root: Root | null = null, container: HTMLDivElement, calls: Call[] = [], downloads: string[] = [];
type Call = { path: string; method: string; body: any; headers: Headers; credentials: RequestCredentials | undefined };
type Route = (call: Call) => Response | Promise<Response> | undefined;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function Harness({ workspace }: { workspace: SupplierRecoveryWorkspace }) {
  const heading = useRef<HTMLHeadingElement>(null), client = useSupplierRecovery({ tenantId: workspace.tenantId, fallback: () => heading.current });
  return <div><h1 ref={heading} tabIndex={-1}>Current supplier workspace</h1><p>{client.data ? "Workspace ready" : "Opening workspace"}</p><SupplierRecoveryStatus client={client} /><button disabled={client.blocked} onClick={event => void client.submit({ type: "request_quotes", previewDigest: workspace.preview!.digest, detail: "Reviewed the exact current sources and all original obligations.", confirmed: true }, client.data?.revision, event.currentTarget)}>Save reviewed request</button><button disabled={Boolean(client.busy || client.ended)} onClick={event => void client.refresh(event.currentTarget)}>Refresh facts</button><input id="unrelated" aria-label="Unrelated note" /><span data-blocked={client.blocked} data-busy={client.busy ?? ""} /></div>;
}
const button = (label: string, within: ParentNode = container) => { const value = [...within.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label); assert.ok(value, `Missing button: ${label}`); return value; };
const field = (label: string, within: ParentNode = container) => { const found = [...within.querySelectorAll<HTMLLabelElement>("label")].find(item => item.textContent?.trim().startsWith(label)); assert.ok(found, `Missing field: ${label}`); const input = found.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select"); assert.ok(input, `Missing input: ${label}`); return input; };
const dialogs = () => [...container.querySelectorAll<HTMLDialogElement>("dialog[open]")], posts = () => calls.filter(call => call.path === "/api/supplier-recovery/commands" && call.method === "POST");
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await flush(); assert.ok(check(), "Supplier recovery UI did not settle"); }
async function click(element: HTMLElement) { await act(async () => { element.focus(); element.click(); }); }
async function fill(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) { await act(async () => { const prototype = element instanceof HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); }); }
async function mount(workspace: SupplierRecoveryWorkspace, route?: Route, node?: ReactNode) {
  container = document.createElement("div"); document.body.append(container); calls = []; downloads = [];
  globalThis.fetch = async (input, init) => { const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url, call: Call = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers), credentials: init?.credentials }; calls.push(call); const routed = route?.(call); if (routed) return routed; if (path === "/api/supplier-recovery") return Response.json(workspace); throw new Error(`Unexpected controlled request ${call.method} ${path}`); };
  root = createRoot(container); await act(async () => root!.render(node ?? <ProducerSupplierRecovery tenantId={workspace.tenantId} sourceRevision={workspace.revision} onSaved={() => undefined} />));
  if (!node) await until(() => Boolean(container.textContent?.includes("Original promises stay accounted for") && !button("Refresh current sources").disabled));
}
async function harness(workspace: SupplierRecoveryWorkspace, route?: Route) { await mount(workspace, route, <Harness workspace={workspace} />); await until(() => Boolean(container.textContent?.includes("Workspace ready") && container.querySelector('[data-busy=""]'))); }
async function unmount() { if (root) { await act(async () => root!.unmount()); root = null; } document.body.replaceChildren(); }
afterEach(async () => { dom.window.Storage.prototype.setItem = originalSet; dom.window.Storage.prototype.removeItem = originalRemove; await unmount(); localStorage.clear(); sessionStorage.clear(); globalThis.fetch = originalFetch; }); after(() => dom.window.close());

test("producer review shows original fee, hold and pending work without presenting new quotes as commitments", async () => {
  const workspace = supplierRecoveryUiFixture(); workspace.preview!.retained[0]!.feeInstructionPending = true; workspace.preview!.retained[0]!.verifiedFeeMinor = 0;
  await mount(workspace); assert.match(container.textContent!, /\$480\.00/); assert.match(container.textContent!, /\$300\.00/); assert.match(container.textContent!, /\$0\.00/); assert.match(container.textContent!, /fee instruction remains unresolved/); assert.match(container.textContent!, /Controlled suppliers and attributed fixture evidence/);
  assert.equal(container.querySelector('a[href="/rentals"]')?.textContent?.trim(), "Review original rentals"); assert.equal(posts().length, 0);
  await click(button("Review new quote request")); const dialog = dialogs()[0]!; assert.match(dialog.textContent!, /withdraw the current plan approval/); assert.match(dialog.textContent!, /15 real minutes/); assert.equal(button("Save this quote request", dialog).disabled, true);
  await fill(field("Why are new terms needed?", dialog), "Original unit was withdrawn; reviewed all retained commitments."); assert.equal(button("Save this quote request", dialog).disabled, true);
  await click(field("I reviewed the current supplier changes", dialog)); assert.equal(button("Save this quote request", dialog).disabled, false); assert.equal(posts().length, 0);
  await click(button("Keep reviewing", dialog)); await flush(); assert.equal(dialogs().length, 0); assert.equal(document.activeElement, button("Review new quote request"));
});

test("supplier form requires explicit new dates and attribution while unknown evidence stays unknown", async () => {
  let workspace = supplierRecoveryUiFixture({ access: "supplier", actorId: "supplier:northside:controlled", supplierId: "northside", cards: [supplierTermsCard()], preview: null }); let envelope: SupplierRecoveryEnvelope | undefined;
  await mount(workspace, call => { if (call.path === "/api/supplier-recovery/commands") { envelope = call.body; assert.ok(localStorage.getItem(supplierRecoveryRecoveryKey(workspace))); return supplierRecoveryResultFixture(workspace, call.body).then(result => { workspace = result.workspace; return Response.json(result); }); } if (call.path === "/api/supplier-recovery") return Response.json(workspace); }, <SupplierTermsPanel bearer="controlled-own-supplier" onSaved={() => undefined} onBlockedChange={() => undefined} />);
  await until(() => Boolean(container.querySelector(".supplier-owned-card"))); await click(button("Review a new terms edition")); const dialog = dialogs()[0]!;
  assert.equal(field("New delivery date and time", dialog).value, ""); assert.equal(field("Scenario quote acceptance deadline", dialog).value, ""); assert.equal(field("Qualified driver", dialog).value, "unknown"); assert.equal(field("Pre-dispatch condition", dialog).value, "unknown"); assert.equal(button("Publish this terms edition", dialog).disabled, true);
  await fill(field("New delivery date and time", dialog), "2026-11-14T17:35"); await fill(field("Scenario quote acceptance deadline", dialog), "2026-11-14T17:30"); await fill(field("Capability source", dialog), "Controlled capability sheet for this exact fixture unit."); await fill(field("Source reference", dialog), "CURRENT-CONTROLLED-NORTHSIDE"); await fill(field("Current terms and delivery responsibility", dialog), "Controlled new terms; physical delivery still requires its own inspection."); await click(field("This controlled source confirms console compatibility", dialog));
  assert.equal(button("Publish this terms edition", dialog).disabled, true); await click(field("I reviewed this exact unit", dialog)); await click(button("Publish this terms edition", dialog));
  await until(() => posts().length === 1 && dialogs().length === 0); assert.equal(envelope!.command.type, "publish_terms"); if (envelope!.command.type !== "publish_terms") throw new Error("Wrong action");
  assert.equal(envelope!.command.deliveryAt, "2026-11-14T23:35:00Z"); assert.equal(envelope!.command.expiresAt, "2026-11-14T23:30:00Z"); assert.equal(envelope!.command.qualifiedDriver, null); assert.equal(envelope!.command.driverEvidence, null); assert.equal(envelope!.command.conditionVerified, null); assert.equal(envelope!.command.conditionEvidence, null);
  assert.match(container.textContent!, /Qualified driver remains unconfirmed/); assert.match(container.textContent!, /Condition remains unconfirmed/); assert.match(container.textContent!, /Supplier-owned edition 1/);
  assert.ok(calls.every(call => call.headers.get("authorization") === "Bearer controlled-own-supplier" && call.credentials === "omit")); assert.ok(!calls.some(call => call.path.includes("/work")));
});

test("positive supplier evidence requires its own source and monetary input stays in exact cents", async () => {
  const workspace = supplierRecoveryUiFixture({ access: "supplier", supplierId: "northside", cards: [supplierTermsCard()], preview: null });
  await mount(workspace, undefined, <SupplierTermsPanel bearer="controlled-own-supplier" onSaved={() => undefined} onBlockedChange={() => undefined} />); await until(() => Boolean(container.querySelector(".supplier-owned-card"))); await click(button("Review a new terms edition")); const dialog = dialogs()[0]!;
  await fill(field("Qualified driver", dialog), "yes"); await fill(field("Pre-dispatch condition", dialog), "yes"); assert.ok(field("Controlled driver source", dialog)); assert.ok(field("Controlled condition source", dialog));
  await fill(field("New delivery date and time", dialog), "2026-11-14T17:35"); await fill(field("Scenario quote acceptance deadline", dialog), "2026-11-14T17:30"); await fill(field("Capability source", dialog), "Controlled capability evidence for the enrolled unit."); await fill(field("Source reference", dialog), "CURRENT-NORTHSIDE"); await fill(field("Current terms and delivery responsibility", dialog), "Owned delivery terms, separately accepted and approved."); await click(field("I reviewed this exact unit", dialog));
  assert.equal(button("Publish this terms edition", dialog).disabled, true); await fill(field("Controlled driver source", dialog), "Controlled qualified driver roster, no actual driver claim."); await fill(field("Controlled condition source", dialog), "Controlled pre-dispatch condition sheet, no actual inspection claim.");
  await fill(field("Rental fee (USD)", dialog), "123.456"); assert.equal(button("Publish this terms edition", dialog).disabled, true); await fill(field("Rental fee (USD)", dialog), "123.45"); assert.equal(button("Publish this terms edition", dialog).disabled, false);
  await fill(field("Separate damage hold (USD)", dialog), "10000.01"); assert.equal(button("Publish this terms edition", dialog).disabled, true); assert.equal(posts().length, 0);
});

test("saved collection keeps unresolved responses visible and cannot be continued by another session", async () => {
  const workspace = supplierRecoveryUiFixture({ requests: [{ id: randomUUID(), status: "collecting", lastCode: "SUPPLIER_UNAVAILABLE", outcomes: [{ supplierId: "northside", kind: "quote", quoteId: randomUUID() }], sessionMatches: false, expiresAt: new Date(Date.now() + 60000).toISOString(), createdAt: new Date().toISOString() }] });
  await mount(workspace); assert.match(container.textContent!, /1 signed quotes · 0 signed refusals · 2 responses unresolved/); assert.equal(button("Continue original quote collection").disabled, true); assert.equal(posts().length, 0);
});

test("an initial signed collection is retained without inventing a zero replacement quote count", async () => {
  const workspace = supplierRecoveryUiFixture({ requests: [{ id: randomUUID(), status: "applied", lastCode: null, outcomes: [], sessionMatches: false, expiresAt: null, createdAt: new Date().toISOString() }] });
  await mount(workspace); assert.match(container.textContent!, /Initial collection retained/); assert.match(container.textContent!, /initial supplier workflow and its signed quote history remain recorded/); assert.doesNotMatch(container.textContent!, /0 signed quotes|Current outcomes received/); assert.equal(posts().length, 0);
});

test("scoped supplier access requires review and exposes only its exact local private link", async () => {
  const workspace = supplierRecoveryUiFixture(); await mount(workspace, call => call.path === "/api/supplier-recovery/commands" ? supplierRecoveryResultFixture(workspace, call.body).then(value => Response.json(value)) : undefined);
  const northside = workspace.cards.find(card => card.supplierId === "northside")!; await click(button("Open " + northside.supplier + " client")); const dialog = dialogs()[0]!;
  assert.match(dialog.textContent!, /No email or external invitation is sent/); assert.equal(button("Create this scoped access", dialog).disabled, true); await click(field("I reviewed this exact supplier scope", dialog)); await click(button("Create this scoped access", dialog));
  await until(() => Boolean(container.querySelector('a[href^="/supplier/access#"]'))); assert.equal(posts().length, 1); const link = container.querySelector<HTMLAnchorElement>('a[href^="/supplier/access#"]')!; assert.match(link.getAttribute("href")!, /^\/supplier\/access#[A-Za-z0-9_-]{43}$/); assert.equal(link.rel, "noreferrer"); assert.equal(posts()[0]!.body.command.supplierId, "northside");
});

test("lost response retains one original instruction and recovers without another POST or automatic resend", async () => {
  const workspace = supplierRecoveryUiFixture(); let saved: SupplierRecoveryResult | null = null;
  await harness(workspace, call => { if (call.path === "/api/supplier-recovery/commands") return supplierRecoveryResultFixture(workspace, call.body).then(value => { saved = value; throw new TypeError("Controlled loss after command commit"); }); if (call.path.startsWith("/api/supplier-recovery/commands/")) return Response.json({ ...saved!, replayed: true }); });
  await click(button("Save reviewed request")); await until(() => posts().length === 1 && Boolean(container.querySelector(".supplier-recovery-original")) && !button("Check original result").disabled);
  assert.ok(localStorage.getItem(supplierRecoveryRecoveryKey(workspace))); assert.equal(button("Retry the same instruction").disabled, true); assert.equal(button("Save reviewed request").disabled, true);
  await act(async () => window.dispatchEvent(new Event("online"))); await flush(); assert.equal(posts().length, 1);
  await click(button("Check original result")); await until(() => !container.querySelector(".supplier-recovery-original")); assert.equal(posts().length, 1); assert.equal(localStorage.getItem(supplierRecoveryRecoveryKey(workspace)), null);
});

test("only explicit receipt absence permits a deliberate replay of identical reviewed bytes", async () => {
  const workspace = supplierRecoveryUiFixture(); let attempt = 0;
  await harness(workspace, call => { if (call.path === "/api/supplier-recovery/commands") { if (++attempt === 1) throw new TypeError("Controlled before-dispatch disconnect"); return supplierRecoveryResultFixture(workspace, call.body).then(value => Response.json(value)); } if (call.path.startsWith("/api/supplier-recovery/commands/")) return Response.json({ code: "SUPPLIER_RECOVERY_RECEIPT_NOT_FOUND", error: "Original receipt absent" }, { status: 404 }); });
  await click(button("Save reviewed request")); await until(() => Boolean(container.querySelector(".supplier-recovery-original")) && !button("Check original result").disabled); const original = structuredClone(posts()[0]!.body);
  await click(button("Check original result")); await until(() => !button("Retry the same instruction").disabled); assert.equal(posts().length, 1); await click(button("Retry the same instruction")); await until(() => posts().length === 2 && !container.querySelector(".supplier-recovery-original")); assert.deepEqual(posts()[1]!.body, original);
});

test("storage refusal sends nothing and failed receipt retirement preserves the exact recovery file", async () => {
  const workspace = supplierRecoveryUiFixture(); const route: Route = call => call.path === "/api/supplier-recovery/commands" ? supplierRecoveryResultFixture(workspace, call.body).then(value => Response.json(value)) : undefined;
  await harness(workspace, route); dom.window.Storage.prototype.setItem = function () { throw new Error("Controlled storage refusal"); }; await click(button("Save reviewed request")); await until(() => Boolean(container.textContent?.includes("Instructions are paused"))); assert.equal(posts().length, 0); assert.ok(button("Save original recovery file"));
  dom.window.Storage.prototype.setItem = originalSet; await unmount(); await harness(workspace, route); dom.window.Storage.prototype.removeItem = function () { throw new Error("Controlled retirement refusal"); };
  await click(button("Save reviewed request")); await until(() => Boolean(container.textContent?.includes("Controlled retirement refusal"))); assert.equal(posts().length, 1); assert.ok(localStorage.getItem(supplierRecoveryRecoveryKey(workspace))); assert.ok(container.querySelector(".supplier-recovery-original"));
});

test("a production switch ignores a late receipt and preserves the original session's recovery bytes", async () => {
  const workspace = supplierRecoveryUiFixture(), pending = deferred<Response>(); let result: SupplierRecoveryResult | null = null;
  await harness(workspace, call => { if (call.path === "/api/supplier-recovery/commands") { void supplierRecoveryResultFixture(workspace, call.body).then(value => { result = value; }); return pending.promise; } });
  await click(button("Save reviewed request")); await until(() => Boolean(result)); await act(async () => window.dispatchEvent(new Event(PRODUCTION_CHANGED_EVENT))); await act(async () => pending.resolve(Response.json(result!))); await flush();
  assert.match(container.textContent!, /exact supplier access has ended/); assert.ok(localStorage.getItem(supplierRecoveryRecoveryKey(workspace))); assert.equal(posts().length, 1);
});

test("reload adopts only the same session and never automatically submits retained instructions", async () => {
  const workspace = supplierRecoveryUiFixture(), envelope = { commandId: randomUUID(), expectedRevision: 20, command: { type: "request_quotes" as const, previewDigest: workspace.preview!.digest, detail: "Retain this exact source review across a controlled reload.", confirmed: true as const } }, saved = await prepareSupplierRecovery(workspace, envelope);
  localStorage.setItem(supplierRecoveryRecoveryKey(workspace), JSON.stringify(saved)); await harness(workspace); assert.ok(container.querySelector(".supplier-recovery-original")); assert.equal(posts().length, 0);
  await unmount(); await harness({ ...workspace, sessionFingerprint: "c".repeat(64) }); assert.equal(container.querySelector(".supplier-recovery-original"), null); assert.ok(localStorage.getItem(supplierRecoveryRecoveryKey(workspace))); assert.equal(posts().length, 0);
});

test("a mismatched receipt cannot retire the original review and an explicit stale rejection requires refresh", async () => {
  const workspace = supplierRecoveryUiFixture(); await harness(workspace, call => call.path === "/api/supplier-recovery/commands" ? supplierRecoveryResultFixture(workspace, call.body).then(value => Response.json({ ...value, receipt: { ...value.receipt, action: "publish_terms" } })) : undefined);
  await click(button("Save reviewed request")); await until(() => Boolean(container.textContent?.includes("does not match this exact instruction"))); assert.ok(localStorage.getItem(supplierRecoveryRecoveryKey(workspace))); await unmount(); localStorage.clear();
  await harness(workspace, call => call.path === "/api/supplier-recovery/commands" ? Response.json({ code: "STALE_REVISION", error: "Current source changed" }, { status: 409 }) : undefined);
  await click(button("Save reviewed request")); await until(() => Boolean(container.textContent?.includes("Current source changed"))); assert.equal(localStorage.getItem(supplierRecoveryRecoveryKey(workspace)), null); assert.equal(button("Save reviewed request").disabled, true); await click(button("Refresh facts")); await until(() => !button("Save reviewed request").disabled);
});

test("late completion does not steal focus from newer input and first entry does not claim an expired session", async () => {
  const workspace = supplierRecoveryUiFixture(), pending = deferred<Response>(); let saved: SupplierRecoveryResult | null = null;
  await harness(workspace, call => { if (call.path === "/api/supplier-recovery/commands") { void supplierRecoveryResultFixture(workspace, call.body).then(value => { saved = value; }); return pending.promise; } });
  await click(button("Save reviewed request")); await until(() => Boolean(saved)); const input = container.querySelector<HTMLInputElement>("#unrelated")!; await act(async () => input.focus()); await act(async () => pending.resolve(Response.json(saved!))); await flush(); assert.equal(document.activeElement, input);
  await unmount(); await mount(workspace, call => call.path === "/api/supplier-recovery" ? Response.json({ code: "SESSION_REQUIRED", error: "Open authorized access" }, { status: 401 }) : undefined, <Harness workspace={workspace} />);
  await until(() => Boolean(container.textContent?.includes("Open authorized production access"))); assert.doesNotMatch(container.textContent!, /exact supplier access has ended/); assert.equal(posts().length, 0);
});
