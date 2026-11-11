import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
// next/dynamic sees the server boundary here; vendor canvas/grid modules stay
// in their loading state. This suite tests DOM interactions, not native layout.
import { WrapDesk } from "../src/components/wrap/wrap-desk";
import type { WrapAssistantWorkspace } from "../src/domain/wrap/assistant";
import type { WrapData } from "../src/domain/wrap/contracts";
import { PRODUCTION_CHANGED_EVENT } from "../src/components/production-fetch";
import { wrapUiFixture } from "./wrap-ui-fixture";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:4544", pretendToBeVisual: true });
for (const name of ["window", "document", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLDialogElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "SubmitEvent", "StorageEvent"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
// jsdom has no layout or modal top layer. Explicit geometry/dialog shims let us
// exercise the application's focus decisions; root IAB verifies native behavior.
dom.window.HTMLElement.prototype.getClientRects = function () {
  if (!this.isConnected || this.closest("[hidden]")) return [] as unknown as DOMRectList;
  return [new dom.window.DOMRect(0, 0, 120, 30)] as unknown as DOMRectList;
};
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); this.querySelector<HTMLElement>("[autofocus], input:not([disabled]), button:not([disabled])")?.focus(); };
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
const { createRoot } = await import("react-dom/client");
const originalFetch = globalThis.fetch;
let root: Root | null = null, container: HTMLDivElement, downloads: string[] = [];
type Fixture = ReturnType<typeof wrapUiFixture>;
type FetchCall = { path: string; method: string; body: unknown; headers: Headers };
let calls: FetchCall[] = [], unexpectedCalls: FetchCall[] = [];
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const reportBytes = (f: Fixture) => new Response(f.bytes, { headers: { "X-Report-SHA256": f.data.editions[0]!.reportDigest } });
const button = (text: string) => { const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent?.trim() === text); assert.ok(found, `Missing button: ${text}`); return found; };
const tab = (id: string) => { const found = container.querySelector<HTMLButtonElement>(`#wrap-tab-${id}`); assert.ok(found); return found; };
async function click(target: HTMLElement) { await act(async () => { target.focus(); target.click(); }); }
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }
async function until(condition: () => boolean) { for (let step = 0; step < 40 && !condition(); step += 1) await flush(); assert.ok(condition(), "DOM did not settle"); }
function nativeDisabledBlur(target: HTMLElement) { target.blur(); assert.equal(document.activeElement, document.body); }
async function mount(f: Fixture, route?: (call: FetchCall) => Response | Promise<Response> | undefined) {
  container = document.createElement("div"); document.body.append(container); calls = []; downloads = []; unexpectedCalls = [];
  globalThis.fetch = async (input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const call: FetchCall = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) };
    calls.push(call);
    const overridden = route?.(call); if (overridden) return overridden;
    if (path === "/api/wrap" && call.method === "GET") return json(f.data);
    if (path === "/api/show") return json(f.consoleData);
    if (path === "/api/wrap/assistant" && call.method === "GET") return json(f.workspace);
    if (["/api/settlement", "/api/payouts"].includes(path) && call.method === "GET") return json({ error: "Crew data is outside this synthetic focus fixture." }, 503);
    unexpectedCalls.push(call);
    throw new Error(`Unexpected synthetic request: ${call.method} ${path}`);
  };
  root = createRoot(container);
  await render(f);
  await until(() => Boolean(container.querySelector("#wrap-tab-account")));
}
async function render(f: Fixture) { await act(async () => root!.render(<WrapDesk data={f.consoleData} onData={() => undefined} licenseKey="" run={async () => null} busy={null} />)); }
afterEach(async () => { if (root) { await act(async () => root?.unmount()); root = null; } document.body.replaceChildren(); globalThis.fetch = originalFetch; assert.deepEqual(unexpectedCalls, [], "No unexpected or real requests are allowed"); });
after(() => dom.window.close());

for (const format of ["PDF", "JSON"] as const) test(`${format} download restores its initiating control after verified async bytes`, async () => {
  const f = wrapUiFixture(), response = deferred<Response>();
  await mount(f, call => call.path.includes(`format=${format.toLowerCase()}`) ? response.promise : undefined);
  await click(tab("reports")); const opener = button(format); await click(opener);
  assert.equal(opener.disabled, true); nativeDisabledBlur(opener);
  opener.click(); assert.equal(calls.filter(call => call.path.includes("format=")).length, 1);
  response.resolve(reportBytes(f)); await until(() => !opener.disabled);
  assert.equal(document.activeElement, opener); assert.deepEqual(downloads, [`opening-night-wrap-edition-1.${format.toLowerCase()}`]);
  assert.match(container.textContent!, /original byte hash verified/);
});

