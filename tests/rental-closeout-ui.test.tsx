/** DOM/state/focus checks only. Real browser layout and native faults remain separate root review. */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { act, useRef, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ConsoleData } from "../src/domain/contracts";
import type { CloseoutEnvelope, CloseoutResult, CloseoutWorkspace } from "../src/server/rental-closeout/contracts";
import { RentalCloseoutDesk, SupplierRentalCloseout } from "../src/components/rental-closeout/rental-desk";
import { CloseoutStatus } from "../src/components/rental-closeout/shared";
import { useRentalCloseout } from "../src/components/rental-closeout/use-rental-closeout";
import { closeoutRecoveryKey, prepareCloseout } from "../src/components/rental-closeout/recovery";
import { PRODUCTION_CHANGED_EVENT } from "../src/components/production-fetch";
import { rentalCardFixture, rentalPreviewFixture, rentalResultFixture, rentalUiFixture, returnedRentalFixture } from "./rental-closeout-ui-fixture";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:4580/rentals", pretendToBeVisual: true });
for (const name of ["window", "self", "document", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "StorageEvent", "location", "history", "localStorage", "sessionStorage", "MutationObserver"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
dom.window.HTMLElement.prototype.getClientRects = function () { return (this.isConnected && !this.closest("[hidden]") && getComputedStyle(this).display !== "none" ? [new dom.window.DOMRect(0, 0, 120, 30)] : []) as unknown as DOMRectList; };
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); this.querySelector<HTMLElement>("[autofocus], button:not([disabled]), input:not([disabled])")?.focus(); };
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
dom.window.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(this.download); };
const { createRoot } = await import("react-dom/client");
const originalFetch = globalThis.fetch, originalSet = dom.window.Storage.prototype.setItem, originalRemove = dom.window.Storage.prototype.removeItem;
let root: Root | null = null, container: HTMLDivElement, calls: Call[] = [], downloads: string[] = [];
type Call = { path: string; method: string; body: any; headers: Headers; credentials: RequestCredentials | undefined };
type Route = (call: Call) => Response | Promise<Response> | undefined;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const consoleData = (workspace: CloseoutWorkspace) => ({ show: { tenantId: workspace.tenantId, revision: workspace.revision } }) as ConsoleData;
function Harness({ workspace }: { workspace: CloseoutWorkspace }) {
  const heading = useRef<HTMLHeadingElement>(null), client = useRentalCloseout({ tenantId: workspace.tenantId, fallback: () => heading.current });
  return <div><h1 ref={heading} tabIndex={-1}>Original rental workspace</h1><p>{client.data ? "Workspace ready" : "Opening workspace"}</p><CloseoutStatus client={client} /><button id="submit" disabled={client.blocked} onClick={event => void client.submit({ type: "reconcile_closeout", executionId: workspace.rentals[0]!.id, intentId: workspace.rentals[0]!.originalFeeIntentId! }, client.data?.revision, event.currentTarget)}>Read original fee</button><button id="refresh" disabled={Boolean(client.busy || client.ended)} onClick={event => void client.refresh(event.currentTarget)}>Refresh facts</button><input id="unrelated" aria-label="Unrelated note" /><span data-blocked={client.blocked} data-busy={client.busy ?? ""} /></div>;
}
const button = (label: string, within: ParentNode = container) => { const value = [...within.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label); assert.ok(value, `Missing button: ${label}`); return value; };
const field = (label: string, within: ParentNode = container) => { const found = [...within.querySelectorAll<HTMLLabelElement>("label")].find(item => item.textContent?.trim().startsWith(label)); assert.ok(found, `Missing field: ${label}`); const input = found.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea") ?? (found.htmlFor ? document.getElementById(found.htmlFor) as HTMLInputElement : null); assert.ok(input, `Missing input: ${label}`); return input; };
const dialogs = () => [...container.querySelectorAll<HTMLDialogElement>("dialog[open]")];
const posts = () => calls.filter(call => call.path === "/api/rental-closeout/commands" && call.method === "POST");
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await flush(); assert.ok(check(), "Rental UI did not settle"); }
async function click(element: HTMLElement) { await act(async () => { element.focus(); element.click(); }); }
async function fill(element: HTMLInputElement | HTMLTextAreaElement, value: string) { await act(async () => { const prototype = element instanceof HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function mount(workspace: CloseoutWorkspace, route?: Route, node?: ReactNode) {
  container = document.createElement("div"); document.body.append(container); calls = []; downloads = [];
  globalThis.fetch = async (input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const call: Call = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers), credentials: init?.credentials }; calls.push(call); const routed = route?.(call); if (routed) return routed;
    if (path === "/api/rental-closeout") return Response.json(workspace);
    if (path === "/api/rental-closeout/preview") return Response.json(rentalPreviewFixture(workspace, call.body.executionId));
    if (path === "/api/show") return Response.json(consoleData(workspace));
    throw new Error(`Unexpected controlled request ${call.method} ${path}`);
  };
  root = createRoot(container); await act(async () => root!.render(node ?? <RentalCloseoutDesk data={consoleData(workspace)} onData={() => undefined} run={async () => null} busy={null} licenseKey="" />));
  if (!node) await until(() => container.textContent?.includes("Separate from the accepted fee") ?? false);
}
async function harness(workspace: CloseoutWorkspace, route?: Route) { await mount(workspace, route, <Harness workspace={workspace} />); await until(() => Boolean(container.textContent?.includes("Workspace ready") && container.querySelector('[data-busy=""]'))); }
async function unmount() { if (root) { await act(async () => root!.unmount()); root = null; } document.body.replaceChildren(); }
afterEach(async () => { dom.window.Storage.prototype.setItem = originalSet; dom.window.Storage.prototype.removeItem = originalRemove; await unmount(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, "", "/rentals"); globalThis.fetch = originalFetch; });
after(() => dom.window.close());

test("producer desk distinguishes original fee, earlier-plan commitment and an unverified remaining hold", async () => {
  const workspace = rentalUiFixture(); await mount(workspace);
  assert.match(container.textContent!, /EARLIER PLAN v2/); assert.match(container.textContent!, /\$480\.00/); assert.match(container.textContent!, /\$300\.00/); assert.match(container.textContent!, /\$0\.00/);
  assert.match(container.textContent!, /Actual providers are disabled/); assert.match(container.textContent!, /no actual payment or physical return/);
  assert.equal(button("Review original hold").disabled, true); assert.equal(posts().length, 0); assert.equal(container.querySelector('a[href="/wrap"]')?.textContent?.includes("whole show account"), true);
});

test("supplier return is exact-unit, explicitly conditioned and separately acknowledged before sending", async () => {
  let workspace = rentalUiFixture({ access: "supplier", actorId: "supplier:brightline:controlled", supplierId: "brightline", rentals: [rentalCardFixture()] }); let envelope: CloseoutEnvelope | undefined;
  await mount(workspace, call => { if (call.path === "/api/rental-closeout/commands") { envelope = call.body; assert.ok(localStorage.getItem(closeoutRecoveryKey(workspace))); return rentalResultFixture(workspace, call.body).then(result => { workspace = result.workspace; return Response.json(result); }); } if (call.path === "/api/rental-closeout") return Response.json(workspace); }, <SupplierRentalCloseout bearer="controlled-original-supplier" />);
  await until(() => Boolean(container.querySelector(".rental-card"))); await click(button("Inspect original return"));
  const dialog = dialogs()[0]!; assert.ok(dialog); assert.equal(button("Record return inspection", dialog).disabled, true);
  await click(field("Returned undamaged", dialog)); await fill(field("Inspection and condition note", dialog), "Controlled original LX-204 return observation; preserve its already accepted fee.");
  assert.equal(button("Record return inspection", dialog).disabled, true); await click(field("I reviewed this original unit", dialog)); await click(button("Record return inspection", dialog));
  await until(() => posts().length === 1 && dialogs().length === 0); assert.equal(envelope?.command.type, "record_return");
  assert.equal((envelope!.command as any).executionId, workspace.rentals[0]!.id); assert.equal((envelope!.command as any).condition, "undamaged"); assert.equal((envelope!.command as any).executionDigest, workspace.rentals[0]!.executionDigest);
  assert.ok(calls.filter(call => call.path.startsWith("/api/rental-closeout")).every(call => call.headers.get("authorization") === "Bearer controlled-original-supplier" && call.credentials === "omit"));
  assert.equal(workspace.rentals[0]!.releasedMinor, 0); assert.ok(!calls.some(call => call.path === "/api/rental-closeout/work"));
});

test("producer opens a fresh exact preview, then explicitly approves the original remaining amount", async () => {
  let workspace = rentalUiFixture({ rentals: [returnedRentalFixture()] });
  await mount(workspace, call => { if (call.path === "/api/rental-closeout/commands") return rentalResultFixture(workspace, call.body).then(result => { workspace = result.workspace; return Response.json(result); }); if (call.path === "/api/show") return Response.json(consoleData(workspace)); });
  const opener = button("Review original hold"); await click(opener); await until(() => dialogs().length === 1); const dialog = dialogs()[0]!;
  assert.equal(posts().length, 0); assert.match(dialog.textContent!, /\$780\.00/); assert.match(dialog.textContent!, /\$480\.00/); assert.match(dialog.textContent!, /\$300\.00/); assert.match(dialog.textContent!, /earlier plan/);
  assert.equal(button("Approve original hold closure", dialog).disabled, true);
  await fill(field("Producer review note", dialog), "Reviewed the original unit, undamaged controlled return, captured fee and remaining hold."); await click(field("I reviewed the original unit", dialog)); await click(button("Approve original hold closure", dialog));
  await until(() => dialogs().length === 0 && posts().length === 1); assert.equal(posts()[0]!.body.command.previewDigest, "b".repeat(64));
  assert.match(container.textContent!, /original approval is saved/); assert.equal(button("Check approved rental work").disabled, true); assert.equal(workspace.rentals[0]!.releasedMinor, 0);
  await flush(); assert.equal(document.activeElement?.tagName, "H1");
});

test("lost response retains exactly one command and recovers its receipt without another POST", async () => {
  const workspace = rentalUiFixture(); let saved: CloseoutResult | null = null;
  await harness(workspace, call => { if (call.path === "/api/rental-closeout/commands") return rentalResultFixture(workspace, call.body).then(result => { saved = result; throw new TypeError("Controlled lost response after commit"); }); if (call.path.startsWith("/api/rental-closeout/commands/")) return Response.json({ ...saved!, replayed: true }); });
  await click(button("Read original fee")); await until(() => posts().length === 1 && Boolean(container.querySelector(".rental-recovery")));
  assert.ok(localStorage.getItem(closeoutRecoveryKey(workspace))); assert.equal(button("Retry the same instruction").disabled, true); assert.equal(button("Read original fee").disabled, true);
  await act(async () => window.dispatchEvent(new Event("online"))); await flush(); assert.equal(posts().length, 1);
  await click(button("Check original result")); await until(() => !container.querySelector(".rental-recovery")); assert.equal(posts().length, 1); assert.equal(localStorage.getItem(closeoutRecoveryKey(workspace)), null);
});

test("confirmed absence enables only an explicit replay of the same retained identity and body", async () => {
  const workspace = rentalUiFixture(); let attempt = 0;
  await harness(workspace, call => { if (call.path === "/api/rental-closeout/commands") { if (++attempt === 1) throw new TypeError("Controlled before-dispatch disconnect"); return rentalResultFixture(workspace, call.body).then(value => Response.json(value)); } if (call.path.startsWith("/api/rental-closeout/commands/")) return Response.json({ code: "RENTAL_CLOSEOUT_RECEIPT_NOT_FOUND", error: "Original receipt absent" }, { status: 404 }); });
  await click(button("Read original fee")); await until(() => posts().length === 1 && Boolean(container.querySelector(".rental-recovery")) && !button("Check original result").disabled); const original = structuredClone(posts()[0]!.body);
  await click(button("Check original result")); await until(() => !button("Retry the same instruction").disabled); assert.equal(posts().length, 1);
  await click(button("Retry the same instruction")); await until(() => posts().length === 2 && !container.querySelector(".rental-recovery")); assert.deepEqual(posts()[1]!.body, original);
});

test("storage refusal sends nothing and a failed receipt removal retains the exact original file", async () => {
  const workspace = rentalUiFixture(); await harness(workspace, call => call.path === "/api/rental-closeout/commands" ? rentalResultFixture(workspace, call.body).then(value => Response.json(value)) : undefined);
  dom.window.Storage.prototype.setItem = function () { throw new Error("Controlled storage refusal"); };
  await click(button("Read original fee")); await until(() => container.textContent?.includes("Instructions are paused") ?? false); assert.equal(posts().length, 0); assert.ok(button("Save original recovery file"));
  dom.window.Storage.prototype.setItem = originalSet; await unmount(); await harness(workspace, call => call.path === "/api/rental-closeout/commands" ? rentalResultFixture(workspace, call.body).then(value => Response.json(value)) : undefined);
  dom.window.Storage.prototype.removeItem = function () { throw new Error("Controlled retirement refusal"); };
  await click(button("Read original fee")); await until(() => container.textContent?.includes("Controlled retirement refusal") ?? false); assert.equal(posts().length, 1); assert.ok(localStorage.getItem(closeoutRecoveryKey(workspace))); assert.ok(container.querySelector(".rental-recovery"));
});

test("a wrong receipt cannot retire the saved original command", async () => {
  const workspace = rentalUiFixture(); await harness(workspace, call => call.path === "/api/rental-closeout/commands" ? rentalResultFixture(workspace, call.body).then(result => Response.json({ ...result, receipt: { ...result.receipt, action: "approve_closeout" } })) : undefined);
  await click(button("Read original fee")); await until(() => container.textContent?.includes("does not match this exact instruction") ?? false); assert.ok(localStorage.getItem(closeoutRecoveryKey(workspace))); assert.equal(button("Read original fee").disabled, true);
});

test("a definite stale rejection retires only that original command and requires a refresh", async () => {
  const workspace = rentalUiFixture(); await harness(workspace, call => call.path === "/api/rental-closeout/commands" ? Response.json({ code: "STALE_REVISION", error: "Current production changed" }, { status: 409 }) : undefined);
  await click(button("Read original fee")); await until(() => container.textContent?.includes("Current production changed") ?? false); assert.equal(localStorage.getItem(closeoutRecoveryKey(workspace)), null); assert.equal(button("Read original fee").disabled, true);
  await click(button("Refresh facts")); await until(() => !button("Read original fee").disabled); assert.equal(posts().length, 1);
});

test("another production switch preserves the pending original file and rejects a late result", async () => {
  const workspace = rentalUiFixture(), pending = deferred<Response>(); let result: CloseoutResult | null = null;
  await harness(workspace, call => { if (call.path === "/api/rental-closeout/commands") { void rentalResultFixture(workspace, call.body).then(value => { result = value; }); return pending.promise; } });
  await click(button("Read original fee")); await until(() => posts().length === 1 && Boolean(result));
  await act(async () => window.dispatchEvent(new Event(PRODUCTION_CHANGED_EVENT))); await act(async () => pending.resolve(Response.json(result!))); await flush();
  assert.match(container.textContent!, /exact rental access has ended/); assert.ok(localStorage.getItem(closeoutRecoveryKey(workspace))); assert.equal(posts().length, 1);
});

test("reload reopens only the same capability's pending command without automatic submission", async () => {
  const workspace = rentalUiFixture(), envelope = { commandId: randomUUID(), expectedRevision: workspace.revision, command: { type: "reconcile_closeout" as const, executionId: workspace.rentals[0]!.id, intentId: workspace.rentals[0]!.originalFeeIntentId! } }, saved = await prepareCloseout(workspace, envelope);
  localStorage.setItem(closeoutRecoveryKey(workspace), JSON.stringify(saved)); await harness(workspace); assert.ok(container.querySelector(".rental-recovery")); assert.equal(posts().length, 0);
  await unmount(); const other = { ...workspace, sessionFingerprint: "c".repeat(64) }; await harness(other); assert.equal(container.querySelector(".rental-recovery"), null); assert.ok(localStorage.getItem(closeoutRecoveryKey(workspace))); assert.equal(posts().length, 0);
});

test("late completion does not steal focus from a newer user action", async () => {
  const workspace = rentalUiFixture(), pending = deferred<Response>(); let saved: CloseoutResult | null = null;
  await harness(workspace, call => { if (call.path === "/api/rental-closeout/commands") { void rentalResultFixture(workspace, call.body).then(value => { saved = value; }); return pending.promise; } });
  await click(button("Read original fee")); await until(() => Boolean(saved)); const unrelated = container.querySelector<HTMLInputElement>("#unrelated")!; await act(async () => unrelated.focus()); await act(async () => pending.resolve(Response.json(saved!))); await flush(); assert.equal(document.activeElement, unrelated);
});

test("first entry asks for authorized access rather than claiming a session ended", async () => {
  const workspace = rentalUiFixture(); await mount(workspace, call => call.path === "/api/rental-closeout" ? Response.json({ code: "SESSION_REQUIRED", error: "Open a production session" }, { status: 401 }) : undefined, <Harness workspace={workspace} />);
  await until(() => container.textContent?.includes("Open authorized production access") ?? false); assert.doesNotMatch(container.textContent!, /exact rental access has ended/); assert.equal(posts().length, 0);
});
