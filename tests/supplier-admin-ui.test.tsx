/** Actual service DTOs and mounted interactions. Native geometry remains a separate root gate. */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { SupplierAdminDesk } from "../src/components/supplier-admin/manage-desk";
import { adminRecoveryKey, prepareAdminPending } from "../src/components/supplier-admin/recovery";
import { PRODUCTION_CHANGED_EVENT } from "../src/components/production-fetch";
import { supplierAdminHarness } from "./supplier-admin-harness";
const h = await supplierAdminHarness();
const routes = await import("../src/app/api/supplier-admin/route"), commands = await import("../src/app/api/supplier-admin/commands/route"), receipts = await import("../src/app/api/supplier-admin/commands/[id]/route");
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "http://127.0.0.1:4619/suppliers/manage", pretendToBeVisual: true });
for (const name of ["window", "self", "document", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "StorageEvent", "location", "history", "localStorage", "sessionStorage", "MutationObserver"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) }); Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
dom.window.HTMLElement.prototype.getClientRects = function () { return (this.isConnected && !this.closest("[hidden]") && getComputedStyle(this).display !== "none" ? [new dom.window.DOMRect(0, 0, 160, 44)] : []) as unknown as DOMRectList; };
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); this.querySelector<HTMLElement>("button:not([disabled]),input:not([disabled])")?.focus(); }; dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
const style = document.createElement("style"); style.textContent = readFileSync("src/app/suppliers/manage/supplier-admin.css", "utf8"); document.head.append(style);
const { createRoot } = await import("react-dom/client"), originalFetch = globalThis.fetch, originalSet = dom.window.Storage.prototype.setItem;
let root: Root | null = null, container: HTMLDivElement, calls: { path: string; method: string }[] = [];
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
async function until(check: () => boolean) { for (let i = 0; i < 150 && !check(); i++) await flush(); assert.ok(check(), "Supplier administration UI did not settle"); }
function button(label: string, within: ParentNode = container) { const item = [...within.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent?.trim() === label || value.getAttribute("aria-label") === label); assert.ok(item, "Missing control: " + label); return item; }
function field(label: string) { const value = [...container.querySelectorAll<HTMLLabelElement>("label")].find(value => value.textContent?.trim().startsWith(label))?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select"); assert.ok(value, "Missing field: " + label); return value; }
async function click(element: HTMLElement) { await act(async () => { element.focus(); element.click(); }); }
async function fill(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) { await act(async () => { const prototype = element instanceof HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); }); }
const posts = () => calls.filter(value => value.method === "POST");
async function mount(token: string, owner = false, loseResponse = false) {
  calls = []; container = document.createElement("div"); document.body.append(container);
  globalThis.fetch = async (input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname, method = init?.method ?? "GET"; calls.push({ path, method });
    const headers = new Headers(init?.headers); headers.set("Authorization", "Bearer " + token); if (method === "POST") headers.set("Origin", "http://127.0.0.1:4619");
    const request = new Request("http://127.0.0.1:4619" + path, { ...init, method, headers });
    if (path === "/api/supplier-admin") return routes.GET(request);
    if (path === "/api/supplier-admin/commands") { const response = await commands.POST(request); if (loseResponse) { loseResponse = false; throw new TypeError("Controlled lost answer after actual command commit"); } return response; }
    if (path.startsWith("/api/supplier-admin/commands/")) return receipts.GET(request, { params: Promise.resolve({ id: path.split("/").at(-1)! }) });
    throw new Error("Unexpected controlled UI transport");
  };
  root = createRoot(container); await act(async () => root!.render(<SupplierAdminDesk ownerMode={owner} />)); await until(() => Boolean(container.querySelector(".sa-access")));
}
async function unmount() { if (root) { await act(async () => root!.unmount()); root = null; } document.body.replaceChildren(); }
afterEach(async () => { dom.window.Storage.prototype.setItem = originalSet; await unmount(); localStorage.clear(); sessionStorage.clear(); globalThis.fetch = originalFetch; });
after(async () => { await h.close(); dom.window.close(); });

test("producer desk reads actual supplier sources and keeps actual checkout explicitly unavailable", async () => {
  const p = await h.initial(); await h.admitted(p.authority); await mount(p.token);
  assert.match(container.textContent!, /Actual checkout unavailable/); assert.match(container.textContent!, /Three original services retained/); assert.match(container.textContent!, /Brightline Rentals/); assert.equal(posts().length, 0);
  assert.equal(button("Admit a supplier").disabled, false); assert.equal(getComputedStyle(button("Admit a supplier")).minHeight, "44px");
});

