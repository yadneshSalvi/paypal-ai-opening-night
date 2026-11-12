/** Mounted React → actual route handlers → fresh owned PG → installed SDK controlled transport.
 * Only CSS loading and explicit transport-corruption cases are adapted. This is not native layout proof. */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { act, useRef, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { audienceHarness } from "./audience-harness";
import { ProducerAudience } from "../src/components/audience/producer";
import { AttendeeAccess, ATTENDEE_STORAGE } from "../src/components/audience/attendee";
import { AudienceStatus } from "../src/components/audience/shared";
import { useAudience } from "../src/components/audience/use-audience";
import { audienceRecoveryKey } from "../src/components/audience/recovery";
import { PRODUCTION_CHANGED_EVENT } from "../src/components/production-fetch";
const h = await audienceHarness();
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:4594/audience", pretendToBeVisual: true });
for (const name of ["window", "self", "document", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "StorageEvent", "location", "history", "localStorage", "sessionStorage", "MutationObserver"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) }); Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
dom.window.HTMLElement.prototype.getClientRects = function () { return (this.isConnected && !this.closest("[hidden]") && getComputedStyle(this).display !== "none" ? [new dom.window.DOMRect(0, 0, 150, 44)] : []) as unknown as DOMRectList; };
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); this.querySelector<HTMLElement>("[autofocus],button:not([disabled]),input:not([disabled])")?.focus(); };
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
dom.window.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(this.download); };
const { createRoot } = await import("react-dom/client"), originalFetch = globalThis.fetch, originalSet = dom.window.Storage.prototype.setItem, originalRemove = dom.window.Storage.prototype.removeItem;
type Value = Awaited<ReturnType<typeof h.fresh>>;
type Call = { path: string; method: string; headers: Headers; body: any; credentials: RequestCredentials | undefined };
type Override = (call: Call, forward: () => Promise<Response>) => Response | Promise<Response> | undefined;
let root: Root | null = null, container: HTMLDivElement, calls: Call[] = [], downloads: string[] = [];
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const button = (text: string, within: ParentNode = container) => { const value = [...within.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text || item.getAttribute("aria-label") === text); assert.ok(value, "Missing button: " + text); return value; };
const field = (label: string, within: ParentNode = container) => { const found = [...within.querySelectorAll<HTMLLabelElement>("label")].find(item => item.textContent?.trim().startsWith(label)); assert.ok(found, "Missing field: " + label); const value = found.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select") ?? (found.htmlFor ? document.getElementById(found.htmlFor) as HTMLInputElement : null); assert.ok(value); return value; };
const dialogs = () => [...container.querySelectorAll<HTMLDialogElement>("dialog[open]")], posts = () => calls.filter(call => call.method === "POST");
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 8)); }); }
async function until(check: () => boolean) { for (let index = 0; index < 180 && !check(); index++) await flush(); assert.ok(check(), "Audience mounted state did not settle"); }
async function click(value: HTMLElement) { await act(async () => { value.focus(); value.click(); }); }
async function fill(value: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, text: string) { await act(async () => { const prototype = value instanceof HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : value instanceof HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(value, text); value.dispatchEvent(new Event(value instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); }); }
function Harness({ value }: { value: Value }) {
  const heading = useRef<HTMLHeadingElement>(null), client = useAudience(value.actor.tenantId, () => heading.current);
  return <div><h1 ref={heading} tabIndex={-1}>Original audience workspace</h1><p>{client.data ? "Workspace ready" : "No private workspace"}</p><AudienceStatus client={client} /><button disabled={client.blocked || !client.data?.tickets[0]} onClick={event => client.data && void client.submit({ type: "create_invite", ticketId: client.data.tickets[0]!.ticketId, receiptDigest: client.data.tickets[0]!.originalDigest, validForMinutes: 60, confirmed: true }, client.data.revision, event.currentTarget)}>Save one original invite</button><button disabled={Boolean(client.busy || client.ended)} onClick={event => void client.refresh(event.currentTarget)}>Refresh facts</button><input aria-label="Unrelated producer note" /><span data-busy={client.busy ?? ""} data-ended={String(client.ended)} data-fresh={String(client.fresh)} /></div>;
}
async function bridge(value: Value, override?: Override) {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://127.0.0.1:4594");
    if (url.origin !== "http://127.0.0.1:4594") throw new Error("Unowned target denied by audience UI fixture");
    const call: Call = { path: url.pathname + url.search, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : null, credentials: init.credentials }; calls.push(call);
    const forward = async () => {
      const headers = new Headers(call.headers); if (!url.pathname.startsWith("/api/attendee")) headers.set("authorization", "Bearer " + value.token); if (call.method === "POST") headers.set("origin", url.origin);
      const request = new Request(url, { method: call.method, headers, ...(init.body ? { body: init.body } : {}) });
      if (url.pathname === "/api/audience") return h.route.GET(request);
      if (url.pathname === "/api/attendee") return h.attendeeRoute.GET(request);
      if (url.pathname === "/api/audience/commands") return h.commandRoute.POST(request);
      if (url.pathname === "/api/audience/work") return h.workRoute.POST(request);
      const id = url.pathname.split("/").at(-1)!;
      if (url.pathname.startsWith("/api/audience/commands/")) return h.commandRead.GET(request, { params: Promise.resolve({ id }) });
      if (url.pathname.startsWith("/api/audience/messages/")) return h.messageRoute.GET(request, { params: Promise.resolve({ id }) });
      if (url.pathname.startsWith("/api/audience/invites/")) return h.invitationRoute.GET(request, { params: Promise.resolve({ id }) });
      throw new Error("Unowned audience UI route");
    };
    return override?.(call, forward) ?? forward();
  };
}
async function mount(value: Value, override?: Override, node?: ReactNode, url = "/audience") {
  history.replaceState({}, "", url); calls = []; downloads = []; container = document.createElement("div"); document.body.append(container); await bridge(value, override);
  root = createRoot(container); await act(async () => root!.render(node ?? <ProducerAudience tenantId={value.actor.tenantId} />));
}
async function ready() { await until(() => Boolean(container.textContent?.includes("Private attendee access.") && !button("Refresh current sources").disabled)); }
async function harness(value: Value, override?: Override) { await mount(value, override, <Harness value={value} />); await until(() => Boolean(container.textContent?.includes("Workspace ready") && container.querySelector('[data-busy=""]'))); }
async function unmount() { if (root) { await act(async () => root!.unmount()); root = null; } document.body.replaceChildren(); }
afterEach(async context => { writeFileSync(`.artifacts/audience-stage17/ui-state-${Date.now()}-${context.name.replaceAll(/[^a-z0-9]+/gi, "-").slice(0, 70)}.json`, JSON.stringify({ test: context.name, text: container?.textContent, calls: calls.map(call => ({ path: call.path, method: call.method, body: call.body })), journals: Object.keys(localStorage).filter(key => key.startsWith("opening-night:audience:")).map(key => ({ key, raw: localStorage.getItem(key) })) }, null, 2), { mode: 0o600 }); await unmount(); localStorage.clear(); sessionStorage.clear(); history.replaceState({}, "", "/audience"); globalThis.fetch = originalFetch; dom.window.Storage.prototype.setItem = originalSet; dom.window.Storage.prototype.removeItem = originalRemove; });
after(async () => { dom.window.close(); await h.close(); });

