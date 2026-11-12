/** Mounted behavior only; native geometry and actual human participation are separate gates. */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ConsentCommandResult, ProducerConsentEnvelope, ProducerConsentWorkspace } from "../src/domain/plan-consents";
import { ProducerConsentDesk } from "../src/components/plan-consents/producer-desk";
import { ArtistConsentReview } from "../src/components/plan-consents/artist-review";
import { ConsentReceiptNotice } from "../src/components/plan-consents/shared";
import { usePlanConsents } from "../src/components/plan-consents/use-plan-consents";
import { consentRecoveryKey, prepareConsent, producerClientScope } from "../src/components/plan-consents/recovery";
import { PRODUCTION_CHANGED_EVENT } from "../src/components/production-fetch";
import { consentUiFixture, uiConsentResult, uiInvitation } from "./plan-consents-ui-fixtures";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:4607/approvals", pretendToBeVisual: true });
for (const name of ["window", "self", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "StorageEvent", "location", "history", "localStorage", "sessionStorage", "MutationObserver"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const { createRoot } = await import("react-dom/client"), originalFetch = globalThis.fetch, originalSet = dom.window.Storage.prototype.setItem;
let root: Root | null = null, container: HTMLDivElement, calls: Call[] = [];
type Call = { path: string; method: string; body: any; headers: Headers; credentials: RequestCredentials | undefined };
type Route = (call: Call) => Response | Promise<Response> | undefined;
const button = (label: string) => { const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label); assert.ok(found, "Missing button: " + label); return found; };
const field = (label: string) => { const found = [...container.querySelectorAll<HTMLLabelElement>("label")].find(item => item.textContent?.trim().startsWith(label)); assert.ok(found, "Missing label: " + label); const input = found.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select"); assert.ok(input); return input; };
const posts = () => calls.filter(call => call.method === "POST");
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
async function until(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await flush(); assert.ok(check(), "Consent UI did not settle"); }
async function click(element: HTMLElement) { await act(async () => { element.focus(); element.click(); }); }
async function fill(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => { const prototype = element instanceof HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
async function mount(node: ReactNode, workspace: ProducerConsentWorkspace, route?: Route) {
  calls = []; container = document.createElement("div"); document.body.append(container);
  globalThis.fetch = async (input, init) => { const path = String(input), call: Call = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers), credentials: init?.credentials }; calls.push(call); const custom = route?.(call); if (custom) return custom; if (path === "/api/plan-approvals" && call.method === "GET") return Response.json(workspace); throw new Error("Unexpected controlled request: " + call.method + " " + path); };
  root = createRoot(container); await act(async () => root!.render(node));
}
function Harness({ workspace }: { workspace: ProducerConsentWorkspace }) {
  const client = usePlanConsents("producer");
  return <main><p>{client.view ? "Current workspace" : "No workspace"}</p><ConsentReceiptNotice client={client} /><button disabled={client.locked || !client.view} onClick={() => void client.send(uiInvitation(workspace))}>Save invitation</button><button disabled={client.busy || client.ended} onClick={() => void client.refresh()}>Refresh workspace</button><span data-busy={String(client.busy)} /></main>;
}
async function harness(workspace: ProducerConsentWorkspace, route?: Route) { await mount(<Harness workspace={workspace} />, workspace, route); await until(() => Boolean(container.querySelector('[data-busy="false"]'))); }
afterEach(async () => { dom.window.Storage.prototype.setItem = originalSet; if (root) { await act(async () => root!.unmount()); root = null; } document.body.replaceChildren(); sessionStorage.clear(); localStorage.clear(); history.replaceState(null, "", "/approvals"); globalThis.fetch = originalFetch; });
after(() => dom.window.close());

test("producer sees exact changes and must review designation and source before saving an invitation", async () => {
  const { workspace } = consentUiFixture(); let submitted: ProducerConsentEnvelope | null = null;
  await mount(<ProducerConsentDesk />, workspace, call => call.method === "POST" ? (async () => { submitted = call.body; assert.ok(sessionStorage.getItem(consentRecoveryKey(producerClientScope(workspace)))); return Response.json(await uiConsentResult(workspace, call.body)); })() : undefined);
  await until(() => Boolean(container.querySelector(".consent-form")));
  assert.match(container.textContent!, /90 min/); assert.match(container.textContent!, /75 min/); assert.match(container.textContent!, /producer cannot check this requirement/);
  assert.equal(button("Save this review invitation").disabled, true); assert.equal(button("Approve current recovery plan").disabled, true); assert.equal(posts().length, 0);
  await fill(field("Invited representative’s name"), "Controlled Representative"); await fill(field("Basis for their representation"), "Controlled test designation, without a real identity or human participation claim.");
  await click(field("I reviewed the exact before/after")); assert.equal(button("Save this review invitation").disabled, true);
  await click(field("I designate this representative")); assert.equal(button("Save this review invitation").disabled, false);
  await click(button("Save this review invitation")); await until(() => Boolean(container.textContent?.includes("Original receipt confirmed")));
  assert.equal(posts().length, 1); assert.equal(submitted!.command.type, "invite"); assert.equal(posts()[0]!.headers.get("x-opening-night-production"), workspace.scope.tenantId);
});

test("lost committed response remains held until the exact original GET receipt recovers it", async () => {
  const { workspace } = consentUiFixture(); let saved: ConsentCommandResult | null = null, held = true;
  await harness(workspace, call => {
    if (call.method === "POST") return (async () => { saved = await uiConsentResult(workspace, call.body); throw new TypeError("Controlled loss after commit"); })();
    if (call.path.includes("?commandId=")) return held ? Response.json({ code: "SERVICE_UNAVAILABLE", error: "Controlled original receipt is temporarily held." }, { status: 503 }) : Response.json(saved);
  });
  await click(button("Save invitation")); await until(() => Boolean(container.querySelector(".consent-pending") && container.querySelector('[data-busy="false"]')));
  assert.equal(posts().length, 1); assert.equal(button("Save invitation").disabled, true); assert.ok(sessionStorage.getItem(consentRecoveryKey(producerClientScope(workspace))));
  held = false; await click(button("Check original result")); await until(() => Boolean(container.querySelector(".consent-saved")));
  assert.equal(posts().length, 1); assert.equal(sessionStorage.getItem(consentRecoveryKey(producerClientScope(workspace))), null);
});

test("a verified missing receipt enables only an explicit retry with unchanged original bytes", async () => {
  const { workspace } = consentUiFixture(); let first = true;
  await harness(workspace, call => {
    if (call.path.includes("?commandId=")) return Response.json({ code: "PLAN_CONSENT_COMMAND_NOT_FOUND", error: "No original receipt" }, { status: 404 });
    if (call.method === "POST") { if (first) { first = false; return Promise.reject(new TypeError("Controlled loss before dispatch")); } return uiConsentResult(workspace, call.body).then(Response.json); }
  });
  await click(button("Save invitation")); await until(() => Boolean(container.textContent?.includes("Retry exact instruction") && container.querySelector('[data-busy="false"]')));
  const original = structuredClone(posts()[0]!.body); assert.equal(posts().length, 1);
  await click(button("Retry exact instruction")); await until(() => Boolean(container.querySelector(".consent-saved")));
  assert.equal(posts().length, 2); assert.deepEqual(posts()[1]!.body, original); assert.ok(calls.filter(call => call.path.includes("?commandId=")).length >= 2);
});

test("another original access ends the view and preserves its pending record without a POST", async () => {
  let { workspace } = consentUiFixture(); const original = workspace, pending = await prepareConsent(producerClientScope(workspace), uiInvitation(workspace));
  sessionStorage.setItem(consentRecoveryKey(pending.scope), JSON.stringify(pending));
  await harness(workspace, call => call.path.includes("?commandId=") ? Response.json({ code: "SERVICE_UNAVAILABLE", error: "Held original read" }, { status: 503 }) : call.path === "/api/plan-approvals" ? Response.json(workspace) : undefined);
  workspace = { ...workspace, scope: { ...workspace.scope, sessionFingerprint: "f".repeat(64) } };
  await click(button("Refresh workspace")); await until(() => Boolean(container.textContent?.includes("Different production access")));
  assert.equal(posts().length, 0); assert.equal(container.querySelector(".consent-pending"), null); assert.equal(button("Save invitation").disabled, true);
  assert.equal(sessionStorage.getItem(consentRecoveryKey(producerClientScope(original))), JSON.stringify(pending));
});

test("corrupt stored instructions lock new actions without clearing the original bytes", async () => {
  const { workspace } = consentUiFixture(), key = consentRecoveryKey(producerClientScope(workspace)), corrupt = '{"original":"incomplete"';
  sessionStorage.setItem(key, corrupt); await harness(workspace);
  assert.equal(button("Save invitation").disabled, true); assert.equal(posts().length, 0); assert.equal(sessionStorage.getItem(key), corrupt);
});

test("failed storage readback prevents dispatch, and corrupted response hashes preserve recovery", async () => {
  const { workspace } = consentUiFixture(); await harness(workspace);
  dom.window.Storage.prototype.setItem = function () { return; };
  await click(button("Save invitation")); await until(() => Boolean(container.textContent?.includes("could not retain")));
  assert.equal(posts().length, 0); dom.window.Storage.prototype.setItem = originalSet;
  let corrupted: ConsentCommandResult | null = null;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") { const body = JSON.parse(String(init.body)); calls.push({ path: String(input), method: "POST", body, headers: new Headers(init.headers), credentials: init.credentials }); corrupted = await uiConsentResult(workspace, body); corrupted.receipt.result.message = "Changed response text"; return Response.json(corrupted); }
    if (String(input).includes("?commandId=")) return Response.json(corrupted);
    return Response.json(workspace);
  };
  await click(button("Save invitation")); await until(() => Boolean(container.textContent?.includes("does not match the original") && container.querySelector('[data-busy="false"]')));
  assert.equal(posts().length, 1); assert.equal(button("Save invitation").disabled, true); assert.ok(sessionStorage.getItem(consentRecoveryKey(producerClientScope(workspace))));
});

test("a production-change notification hides current private content and never resends an instruction", async () => {
  const { workspace } = consentUiFixture(); await harness(workspace);
  await act(async () => window.dispatchEvent(new Event(PRODUCTION_CHANGED_EVENT)));
  assert.match(container.textContent!, /Another production is selected/); assert.equal(button("Save invitation").disabled, true); assert.equal(posts().length, 0); assert.match(container.textContent!, /No workspace/);
});

test("representative flow uses only dedicated bearer access and an explicit declared decision", async () => {
  const { workspace, token } = consentUiFixture(); let { reader } = consentUiFixture();
  history.replaceState(null, "", "/approvals/review#" + token);
  await mount(<ArtistConsentReview />, workspace, call => {
    if (call.path === "/api/plan-approvals/review" && call.method === "GET") return Response.json(reader);
    if (call.path === "/api/plan-approvals/review" && call.method === "POST") return (async () => { const saved = await uiConsentResult(reader, call.body); reader = { ...reader, state: "consented", decision: saved.receipt.result.decision! }; return Response.json(saved); })();
  });
  await until(() => Boolean(container.querySelector(".consent-form")));
  assert.equal(button("Consent to this exact change").disabled, true); assert.match(container.textContent!, /CONTROLLED DECLARATION/);
  await fill(field("Your declared name"), reader.review.representative.invitedName); await fill(field("Decision statement"), "Controlled reviewed consent only, with no actual human or physical claim.");
  await click(field("I am the invited representative")); await click(field("I read the exact changes"));
  await click(button("Consent to this exact change")); await until(() => Boolean(container.textContent?.includes("Your consent is saved.")));
  assert.equal(posts().length, 1); assert.ok(calls.every(call => call.headers.get("authorization") === "Bearer " + token && call.credentials === "omit"));
  assert.ok(calls.every(call => call.path.startsWith("/api/plan-approvals/review"))); assert.equal(container.querySelector(".consent-form"), null);
});

test("untrusted source text stays inert and revoked or stale reviews offer no decision buttons", async () => {
  const { workspace, token, reader } = consentUiFixture(); reader.review.representative.source.detail = '<img src=x onerror="window.bad=1"><script>steal()</script>'; reader.state = "source_changed"; reader.blocker = "The current source changed. Review a new exact proposal.";
  history.replaceState(null, "", "/approvals/review#" + token);
  await mount(<ArtistConsentReview />, workspace, call => call.path === "/api/plan-approvals/review" ? Response.json(reader) : undefined);
  await until(() => Boolean(container.querySelector(".consent-reader-grid")));
  assert.match(container.textContent!, /<img src=x/); assert.equal(container.querySelector("script,img"), null); assert.equal(container.querySelector(".consent-form"), null); assert.equal(posts().length, 0);
});