test("an explicit click origin is retained even when the browser did not focus the button", async () => {
  const f = wrapUiFixture(), response = deferred<Response>();
  await mount(f, call => call.path.includes("format=json") ? response.promise : undefined);
  await click(tab("reports")); tab("reports").blur(); const opener = button("JSON");
  await act(async () => opener.click()); assert.equal(document.activeElement, document.body);
  response.resolve(reportBytes(f)); await until(() => !opener.disabled); assert.equal(document.activeElement, opener);
});

test("download error restores the control while leaving the original edition intact", async () => {
  const f = wrapUiFixture(), response = deferred<Response>();
  await mount(f, call => call.path.includes("format=json") ? response.promise : undefined);
  await click(tab("reports")); const opener = button("JSON"); await click(opener); nativeDisabledBlur(opener);
  response.resolve(new Response("changed bytes", { headers: { "X-Report-SHA256": f.data.report.contentDigest } })); await until(() => !opener.disabled);
  assert.equal(document.activeElement, opener); assert.match(container.querySelector('[role="alert"]')!.textContent!, /did not match/); assert.deepEqual(downloads, []);
});

test("moving focus elsewhere and then to BODY permanently cancels the old return", async () => {
  const f = wrapUiFixture(), response = deferred<Response>();
  await mount(f, call => call.path.includes("format=json") ? response.promise : undefined);
  await click(tab("reports")); const opener = button("JSON"); await click(opener); nativeDisabledBlur(opener);
  tab("invoices").focus(); tab("invoices").blur();
  response.resolve(reportBytes(f)); await until(() => !opener.disabled);
  assert.equal(document.activeElement, document.body);
});

for (const movement of ["pointer", "keyboard", "session"] as const) test(`${movement} navigation during a pending action prevents focus restoration`, async () => {
  const f = wrapUiFixture(), response = deferred<Response>();
  await mount(f, call => call.path.includes("format=json") ? response.promise : undefined);
  await click(tab("reports")); const opener = button("JSON"); await click(opener); nativeDisabledBlur(opener);
  if (movement === "pointer") document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  if (movement === "keyboard") document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  if (movement === "session") window.dispatchEvent(new Event(PRODUCTION_CHANGED_EVENT));
  response.resolve(reportBytes(f)); await until(() => !opener.disabled);
  assert.equal(document.activeElement, document.body);
});

test("leaving and returning to a section invalidates its earlier action", async () => {
  const f = wrapUiFixture(), response = deferred<Response>();
  await mount(f, call => call.path.includes("format=json") ? response.promise : undefined);
  await click(tab("reports")); const opener = button("JSON"); await click(opener);
  await click(tab("invoices")); await click(tab("reports")); const destination = tab("reports");
  response.resolve(reportBytes(f)); await until(() => !button("JSON").disabled);
  assert.equal(document.activeElement, destination);
});

for (const change of ["account", "actor", "role"] as const) test(`${change} change unmounts the old account and prevents stale completion focus`, async () => {
  const f = wrapUiFixture(), response = deferred<Response>(); let current = f;
  await mount(f, call => call.path.includes("format=json") ? response.promise : call.path === "/api/wrap" ? json(current.data) : undefined);
  await click(tab("reports")); await click(button("JSON"));
  const next = change === "account" ? wrapUiFixture() : structuredClone(f);
  if (change === "actor") { next.consoleData.currentActor.id = "producer:next"; next.data.actorId = "producer:next"; }
  if (change === "role") next.consoleData.currentActor.roles = ["producer"];
  current = next; await render(next); await until(() => Boolean(container.querySelector('input[placeholder="Find an account line…"]')));
  const destination = container.querySelector<HTMLInputElement>('input[placeholder="Find an account line…"]')!; destination.focus();
  response.resolve(reportBytes(f)); await flush();
  assert.equal(document.activeElement, destination); assert.deepEqual(downloads, []); assert.equal(tab("account").getAttribute("aria-selected"), "true");
});