test("committed response loss retains exact bytes across remount and GET recovery never automatically resends", async () => {
  const value = await h.fresh(); await h.capture(value); let original: unknown = null;
  await harness(value, async (call, forward) => { if (call.path === "/api/audience/commands") { original = call.body; assert.ok(localStorage.getItem(audienceRecoveryKey(await h.audience.readAudienceWorkspace(value.authority)))); await forward(); throw new TypeError("Controlled response loss after real commit"); } return forward(); });
  await click(button("Save one original invite")); await until(() => Boolean(container.querySelector('[aria-label="Original audience instruction recovery"]') && !container.querySelector('[data-busy="create_invite"]'))); assert.equal(posts().length, 1);
  const state = await h.audience.readAudienceWorkspace(value.authority), bytes = localStorage.getItem(audienceRecoveryKey(state)); assert.ok(bytes); assert.deepEqual(JSON.parse(bytes).envelope, original);
  await unmount(); await harness(value); assert.equal(posts().length, 0); await click(button("Check original result")); await until(() => !container.querySelector('[aria-label="Original audience instruction recovery"]'));
  assert.equal(posts().length, 0); assert.equal(localStorage.getItem(audienceRecoveryKey(state)), null); assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_capabilities WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 1);
});

test("only exact absent command receipt permits explicit retry with the identical original request", async () => {
  const value = await h.fresh(); await h.capture(value); let first = true, original: unknown;
  await harness(value, (call, forward) => { if (call.path === "/api/audience/commands" && first) { first = false; original = call.body; throw new TypeError("Controlled request did not reach handler"); } return forward(); });
  await click(button("Save one original invite")); await until(() => Boolean(container.querySelector('[aria-label="Original audience instruction recovery"]') && !container.querySelector('[data-busy="create_invite"]')));
  assert.equal(button("Retry the same instruction").disabled, true); await click(button("Check original result")); await until(() => !button("Retry the same instruction").disabled); assert.equal(posts().length, 1);
  await click(button("Retry the same instruction")); await until(() => !container.querySelector('[aria-label="Original audience instruction recovery"]')); assert.equal(posts().length, 2); assert.deepEqual(posts()[1]!.body, original);
});

