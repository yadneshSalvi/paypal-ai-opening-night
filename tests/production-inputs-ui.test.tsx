import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { InputDesk } from "../src/components/production-inputs/input-desk";
import { useInputs } from "../src/components/production-inputs/use-inputs";
import { inputRecoveryKey, prepareInput } from "../src/components/production-inputs/recovery";
import { inputUiFixture, uiInputReceipt, uiSourceCommand } from "./production-inputs-ui-fixtures";
import type { InputCommandResult, InputEnvelope, InputWorkspace } from "../src/domain/production-inputs/contracts";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:4615/inputs", pretendToBeVisual: true });
for (const key of ["window", "self", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "StorageEvent", "location", "history", "localStorage", "sessionStorage", "MutationObserver"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const { createRoot } = await import("react-dom/client"), originalFetch = globalThis.fetch, originalSet = dom.window.Storage.prototype.setItem;
let root: Root | null = null, container: HTMLDivElement, calls: { path: string; method: string; body: InputEnvelope | null }[] = [];
const button = (label: string) => { const value = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label); assert.ok(value, "Missing button: " + label); return value; };
const field = (label: string) => { const value = [...container.querySelectorAll<HTMLLabelElement>("label")].find(item => item.textContent?.trim().startsWith(label))?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select"); assert.ok(value, "Missing field: " + label); return value; };
const posts = () => calls.filter(call => call.method === "POST");
async function settle(check: () => boolean) { for (let i = 0; i < 150 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); assert.ok(check(), "Input UI did not settle"); }
async function click(element: HTMLElement) { await act(async () => { element.focus(); element.click(); }); }
async function fill(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) { await act(async () => { const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); }); }
type Route = (call: typeof calls[number]) => Response | Promise<Response> | undefined;
async function mount(node: ReactNode, workspace: InputWorkspace, route?: Route) { calls = []; container = document.createElement("div"); document.body.append(container); globalThis.fetch = async (input, init) => { const call = { path: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as InputEnvelope : null }; calls.push(call); const value = route?.(call); if (value) return value; if (call.method === "GET" && call.path === "/api/production-inputs") return Response.json(workspace); throw new Error("Unexpected controlled UI request"); }; root = createRoot(container); await act(async () => { root!.render(node); }); }
function Harness() { const client = useInputs(); return <main><span data-busy={client.busy} /><p>{client.error}</p>{client.receipt && <p>Original receipt confirmed</p>}<button disabled={client.locked || !client.view} onClick={() => void client.send(uiSourceCommand())}>Save controlled source</button><button disabled={client.busy || client.ended} onClick={() => void client.refresh()}>Check original result</button>{client.missing && <button disabled={client.busy || client.ended} onClick={() => void client.retry()}>Retry exact instruction</button>}</main>; }
afterEach(async () => { dom.window.Storage.prototype.setItem = originalSet; if (root) await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); sessionStorage.clear(); localStorage.clear(); globalThis.fetch = originalFetch; });
after(() => dom.window.close());
test("the real inputs desk exposes quoted source data and requires three separate producer confirmations", async () => {
  const view = inputUiFixture(true); await mount(<InputDesk />, view, call => call.method === "POST" ? Response.json(uiInputReceipt(call.body!)) : undefined);
  await settle(() => Boolean(container.querySelector(".inputs-separate-approval")));
  assert.equal(container.querySelectorAll("script").length, 0); assert.match(container.textContent!, /not an instruction/); assert.match(container.textContent!, /Schedule requires replanning/);
  assert.equal(button("Admit these reviewed inputs").disabled, true); assert.equal(posts().length, 0);
  await click(field("I reviewed these exact source versions")); await click(field("I declare authority")); assert.equal(button("Admit these reviewed inputs").disabled, true);
  await click(field("I accept every displayed scheduling blocker")); assert.equal(button("Admit these reviewed inputs").disabled, false);
  await click(button("Admit these reviewed inputs")); await settle(() => Boolean(container.querySelector(".inputs-confirmed")));
  assert.equal(posts().length, 1); assert.equal(posts()[0]!.body!.command.type, "approve");
  for (const input of container.querySelectorAll("input,textarea,select")) assert.ok(input.closest("label"), "Every editable field has a native label");
});
test("the source-cited availability form emits venue-zone instants without admitting them", async () => {
  const view = inputUiFixture(); await mount(<InputDesk />, view, call => call.method === "POST" ? Response.json(uiInputReceipt(call.body!)) : undefined);
  await settle(() => Boolean(container.querySelector(".inputs-compose form")));
  await fill(field("Available until"), "2026-11-14T18:00"); await fill(field("Proposal title"), "A controlled availability change"); await fill(field("Why these inputs should change"), "The supplied fictional source changes this planning window; no actual availability is claimed.");
  assert.equal(button("Save source-cited proposal").disabled, true); await click(field("I inspected this exact source")); await click(button("Save source-cited proposal"));
  await settle(() => posts().length === 1 && Boolean(container.querySelector(".inputs-confirmed")));
  const command = posts()[0]!.body!.command; assert.equal(command.type, "propose"); if (command.type !== "propose") return;
  const change = command.draft.roster[0]!; assert.equal(change.kind, "update"); if (change.kind !== "update") return;
  assert.equal(change.changes.availability!.value.until, "2026-11-15T00:00:00Z"); assert.equal(change.changes.availability!.citations[0]!.sourceId, view.sources[0]!.id); assert.equal(view.currentInput, null);
});
test("a lost committed response recovers by original GET with no second POST", async () => {
  const view = inputUiFixture(); let saved: InputCommandResult | null = null, held = true;
  await mount(<Harness />, view, call => call.method === "POST" ? (async () => { assert.ok(sessionStorage.getItem(inputRecoveryKey(view.scope))); saved = uiInputReceipt(call.body!); throw new TypeError("Controlled response loss after commit"); })() : call.path.includes("?commandId=") ? held ? Response.json({ code: "SERVICE_UNAVAILABLE", error: "Original receipt held" }, { status: 503 }) : Response.json(saved) : undefined);
  await settle(() => container.querySelector('[data-busy="false"]') !== null); await click(button("Save controlled source")); await settle(() => container.textContent!.includes("Original receipt held") && container.querySelector('[data-busy="false"]') !== null);
  assert.equal(posts().length, 1); assert.equal(button("Save controlled source").disabled, true); held = false; await click(button("Check original result")); await settle(() => container.textContent!.includes("Original receipt confirmed"));
  assert.equal(posts().length, 1); assert.equal(sessionStorage.getItem(inputRecoveryKey(view.scope)), null);
});
test("proven missing receipt enables only manual retry of the same bytes and identity", async () => {
  const view = inputUiFixture(); let first = true;
  await mount(<Harness />, view, call => call.path.includes("?commandId=") ? Response.json({ code: "INPUT_COMMAND_NOT_FOUND", error: "No original receipt" }, { status: 404 }) : call.method === "POST" ? first ? (first = false, Promise.reject(new TypeError("Controlled loss before dispatch"))) : Response.json(uiInputReceipt(call.body!)) : undefined);
  await settle(() => container.querySelector('[data-busy="false"]') !== null); await click(button("Save controlled source")); await settle(() => Boolean(container.textContent!.includes("Retry exact instruction") && container.querySelector('[data-busy="false"]')));
  const original = structuredClone(posts()[0]!.body); await click(button("Retry exact instruction")); await settle(() => container.textContent!.includes("Original receipt confirmed")); assert.equal(posts().length, 2); assert.deepEqual(posts()[1]!.body, original);
});
test("same-token expiry change stops a retained instruction without transferring it", async () => {
  let view = inputUiFixture(); const original = view, pending = await prepareInput(view.scope, { version: 1, commandId: crypto.randomUUID(), scope: view.scope, expectedRevision: view.revision, inputRevision: view.inputRevision, command: uiSourceCommand() }); sessionStorage.setItem(inputRecoveryKey(view.scope), JSON.stringify(pending));
  await mount(<Harness />, view, call => call.path.includes("?commandId=") ? Response.json({ code: "SERVICE_UNAVAILABLE", error: "Held original" }, { status: 503 }) : call.path === "/api/production-inputs" ? Response.json(view) : undefined);
  await settle(() => container.querySelector('[data-busy="false"]') !== null); view = { ...view, scope: { ...view.scope, sessionExpiresAt: view.scope.sessionExpiresAt.replace("000Z", "001Z"), sessionFingerprint: "f".repeat(64) } };
  await click(button("Check original result")); await settle(() => container.textContent!.includes("Different producer access or fixed expiry")); assert.equal(posts().length, 0); assert.equal(button("Save controlled source").disabled, true); assert.equal(sessionStorage.getItem(inputRecoveryKey(original.scope)), JSON.stringify(pending));
});
test("corrupt storage preserves the original bytes and blocks new dispatch", async () => {
  const view = inputUiFixture(), key = inputRecoveryKey(view.scope), corrupt = '{"retained":"incomplete"'; sessionStorage.setItem(key, corrupt); await mount(<Harness />, view); await settle(() => container.querySelector('[data-busy="false"]') !== null); assert.equal(button("Save controlled source").disabled, true); assert.equal(posts().length, 0); assert.equal(sessionStorage.getItem(key), corrupt);
});