test("unmount cancels a pending response without focusing a detached control", async () => {
  const f = wrapUiFixture(), response = deferred<Response>();
  await mount(f, call => call.path.includes("format=json") ? response.promise : undefined);
  await click(tab("reports")); await click(button("JSON"));
  await act(async () => root!.unmount()); root = null;
  const destination = document.createElement("button"); document.body.append(destination); destination.focus();
  response.resolve(reportBytes(f)); await flush(); assert.equal(document.activeElement, destination); assert.deepEqual(downloads, []);
});

test("a completed queued invoice action falls back to its section heading when removed", async () => {
  const f = wrapUiFixture(), response = deferred<Response>();
  await mount(f, call => call.path === "/api/wrap/work" ? response.promise : undefined);
  await click(tab("invoices")); const opener = button("Continue reviewed work"); await click(opener); nativeDisabledBlur(opener);
  const updated = structuredClone(f.data); updated.invoices[0]!.grants[0]!.state = "dispatched";
  response.resolve(json({ data: updated })); await until(() => !opener.isConnected);
  assert.equal(document.activeElement?.textContent, "A claim with a clear trail.");
});

test("invoice reconciliation preserves one opener across both retained requests", async () => {
  const f = wrapUiFixture(), first = deferred<Response>(), second = deferred<Response>();
  await mount(f, call => call.path === "/api/wrap" && call.method === "POST" ? first.promise : call.path === "/api/wrap/work" ? second.promise : undefined);
  await click(tab("invoices")); const opener = button("Reconcile original"); await click(opener); nativeDisabledBlur(opener);
  first.resolve(json({ data: f.data })); await until(() => calls.some(call => call.path === "/api/wrap/work")); assert.equal(opener.disabled, true);
  second.resolve(json({ data: f.data })); await until(() => !opener.disabled); assert.equal(document.activeElement, opener);
  assert.equal(calls.filter(call => call.method === "POST").length, 2);
  const original = calls.find(call => call.path === "/api/wrap" && call.method === "POST")!;
  assert.equal((original.body as { command: { invoiceId: string } }).command.invoiceId, f.invoice.id);
});

test("unknown outcome keeps the busy/replay guard and recovers the exact request", async () => {
  const f = wrapUiFixture(), first = deferred<Response>(); let mutations = 0;
  await mount(f, call => { if (call.path === "/api/wrap/work") return ++mutations === 1 ? first.promise : json({ data: f.data }); });
  await click(tab("invoices")); const opener = button("Continue reviewed work"); await click(opener); nativeDisabledBlur(opener);
  first.reject(new Error("Synthetic connection interruption")); await until(() => Boolean(container.querySelector('[role="alert"]')));
  assert.equal(opener.disabled, true); assert.equal(document.activeElement?.textContent, "A claim with a clear trail.");
  opener.click(); assert.equal(mutations, 1); const recovery = button("Recover original request"); await click(recovery);
  await until(() => !opener.disabled); assert.equal(mutations, 2);
  const posts = calls.filter(call => call.path === "/api/wrap/work"); assert.deepEqual(posts[0]!.body, posts[1]!.body);
  assert.equal(document.activeElement?.textContent, "A claim with a clear trail.");
});

test("a rejected async invoice review restores its exact opener", async () => {
  const f = wrapUiFixture(), response = deferred<Response>();
  await mount(f, call => call.path === "/api/wrap/invoice-review" ? response.promise : undefined);
  await click(tab("invoices")); const opener = button("Review share-link issuance"); await click(opener); nativeDisabledBlur(opener);
  response.resolve(json({ error: "Synthetic stale original review" }, 409)); await until(() => !opener.disabled);
  assert.equal(document.activeElement, opener); assert.equal(container.querySelector("dialog"), null);
});

test("native-dialog ownership remains intact after async review and Escape", async () => {
  const f = wrapUiFixture(), response = deferred<Response>();
  await mount(f, call => call.path === "/api/wrap/invoice-review" ? response.promise : undefined);
  await click(tab("invoices")); const opener = button("Review share-link issuance"); await click(opener); nativeDisabledBlur(opener);
  response.resolve(json({ data: f.data, review: { invoiceId: f.invoice.id, operation: "send", digest: "a".repeat(64), envelope: null, rawDigest: null, expiresInMinutes: 10, blockers: ["Synthetic held review"], delivery: "share_link_only", datePolicy: "Original date", termsPolicy: "Original terms" } }));
  await until(() => Boolean(container.querySelector("dialog[open]"))); const dialog = container.querySelector("dialog")!;
  assert.ok(dialog.contains(document.activeElement));
  await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
  assert.equal(container.querySelector("dialog"), null); assert.equal(document.activeElement, opener);
});