test("storage refusal dispatches nothing and a foreign workspace cannot adopt the original recovery file", async () => {
  const value = await h.fresh(); await h.capture(value); await harness(value); dom.window.Storage.prototype.setItem = function () { throw new Error("Controlled storage refusal"); };
  await click(button("Save one original invite")); await until(() => Boolean(container.textContent?.includes("Instructions are paused"))); assert.equal(posts().length, 0); assert.ok(button("Save original recovery file"));
  dom.window.Storage.prototype.setItem = originalSet; await unmount(); await harness(value, async (call, forward) => { if (call.path === "/api/audience/commands") { await forward(); throw new TypeError("Controlled committed reply loss"); } return forward(); }); await click(button("Save one original invite")); await until(() => Boolean(container.querySelector('[aria-label="Original audience instruction recovery"]') && !container.querySelector('[data-busy="create_invite"]')));
  const state = await h.audience.readAudienceWorkspace(value.authority), key = audienceRecoveryKey(state), saved = localStorage.getItem(key); assert.ok(saved);
  const foreign = await h.fresh(); await unmount(); await harness(foreign); assert.equal(container.querySelector('[aria-label="Original audience instruction recovery"]'), null); assert.equal(localStorage.getItem(key), saved); assert.equal(posts().length, 0);
});

test("a production switch clears private data, closes consent, ignores a late saved result and preserves original recovery", async () => {
  const value = await h.fresh(); await h.capture(value); const held = deferred<Response>(); let accepted: Response | null = null;
  await harness(value, async (call, forward) => { if (call.path === "/api/audience/commands") { accepted = await forward(); return held.promise; } return forward(); }); await click(button("Save one original invite")); await until(() => Boolean(accepted));
  const state = await h.audience.readAudienceWorkspace(value.authority), bytes = localStorage.getItem(audienceRecoveryKey(state)); assert.ok(bytes);
  await act(async () => window.dispatchEvent(new Event(PRODUCTION_CHANGED_EVENT))); await act(async () => held.resolve(accepted!)); await flush();
  assert.equal(container.querySelector('[data-ended="true"]')?.getAttribute("data-ended"), "true"); assert.match(container.textContent!, /No private workspace/); assert.equal(container.textContent?.includes("Reviewed instruction saved"), false); assert.equal(localStorage.getItem(audienceRecoveryKey(state)), bytes); assert.equal(posts().length, 1);
});

test("loading and empty producer views create no session, capture, invitation, draft or delivery", async () => {
  const value = await h.fresh(), pending = deferred<Response>();
  await mount(value, call => call.path === "/api/audience" ? pending.promise : undefined);
  assert.match(container.textContent!, /Reading the original audience sources/); assert.equal(posts().length, 0);
  await act(async () => pending.resolve(Response.json(await h.audience.readAudienceWorkspace(value.authority)))); await ready();
  assert.match(container.textContent!, /No verified ticket receipts yet/); assert.match(container.textContent!, /No audience updates saved/); assert.equal(button("Draft an audience update").disabled, true); assert.equal(posts().length, 0);
});

