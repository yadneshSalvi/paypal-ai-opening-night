/** Presentation-only synthetic inputs. No database, supplier or payment transport. */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { act, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ConsoleData } from "../src/domain/contracts";
import type { RentalExecution } from "../src/domain/supplier-contracts";
import { allReadiness } from "../src/domain/readiness";
import { crewProductionOverview } from "../src/server/crew/projection";
import { approved } from "./helpers";
import { ExecutionView } from "../src/components/execution-view";
import { SupplierExecutionDesk } from "../src/components/supplier-network";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:4599/execution", pretendToBeVisual: true });
for (const name of ["window", "self", "document", "HTMLElement", "HTMLInputElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "location", "history", "localStorage", "MutationObserver"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
dom.window.HTMLElement.prototype.getClientRects = function () { return (this.isConnected ? [new dom.window.DOMRect(0, 0, 120, 30)] : []) as unknown as DOMRectList; };
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
const { createRoot } = await import("react-dom/client");
const realFetch = globalThis.fetch;
let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); globalThis.fetch = realFetch; });
after(() => dom.window.close());

function fixture(): ConsoleData {
  const { show, actor } = approved(), now = new Date().toISOString(); show.commercialProtocol = 2;
  const chosen = show.runs.flatMap(run => run.candidates).find(candidate => candidate.id === show.approvedPlan!.candidateId)!;
  const offer = show.offers.find(value => value.id === chosen.patch.offerId)!;
  offer.serviceQuote = { id: randomUUID(), termsDigest: "a".repeat(64), issuedAt: now, validUntil: new Date(Date.now() + 3600000).toISOString(), serviceId: "controlled-component-source", source: "authenticated_fixture_service" };
  return { show, currentActor: actor, serverAt: now, controlledQa: true, controlledPlanningQa: true, readiness: allReadiness(show), crew: crewProductionOverview(show) };
}
function rental(data: ConsoleData, changes: Partial<RentalExecution> = {}): RentalExecution {
  const show = data.show, candidate = show.runs.flatMap(run => run.candidates).find(value => value.id === show.approvedPlan!.candidateId)!, offer = show.offers.find(value => value.id === candidate.patch.offerId)!;
  return { schemaVersion: 1, id: randomUUID(), planVersion: show.planVersion, planDigest: show.approvedPlan!.digest, quoteId: offer.serviceQuote!.id, quoteDigest: offer.serviceQuote!.termsDigest, offerId: offer.id, offerRevision: offer.revision, supplierId: offer.supplierId as RentalExecution["supplierId"], unitId: offer.unitId, feeMinor: offer.feeMinor, depositMinor: offer.depositMinor, deliveryAt: offer.deliveryAt, windowEnd: show.accessUntil, createdAt: data.serverAt, updatedAt: data.serverAt, holdExpiresAt: new Date(Date.now() + 600000).toISOString(), state: "held", producerId: data.currentActor.id, captureConsentAt: data.serverAt, paymentRootId: null, authorizationId: null, captureIntentId: null, compensationIntentId: null, cancellationApprovedAt: null, deliveryId: null, deliveryVersion: 0, acceptedAt: null, lastCode: null, source: "controlled_fixture", ...changes };
}
const button = (label: string) => { const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label); assert.ok(value, label); return value; };
async function click(target: HTMLElement) { await act(async () => { target.focus(); target.click(); }); }

test("controlled execution retains equipment review while the payment desk stays absent", () => {
  const data = fixture(), html = renderToStaticMarkup(<ExecutionView licenseKey="" data={data} onData={() => undefined} run={async () => null} busy={null} />);
  assert.match(html, /Review equipment hold/); assert.match(html, /CONTROLLED SUPPLIER SERVICES/);
  assert.match(html, /a hold does not establish payment, delivery or physical work/);
  assert.doesNotMatch(html, /id="rental-payment"|38 refund outcomes are controlled test inputs/);
});

test("mounted reviewed local hold sends one exact instruction and exposes no checkout after retention", async () => {
  const data = fixture(), original = rental(data, { planVersion: data.show.planVersion - 1, planDigest: "f".repeat(64), unitId: "OLD-CONTROLLED-UNIT", state: "accepted", acceptedAt: data.serverAt, paymentRootId: randomUUID(), authorizationId: "CONTROLLED-ORIGINAL-AUTH", captureIntentId: randomUUID() });
  data.show.rentalExecutions = [original];
  const calls: { path: string; body: any; scope: string | null }[] = [], held = rental(data);
  globalThis.fetch = async (input, init) => {
    const path = String(input); assert.equal(init?.method, "POST"); assert.match(path, /^\/api\/suppliers\/brightline\/holds$/);
    calls.push({ path, body: JSON.parse(String(init?.body)), scope: new Headers(init?.headers).get("x-opening-night-production") });
    return Response.json({ ...data, show: { ...data.show, revision: data.show.revision + 1, rentalExecutions: [original, held] }, reservation: held });
  };
  function Desk() { const [current, setCurrent] = useState(data); return <SupplierExecutionDesk data={current} onChange={setCurrent} />; }
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<Desk />));
  await click(button("Review equipment hold")); assert.equal(button("Hold this unit").disabled, true);
  assert.match(document.querySelector("dialog")!.textContent!, /\$480(?:\.00)?/); assert.match(document.querySelector("dialog")!.textContent!, /\$300(?:\.00)?/);
  await click(document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!); await click(button("Hold this unit"));
  assert.equal(calls.length, 1); assert.equal(calls[0]!.body.expectedRevision, data.show.revision); assert.equal(calls[0]!.body.planDigest, data.show.approvedPlan!.digest);
  assert.equal(calls[0]!.body.quoteId, held.quoteId); assert.equal(calls[0]!.body.acceptCaptureTerms, true); assert.match(calls[0]!.body.idempotencyKey, /^[a-f0-9-]{36}$/);
  assert.match(container.textContent!, /Equipment held through the controlled supplier service/); assert.match(container.textContent!, /OLD-CONTROLLED-UNIT/);
  assert.equal(container.querySelector('a[href="#rental-payment"]'), null); assert.equal(container.querySelector("dialog[open]"), null);
  assert.equal(data.show.rentalExecutions[0], original); assert.equal(data.show.financialEvidence.length, 0);
});

test("controlled existing authorizations retain history without exposing a provider cancellation action", () => {
  const data = fixture(); data.show.rentalExecutions = [rental(data, { state: "authorized", paymentRootId: randomUUID(), authorizationId: "CONTROLLED-CURRENT-AUTH" }), rental(data, { planVersion: data.show.planVersion - 1, planDigest: "b".repeat(64), state: "authorized", paymentRootId: randomUUID(), authorizationId: "CONTROLLED-OLD-AUTH" })];
  const controlled = renderToStaticMarkup(<SupplierExecutionDesk data={data} onChange={() => undefined} />);
  assert.doesNotMatch(controlled, /Review uncaptured cancellation|Review original authorization|Continue to buyer approval/);
  assert.match(controlled, /Read original rental history/);
  const ordinary = renderToStaticMarkup(<SupplierExecutionDesk data={{ ...data, controlledQa: false }} onChange={() => undefined} />);
  assert.match(ordinary, /Review uncaptured cancellation|Review original authorization/);
});