test("a review response cannot open a dialog after the person moved elsewhere", async () => {
  const f = wrapUiFixture(), response = deferred<Response>();
  await mount(f, call => call.path === "/api/wrap/invoice-review" ? response.promise : undefined);
  await click(tab("invoices")); const opener = button("Review share-link issuance"); await click(opener);
  tab("reports").focus(); response.resolve(json({ data: f.data, review: {} })); await until(() => !opener.disabled);
  assert.equal(document.activeElement, tab("reports")); assert.equal(container.querySelector("dialog"), null);
});

for (const outcome of ["available", "unavailable", "error"] as const) test(`assistant metadata shows loading before its settled ${outcome} state`, async () => {
  const f = wrapUiFixture(), response = deferred<Response>();
  await mount(f, call => call.path === "/api/wrap/assistant" ? response.promise : undefined);
  await click(tab("assistant"));
  assert.match(container.textContent!, /LOADING ASSISTANT/); assert.doesNotMatch(container.textContent!, /MODEL UNAVAILABLE/);
  assert.equal(button("Start scoped analysis").disabled, true); assert.equal(button("Read original record").disabled, true);
  response.resolve(outcome === "error" ? json({ error: "Synthetic metadata failure" }, 503) : json(outcome === "available" ? f.workspace : { ...f.workspace, available: false, provenance: "unavailable" } satisfies WrapAssistantWorkspace));
  await until(() => !container.textContent!.includes("LOADING ASSISTANT"));
  assert.match(container.textContent!, outcome === "available" ? /CONTROLLED RESPONSES/ : outcome === "unavailable" ? /MODEL UNAVAILABLE/ : /ASSISTANT LOAD FAILED/);
  assert.equal(button("Start scoped analysis").disabled, outcome !== "available"); assert.equal(button("Read original record").disabled, outcome === "error");
});

for (const outcome of ["success", "error"] as const) test(`Toolkit ${outcome} returns focus to its exact read button`, async () => {
  const f = wrapUiFixture(), response = deferred<Response>();
  await mount(f, call => call.path === "/api/wrap/toolkit" ? response.promise : undefined);
  await click(tab("assistant")); await until(() => !button("Read original record").disabled);
  const opener = button("Read original record"); await click(opener); nativeDisabledBlur(opener);
  response.resolve(outcome === "error" ? json({ error: "Synthetic original unavailable" }, 409) : json({ data: f.data, receipt: { id: "synthetic-read", commandId: "synthetic-command", kind: "toolkit_read", actorId: f.data.actorId, recordedAt: f.data.serverAt, digest: "a".repeat(64), tool: "get_invoice", providerId: f.invoice.providerId, transport: "local_fixture", outcome: "verified_read", summary: "Synthetic retained read.", responseDigest: "b".repeat(64) }, pending: false }));
  await until(() => !opener.disabled); assert.equal(document.activeElement, opener);
  assert.match(container.textContent!, outcome === "success" ? /Synthetic retained read/ : /Synthetic original unavailable/);
});

test("analysis start restores its submitter and completed continuation uses the heading", async () => {
  const f = wrapUiFixture(), start = deferred<Response>(), continuation = deferred<Response>();
  await mount(f, call => call.path === "/api/wrap/assistant" && call.method === "POST" ? start.promise : call.path === `/api/wrap/assistant/${f.run.id}` ? continuation.promise : undefined);
  await click(tab("assistant")); await until(() => !button("Start scoped analysis").disabled);
  const opener = button("Start scoped analysis"); await click(opener); nativeDisabledBlur(opener);
  start.resolve(json({ ...f.run, state: "working", canContinue: true })); await until(() => !opener.disabled);
  assert.equal(document.activeElement, opener);
  const next = button("Continue original analysis"); await click(next); nativeDisabledBlur(next);
  continuation.resolve(json(f.run)); await until(() => !next.isConnected);
  assert.equal(document.activeElement?.textContent, "Ask the account.");
});