test("mounted invite review needs explicit consent, contains keyboard focus, and returns focus to its actual opener", async () => {
  const value = await h.fresh(); await h.capture(value); await mount(value); await ready(); const opener = button("Review private invite"); await click(opener); const dialog = dialogs()[0]!;
  assert.equal(button("Save private invitation", dialog).disabled, true); assert.equal(posts().length, 0);
  await click(field("I reviewed this exact ticket", dialog)); assert.equal(button("Save private invitation", dialog).disabled, false);
  const last = button("Save private invitation", dialog), first = button("Close dialog", dialog);
  await act(async () => { last.focus(); last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); }); assert.equal(document.activeElement, first);
  await act(async () => { first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); }); assert.equal(document.activeElement, last);
  await click(button("Keep reviewing", dialog)); await until(() => dialogs().length === 0); assert.equal(document.activeElement, opener); assert.equal(posts().length, 0);
});

test("mounted producer flow saves exact content, separately approves, and delivers individual controlled inbox receipts", async () => {
  const value = await h.fresh(), a = await h.capture(value, "standard"), b = await h.capture(value); await h.invite(value, a.ticket.id); await h.invite(value, b.ticket.id);
  await mount(value); await ready(); await click(button("Draft an audience update")); let dialog = dialogs()[0]!;
  assert.equal(button("Save exact draft", dialog).disabled, true); await click(button("Select 2 shown inboxes", dialog)); await fill(field("Producer note", dialog), "Reviewed controlled update. No external email or physical entry is claimed."); await click(button("Save exact draft", dialog));
  await until(() => Boolean(container.textContent?.includes("Review the saved draft.") && !button("Refresh current sources").disabled));
  assert.match(container.textContent!, /Not approved/); assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_deliveries WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 0);
  await click(button("Review separate approval")); dialog = dialogs()[0]!; assert.equal(button("Approve exact controlled update", dialog).disabled, true); await click(field("I reviewed the exact messages", dialog)); await click(button("Approve exact controlled update", dialog));
  await until(() => Boolean(container.textContent?.includes("The approved update.") && !button("Refresh current sources").disabled));
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_deliveries WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 0);
  await click(button("Review next delivery pass")); dialog = dialogs()[0]!; assert.equal(button("Deliver reviewed pass", dialog).disabled, true); await click(field("Deliver this exact approved snapshot", dialog)); await click(button("Deliver reviewed pass", dialog));
  await until(() => Boolean(container.textContent?.includes("Every approved inbox has its immutable receipt.") && !button("Refresh current sources").disabled));
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_deliveries WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 2);
  const workAt = calls.findIndex(call => call.path === "/api/audience/work"); assert.ok(workAt > 0); assert.ok(calls.slice(0, workAt).some(call => call.method === "GET" && call.path.startsWith("/api/audience/commands/")));
  assert.ok(calls.every(call => !call.path.includes("/api/payments") && !call.path.includes("/api/session")));
});

test("a never-received retained instruction cannot be adopted after a same-token fixed-expiry change", async () => {
  const value = await h.fresh(); await h.capture(value);
  await harness(value, call => { if (call.path === "/api/audience/commands") throw new TypeError("Controlled pre-dispatch loss"); return undefined; });
  await click(button("Save one original invite")); await until(() => Boolean(container.querySelector('[aria-label="Original audience instruction recovery"]') && !container.querySelector('[data-busy="create_invite"]')));
  const original = await h.audience.readAudienceWorkspace(value.authority), key = audienceRecoveryKey(original), raw = localStorage.getItem(key); assert.ok(raw);
  assert.equal(JSON.parse(raw).expiresAt, original.expiresAt); assert.equal(JSON.parse(raw).envelope.sessionExpiresAt, original.expiresAt);
  await h.database.pool.query("UPDATE on_sessions SET expires_at=expires_at-interval '1 microsecond' WHERE token_hash=$1", [value.authority.sessionHash]);
  await unmount(); await harness(value);
  assert.match(container.textContent!, /different exact producer access or its fixed expiry/); assert.equal(button("Save one original invite").disabled, true); assert.equal(posts().length, 0); assert.equal(localStorage.getItem(key), raw);
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_capabilities WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 0);
});