test("supplier desk uses only its own service DTO and does not expose producer admission or RFQ actions", async () => {
  const p = await h.initial(), first = await h.admitted(p.authority); await h.admitted(p.authority); await mount(first.token, true);
  assert.equal(container.querySelectorAll(".sa-catalog>button").length, 1); assert.equal([...container.querySelectorAll("button")].some(value => value.textContent?.includes("Admit a supplier")), false); assert.doesNotMatch(container.textContent!, /Three original services retained/); assert.equal(posts().length, 0);
});

test("new inventory review starts with unknown evidence and explicit consent, with keyboard focus containment", async () => {
  const p = await h.initial(), owner = await h.admitted(p.authority); await mount(owner.token, true); const trigger = button("Add an owned unit"); await click(trigger);
  const dialog = container.querySelector<HTMLDialogElement>("dialog[open]")!; assert.ok(dialog); assert.equal((field("Qualified driver evidence") as HTMLSelectElement).value, "unknown"); assert.equal((field("Condition evidence") as HTMLSelectElement).value, "unknown"); assert.equal(button("Confirm exact instruction").disabled, true);
  const first = dialog.querySelector<HTMLButtonElement>("button")!, last = button("Keep reviewing", dialog); await act(async () => { last.focus(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); }); assert.equal(document.activeElement, first);
  await act(async () => dialog.dispatchEvent(new Event("cancel", { bubbles: false, cancelable: true }))); assert.equal(container.querySelector("dialog[open]"), null); assert.equal(document.activeElement, trigger); assert.equal(posts().length, 0);
});

test("reload reads a real missing command before exact retry and never auto-dispatches retained instructions", async () => {
  const p = await h.initial(), state = await h.admin.readSupplierAdminWorkspace(p.authority), envelope = h.envelope(state, { type: "invite", name: "Retained controlled owner", reference: "Retained current source review", detail: "Original reviewed producer instruction retained before any POST was attempted.", reviewDigest: state.reviewDigest, confirmed: true }), saved = await prepareAdminPending(state, envelope);
  localStorage.setItem(adminRecoveryKey(saved), JSON.stringify(saved)); await mount(p.token); await until(() => Boolean(container.textContent?.includes("no server receipt")));
  assert.equal(posts().length, 0); assert.equal(button("Admit a supplier").disabled, true); await click(button("Retry exact saved instruction")); await until(() => Boolean(container.textContent?.includes("Separate supplier access is ready")));
  assert.equal(posts().length, 1); assert.equal(localStorage.getItem(adminRecoveryKey(saved)), null); assert.ok(calls.findIndex(value => value.path.endsWith(envelope.commandId)) < calls.findIndex(value => value.method === "POST"));
});

async function reviewInvitation() {
  await click(button("Admit a supplier")); await fill(field("Supplier name"), "Mounted controlled supplier"); await fill(field("Source reference"), "Mounted current source reference"); await fill(field("Attribution and review detail"), "Producer reviews this actual controlled admission instruction. No real company, message or identity verification claimed.");
  const confirm = container.querySelector<HTMLInputElement>(".sa-confirm input")!; await click(confirm);
}
test("actual committed response loss recovers the original receipt and never stores a capability in browser recovery", async () => {
  const p = await h.initial(); await mount(p.token, false, true); await reviewInvitation(); await click(button("Confirm exact instruction")); await until(() => Boolean(container.textContent?.includes("Separate supplier access is ready")));
  assert.equal(posts().length, 1); assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_supplier_admin_commands WHERE tenant_id=$1", [p.actor.tenantId])).rows[0].count), 1);
  assert.equal(localStorage.length, 0); assert.equal(sessionStorage.length, 0); assert.doesNotMatch(container.textContent!, new RegExp(p.token));
});

test("failed browser storage keeps the review open and sends no instruction", async () => {
  const p = await h.initial(); await mount(p.token); await reviewInvitation(); dom.window.Storage.prototype.setItem = () => { throw new Error("Controlled storage refusal"); };
  await click(button("Confirm exact instruction")); await until(() => Boolean(container.textContent?.includes("Controlled storage refusal"))); assert.ok(container.querySelector("dialog[open]")); assert.equal(posts().length, 0);
});

test("production access changes disable new instructions and preserve an original pending file", async () => {
  const p = await h.initial(), state = await h.admin.readSupplierAdminWorkspace(p.authority), saved = await prepareAdminPending(state, h.envelope(state, { type: "invite", name: "Retained changed-access owner", reference: "Controlled access-change source", detail: "This original instruction stays with its original production after an access change.", reviewDigest: state.reviewDigest, confirmed: true }));
  localStorage.setItem(adminRecoveryKey(saved), JSON.stringify(saved)); await mount(p.token); await until(() => Boolean(container.querySelector(".sa-pending")));
  await act(async () => window.dispatchEvent(new Event(PRODUCTION_CHANGED_EVENT))); assert.equal(button("Admit a supplier").disabled, true); assert.ok(localStorage.getItem(adminRecoveryKey(saved))); assert.equal(posts().length, 0);
});