test("automatic analysis follow-through never acquires a person's focus", async () => {
  const f = wrapUiFixture(), continuation = deferred<Response>(), originalTimer = window.setTimeout;
  let followThrough: (() => void) | undefined;
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 2800 && typeof handler === "function") { followThrough = () => handler(...args); return 987654; }
    return Reflect.apply(originalTimer, window, [handler, timeout, ...args]);
  }) as typeof window.setTimeout;
  try {
    await mount(f, call => call.path === "/api/wrap/assistant" && call.method === "POST" ? json({ ...f.run, state: "working", canContinue: true }) : call.path === `/api/wrap/assistant/${f.run.id}` ? continuation.promise : undefined);
    await click(tab("assistant")); await until(() => !button("Start scoped analysis").disabled);
    await click(button("Start scoped analysis")); await until(() => Boolean(followThrough));
    const otherControl = button("Read original record"); otherControl.focus();
    await act(async () => followThrough!()); assert.equal(otherControl.disabled, true); nativeDisabledBlur(otherControl);
    continuation.resolve(json(f.run)); await until(() => !otherControl.disabled);
    assert.equal(document.activeElement, document.body);
  } finally { window.setTimeout = originalTimer; }
});

test("saving a manual unapproved proposal restores its form submitter", async () => {
  const f = wrapUiFixture(), response = deferred<Response>();
  await mount(f, call => call.path === "/api/wrap" && call.method === "POST" ? response.promise : undefined);
  await click(button("Analyze up to 30 rows")); await until(() => !button("Start scoped analysis").disabled);
  await click(button("Write a proposal · 21 selected")); const opener = button("Save unapproved proposal"), form = opener.closest("form")!;
  await act(async () => { opener.focus(); form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: opener })); });
  nativeDisabledBlur(opener); response.resolve(json({ data: f.data })); await until(() => !opener.disabled);
  assert.equal(document.activeElement, opener);
  assert.equal((calls.find(call => call.method === "POST")!.body as { command: { type: string } }).command.type, "save_proposal");
});

test("pagination preserves middle controls and announces both disabled boundaries", async () => {
  const f = wrapUiFixture(41); await mount(f);
  await click(button("Hide grid")); const next = button("Next"), previous = button("Previous");
  await click(next); assert.equal(document.activeElement, next); assert.equal(next.disabled, false);
  await click(next); assert.equal(next.disabled, true); assert.match(document.activeElement!.textContent!, /Page 3 of 3.*41–41 of 41.*exports retain all 41 rows/);
  await click(previous); assert.equal(document.activeElement, previous); assert.equal(previous.disabled, false);
  await click(previous); assert.equal(previous.disabled, true); assert.match(document.activeElement!.textContent!, /Page 1 of 3.*1–20 of 41.*exports retain all 41 rows/);
});

test("the observed 21-row final page and reverse boundary retain a focusable status", async () => {
  await mount(wrapUiFixture()); await click(button("Hide grid")); await click(button("Next"));
  assert.match(document.activeElement!.textContent!, /Page 2 of 2.*21–21 of 21.*exports retain all 21 rows/);
  await click(button("Previous")); assert.match(document.activeElement!.textContent!, /Page 1 of 2.*1–20 of 21/);
});

test("Analyze and L1 navigation focus the destination tab and announce the exact source", async () => {
  const f = wrapUiFixture(); await mount(f); await click(button("Analyze up to 30 rows"));
  assert.equal(document.activeElement, tab("assistant")); assert.equal(tab("assistant").getAttribute("aria-selected"), "true");
  await until(() => !button("Start scoped analysis").disabled);
  const summary = [...container.querySelectorAll("summary")].find(value => value.textContent === "Analysis sources and retained identity")!; await click(summary);
  await click(button(`L1 · ${f.data.report.lines[0]!.label}`));
  assert.equal(document.activeElement, tab("account")); assert.equal(tab("account").getAttribute("aria-selected"), "true");
  assert.match(container.textContent!, new RegExp(`1 source row selected: ${f.data.report.lines[0]!.label}`));
  const selected = container.querySelector<HTMLInputElement>(`input[aria-label="Select ${f.data.report.lines[0]!.label}"]`)!; assert.equal(selected.checked, true);
});

test("all six tabs keep selection and keyboard focus aligned", async () => {
  await mount(wrapUiFixture()); await click(tab("account"));
  for (const [key, destination] of [["End", "assistant"], ["ArrowLeft", "reports"], ["ArrowLeft", "crew"], ["Home", "account"], ["ArrowRight", "entries"], ["ArrowRight", "invoices"]]) {
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    assert.equal(document.activeElement, tab(destination!)); assert.equal(tab(destination!).getAttribute("aria-selected"), "true");
  }
});