test("a capability switch before first dispatch cannot adopt a review with the same actor and fixed expiry", async () => {
  const value = await h.fresh(); await h.capture(value); await harness(value); const original = await h.audience.readAudienceWorkspace(value.authority), sibling = await h.sibling(value);
  await bridge(sibling); await click(button("Save one original invite")); await until(() => Boolean(container.querySelector('[data-ended="true"]')));
  assert.equal(container.textContent!.includes("Workspace ready"), false); assert.equal(posts().length, 1); assert.equal(posts()[0]!.body.sessionFingerprint, original.sessionFingerprint);
  assert.ok(localStorage.getItem(audienceRecoveryKey(original))); assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_commands WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 0); assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_capabilities WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 0);
});

test("an unreadable denied producer GET clears private sources and scoped consent immediately", async () => {
  const value = await h.fresh(); await h.capture(value); let deny = false;
  await mount(value, (call, forward) => deny && call.path === "/api/audience" ? new Response("Unreadable denied response", { status: 401 }) : forward()); await ready();
  await click(button("Review private invite")); assert.equal(dialogs().length, 1); deny = true;
  await act(async () => { window.dispatchEvent(new Event("online")); });
  await until(() => Boolean(container.textContent?.includes("This exact producer access is closed.")));
  assert.equal(dialogs().length, 0); assert.equal(container.querySelector('[aria-labelledby="audience-tickets-title"]'), null); assert.equal(container.querySelector('[aria-label="Original private invitation ready"]'), null); assert.equal(posts().length, 0);
});

test("a corrupted exact producer preview retains the dated verified draft and disables approval", async () => {
  const value = await h.fresh(), original = await h.capture(value), link = await h.invite(value, original.ticket.id), draft = await h.draft(value, [link.capabilityId]); let corrupt = false;
  await mount(value, async (call, forward) => { const response = await forward(); if (!corrupt || call.path !== "/api/audience/messages/" + draft.draft.id) return response; const body = await response.json(); body.draft.recipients[0].content.body += "CORRUPTED-UNREVIEWED-CONTENT"; return Response.json(body); }, undefined, "/audience?message=" + draft.draft.id);
  await until(() => Boolean(container.textContent?.includes("Review the saved draft.") && !button("Refresh current sources").disabled));
  const previous = container.querySelector('[aria-label="Exact recipient message"]')!.textContent; corrupt = true;
  await click(button("Refresh exact preview")); await until(() => Boolean(container.textContent?.includes("snapshot hash failed verification")));
  assert.equal(container.querySelector('[aria-label="Exact recipient message"]')!.textContent, previous); assert.equal(container.textContent!.includes("CORRUPTED-UNREVIEWED-CONTENT"), false); assert.match(container.textContent!, /Last verified observation/); assert.ok(container.querySelector('[role="alert"] time[datetime]')); assert.equal(button("Review separate approval").disabled, true); assert.equal(posts().length, 0);
});

test("lost work response is not delivery success; remount and original GET recover saved individual receipts without resending", async () => {
  const value = await h.fresh(), first = await h.capture(value), second = await h.capture(value), a = await h.invite(value, first.ticket.id), b = await h.invite(value, second.ticket.id), draft = await h.draft(value, [a.capabilityId, b.capabilityId]); await h.approve(value, draft.draft.id);
  await mount(value, async (call, forward) => { const response = await forward(); if (call.path === "/api/audience/work") throw new TypeError("Controlled lost reply after per-recipient commits"); return response; }, undefined, "/audience?message=" + draft.draft.id);
  await until(() => Boolean(container.textContent?.includes("The approved update.") && !button("Refresh current sources").disabled));
  await click(button("Review next delivery pass")); const dialog = dialogs()[0]!; await click(field("Deliver this exact approved snapshot", dialog)); await click(button("Deliver reviewed pass", dialog));
  await until(() => Boolean(container.querySelector('[aria-label="Original audience instruction recovery"]') && !button("Refresh current sources").disabled));
  assert.match(container.textContent!, /missing response is not success/); assert.equal(container.textContent!.includes("Every approved inbox has its immutable receipt."), false);
  const workspace = await h.audience.readAudienceWorkspace(value.authority), raw = localStorage.getItem(audienceRecoveryKey(workspace)); assert.ok(raw); assert.equal(JSON.parse(raw).kind, "work"); assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_deliveries WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 2);
  const url = location.pathname + location.search; await unmount(); await mount(value, undefined, undefined, url);
  await until(() => Boolean(container.querySelector('[aria-label="Original audience instruction recovery"]') && !button("Refresh current sources").disabled)); assert.equal(posts().length, 0); assert.equal([...container.querySelectorAll("button")].some(item => item.textContent === "Retry the same instruction"), false);
  await click(button("Check original result")); await until(() => !container.querySelector('[aria-label="Original audience instruction recovery"]')); assert.equal(posts().length, 0); assert.equal(localStorage.getItem(audienceRecoveryKey(workspace)), null);
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_deliveries WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 2);
});

test("an interrupted partial delivery renders its saved timestamp and remaining work without a fresh completion claim", async () => {
  const value = await h.fresh(), first = await h.capture(value), second = await h.capture(value), a = await h.invite(value, first.ticket.id), b = await h.invite(value, second.ticket.id), draft = await h.draft(value, [a.capabilityId, b.capabilityId]); await h.approve(value, draft.draft.id); await h.deliver(value, draft.draft.id, 1); const reserved = await h.reserve(value, draft.draft.id, 1);
  await h.command(value.actor, { type: "load_incidents" }); const current = await h.audience.readAudienceMessage(value.authority, draft.draft.id), pass = current.passes.find(item => item.id === reserved.saved.receipt.recordId)!;
  await assert.rejects(h.audience.runAudienceDelivery(value.authority, pass.id, pass.proof, AbortSignal.timeout(10000)), { code: "AUDIENCE_DELIVERY_SOURCE_ENDED" }); const retained = await h.audience.readAudienceMessage(value.authority, draft.draft.id), interrupted = retained.passes.find(item => item.id === pass.id)!;
  await mount(value, undefined, undefined, "/audience?message=" + draft.draft.id); await until(() => Boolean(container.textContent?.includes("Retained interruption:")));
  assert.ok(container.querySelector(`time[datetime="${interrupted.updatedAt}"]`)); assert.match(container.textContent!, /1 remaining/); assert.match(container.textContent!, /Remaining delivery is not complete/); assert.equal(container.textContent!.includes("Every approved inbox has its immutable receipt."), false); assert.equal(button("Review next delivery pass").disabled, true); assert.equal(posts().length, 0);
});

test("a completed passive read does not steal focus from an unrelated field the user entered while waiting", async () => {
  const value = await h.fresh(), gate = deferred<Response>(); let wait = false;
  await harness(value, async (call, forward) => wait && call.path === "/api/audience" ? gate.promise : forward()); wait = true;
  await click(button("Refresh facts")); const unrelated = container.querySelector<HTMLInputElement>('[aria-label="Unrelated producer note"]')!; unrelated.focus();
  gate.resolve(await h.route.GET(h.request(value.token))); await until(() => Boolean(container.querySelector('[data-busy=""]'))); assert.equal(document.activeElement, unrelated); assert.equal(posts().length, 0);
});

test("empty attendee access is read-only and an original fragment opens only its own itemized ticket and controlled inbox", async () => {
  const value = await h.fresh(); await mount(value, undefined, <AttendeeAccess />, "/attendee"); await until(() => Boolean(container.textContent?.includes("Open your attendee invitation.")));
  assert.equal(calls.length, 0); assert.equal(container.querySelector<HTMLInputElement>("#attendee-key")!.type, "password");
  const original = await h.capture(value), link = await h.invite(value, original.ticket.id), note = "<img src=x onerror=alert(1)> <script>do-not-execute()</script>";
  const draft = await h.draft(value, [link.capabilityId], "event_update", note); await h.approve(value, draft.draft.id); await h.deliver(value, draft.draft.id);
  await unmount(); await mount(value, undefined, <AttendeeAccess />, "/attendee#" + link.token); await until(() => Boolean(container.textContent?.includes("Your night, kept in view.")));
  assert.equal(location.hash, ""); assert.ok(savedAttendeeKeyIs(link.token)); assert.match(container.textContent!, /\$35\.00/); assert.match(container.textContent!, /\$15\.00/); assert.match(container.textContent!, /\$50\.00/); assert.match(container.textContent!, /does not record a person entering/);
  assert.ok(container.textContent!.includes(note)); assert.equal(container.querySelector("img,script"), null); assert.equal(posts().length, 0);
  assert.ok(calls.every(call => call.path === "/api/attendee" && call.method === "GET" && call.credentials === "omit" && call.headers.get("authorization") === "Bearer " + link.token));
  await click(button("Close private ticket")); await until(() => Boolean(container.textContent?.includes("Private access is closed."))); assert.equal(container.querySelector('[aria-label="Original ticket receipt"]'), null); assert.equal(sessionStorage.getItem(ATTENDEE_STORAGE), null);
});

function savedAttendeeKeyIs(value: string) { try { return JSON.parse(sessionStorage.getItem(ATTENDEE_STORAGE) ?? "null")?.token === value; } catch { return false; } }

test("revoked attendee reads clear all ticket content before parsing even an unreadable denial", async () => {
  const value = await h.fresh(), original = await h.capture(value), link = await h.invite(value, original.ticket.id); let deny = false;
  await mount(value, (call, forward) => deny && call.path === "/api/attendee" ? new Response("No readable body", { status: 401 }) : forward(), <AttendeeAccess />, "/attendee#" + link.token);
  await until(() => Boolean(container.textContent?.includes("Your night, kept in view."))); await h.audienceAct(value.authority, { type: "revoke_invite", capabilityId: link.capabilityId, confirmed: true }); deny = true;
  await click(button("Refresh ticket")); await until(() => Boolean(container.textContent?.includes("Private access is closed.")));
  assert.equal(container.querySelector('[aria-label="Original ticket receipt"]'), null); assert.equal(container.querySelector('[aria-labelledby="attendee-inbox-title"]'), null); assert.equal(sessionStorage.getItem(ATTENDEE_STORAGE), null); assert.equal(posts().length, 0);
});

test("a changed attendee key fences an older response even when its transport ignores abort", async () => {
  const value = await h.fresh(), vip = await h.capture(value), standard = await h.capture(value, "standard"), a = await h.invite(value, vip.ticket.id), b = await h.invite(value, standard.ticket.id), gate = deferred<Response>(); let originalResponse: Response | null = null;
  await mount(value, async (call, forward) => { const response = await forward(); if (call.headers.get("authorization") === "Bearer " + a.token) { originalResponse = response; return gate.promise; } return response; }, <AttendeeAccess />, "/attendee#" + a.token);
  await until(() => originalResponse !== null);
  await act(async () => { history.replaceState({}, "", "/attendee#" + b.token); window.dispatchEvent(new Event("hashchange")); });
  await until(() => Boolean(container.textContent?.includes("Your night, kept in view."))); assert.ok(container.textContent!.includes(standard.ticket.id)); assert.equal(container.textContent!.includes(vip.ticket.id), false);
  gate.resolve(originalResponse!); await flush(); assert.ok(container.textContent!.includes(standard.ticket.id)); assert.equal(container.textContent!.includes(vip.ticket.id), false); assert.ok(savedAttendeeKeyIs(b.token)); assert.equal(location.hash, ""); assert.equal(posts().length, 0);
});

test("an attendee message hash failure retains only the dated prior observation and rejects changed content", async () => {
  const value = await h.fresh(), original = await h.capture(value), link = await h.invite(value, original.ticket.id), draft = await h.draft(value, [link.capabilityId]); await h.approve(value, draft.draft.id); await h.deliver(value, draft.draft.id); let corrupt = false;
  await mount(value, async (call, forward) => { const response = await forward(); if (!corrupt || call.path !== "/api/attendee") return response; const body = await response.json(); body.inbox[0].body += "UNREVIEWED-HASH-FAILURE"; return Response.json(body); }, <AttendeeAccess />, "/attendee#" + link.token);
  await until(() => Boolean(container.textContent?.includes("Your night, kept in view."))); corrupt = true; await click(button("Refresh ticket"));
  await until(() => Boolean(container.textContent?.includes("saved message hash does not match")));
  assert.ok(container.textContent!.includes(draft.draft.recipients[0]!.content.body)); assert.equal(container.textContent!.includes("UNREVIEWED-HASH-FAILURE"), false); assert.match(container.textContent!, /last verified observation/); assert.ok(container.querySelector('[role="alert"] time[datetime]')); assert.equal(posts().length, 0);
});

test("attendee fixed expiry clears the mounted receipt and stored key without a renewal request", async () => {
  const value = await h.fresh(), original = await h.capture(value); await h.database.pool.query("UPDATE on_sessions SET expires_at=clock_timestamp()+interval '1200 milliseconds' WHERE token_hash=$1", [value.authority.sessionHash]); const link = await h.invite(value, original.ticket.id);
  await mount(value, undefined, <AttendeeAccess />, "/attendee#" + link.token); await until(() => Boolean(container.textContent?.includes("Your night, kept in view."))); const before = calls.length;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(link.result.invitation!.expiresAt) - Date.now() + 30))); });
  await until(() => Boolean(container.textContent?.includes("Private access is closed."))); assert.equal(container.querySelector('[aria-label="Original ticket receipt"]'), null); assert.equal(sessionStorage.getItem(ATTENDEE_STORAGE), null); assert.equal(calls.length, before); assert.equal(posts().length, 0);
});

test("a current-source label that contradicts an exact retained message source is rejected", async () => {
  const value = await h.fresh(), original = await h.capture(value), link = await h.invite(value, original.ticket.id), draft = await h.draft(value, [link.capabilityId]); await h.approve(value, draft.draft.id); await h.deliver(value, draft.draft.id); await h.command(value.actor, { type: "load_incidents" });
  await mount(value, async (call, forward) => { const response = await forward(); if (call.path !== "/api/attendee") return response; const body = await response.json(); assert.equal(body.inbox[0].sourceIsCurrent, false); body.inbox[0].sourceIsCurrent = true; return Response.json(body); }, <AttendeeAccess />, "/attendee#" + link.token);
  await until(() => !container.textContent?.includes("Checking your private invitation…"));
  assert.match(container.textContent!, /message source does not match its current-source label/); assert.equal(container.querySelector('[aria-label="Original ticket receipt"]'), null); assert.equal(posts().length, 0);
});

test("bounded inbox pagination keeps exact receipts and reclassifies retained messages when the current source changes", async () => {
  const value = await h.fresh(), original = await h.capture(value), link = await h.invite(value, original.ticket.id), receipts = [];
  for (let index = 0; index < 21; index++) { const draft = await h.draft(value, [link.capabilityId], "event_update", "Controlled pagination observation " + index); await h.approve(value, draft.draft.id); const sent = await h.deliver(value, draft.draft.id); receipts.push(sent.view.deliveries[0]!); }
  const first = await h.attendee.readAttendee(link.reader); assert.equal(first.inbox.length, 20); assert.equal(first.inboxPage.hasMore, true); assert.ok(first.inboxPage.cursor);
  await mount(value, undefined, <AttendeeAccess />, "/attendee#" + link.token); await until(() => Boolean(container.textContent?.includes("Your night, kept in view.")));
  const inbox = () => container.querySelector('[aria-labelledby="attendee-inbox-title"]')!;
  assert.equal(inbox().querySelectorAll("article").length, 20); assert.equal((inbox().textContent!.match(/Reviewed source/g) ?? []).length, 20);
  await h.capture(value, "standard"); await click(button("Load earlier updates"));
  await until(() => inbox().querySelectorAll("article").length === 21);
  assert.equal((inbox().textContent!.match(/Historical update/g) ?? []).length, 21); assert.equal(inbox().textContent!.includes("Reviewed source"), false);
  for (const receipt of receipts) assert.ok(inbox().textContent!.includes(receipt.digest));
  assert.equal([...container.querySelectorAll("button")].some(item => item.textContent === "Load earlier updates"), false); assert.equal(posts().length, 0); assert.ok(calls.some(call => call.path.startsWith("/api/attendee?before=")));
});
