/** These are SDK wire fixtures in isolated PostgreSQL tenants, never provider qualification. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SandboxPayPalProvider } from "@fracture/paypal-core";
import { isolatedDatabase } from "./isolated-database";
import { applyCommand, recordRescueRun, type Command } from "../src/domain/commands";
import { enumerateCandidates } from "../src/domain/scheduling";
import { financialSummary } from "../src/domain/finance";
import { testEngine } from "./helpers";
import type { Actor } from "../src/domain/contracts";
const database = await isolatedDatabase();
const { createSession, createSupplierCapability, getActor, getShow, pool, transactCommand } = await import("../src/server/store");
const { paymentStore, listIntents } = await import("../src/server/payment-store");

type Money = { currency_code: string; value: string };
type Payment = { id: string; status: string; amount: Money; custom_id?: string };
type Order = { id: string; status: string; intent: string; purchase_units: { amount: Money; custom_id: string; payments: { authorizations: Payment[]; captures: Payment[]; refunds: Payment[] } }[]; links: { href: string; rel: string; method: string }[] };
const orders = new Map<string, Order>();
const calls: { method: string; path: string; body: unknown; requestId: string | null; durable: boolean }[] = [];
let sequence = 0; let loseNextCreate = false;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Paypal-Debug-Id": "wire-test-only" } });
const wire: typeof fetch = async input => {
  const request = input as Request; const path = new URL(request.url).pathname;
  if (path === "/v1/oauth2/token") return json({ access_token: "wire-test-token", token_type: "Bearer", expires_in: 3600 });
  const body = request.method === "GET" ? null : JSON.parse(await request.clone().text() || "null");
  const requestId = request.headers.get("PayPal-Request-Id");
  const committed = request.method !== "GET" ? await pool.query<{ status: string }>("SELECT status FROM paycore_operations WHERE provider_request_id=$1", [requestId]) : null;
  calls.push({ method: request.method, path, body, requestId, durable: request.method === "GET" || committed?.rows[0]?.status === "dispatching" });
  if (path === "/v2/checkout/orders" && request.method === "POST") {
    const id = "ORDER-" + ++sequence; const unit = body.purchase_units[0];
    const order: Order = { id, status: "CREATED", intent: body.intent, purchase_units: [{ amount: unit.amount, custom_id: unit.custom_id, payments: { authorizations: [], captures: [], refunds: [] } }], links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=" + id, rel: "payer-action", method: "GET" }] };
    orders.set(id, order); if (loseNextCreate) { loseNextCreate = false; throw new TypeError("Controlled wire fixture lost the response after dispatch"); } return json(order, 201);
  }
  const orderId = path.split("/")[4]; const order = orders.get(orderId);
  if (order && path === "/v2/checkout/orders/" + orderId && request.method === "GET") return json(order);
  if (order && path.endsWith("/authorize")) {
    order.status = "COMPLETED"; order.purchase_units[0].payments.authorizations.push({ id: "AUTH-" + ++sequence, status: "CREATED", amount: order.purchase_units[0].amount }); return json(order, 201);
  }
  if (order && path.endsWith("/capture")) {
    order.status = "COMPLETED"; order.purchase_units[0].payments.captures.push({ id: "CAPTURE-" + ++sequence, status: "COMPLETED", amount: order.purchase_units[0].amount }); return json(order, 201);
  }
  for (const value of orders.values()) {
    const unit = value.purchase_units[0]; const auth = unit.payments.authorizations.find(p => path.includes("/" + p.id));
    if (auth) {
      if (request.method === "GET") return json(auth);
      if (path.endsWith("/capture")) { const capture = { id: "CAPTURE-" + ++sequence, status: "COMPLETED", amount: body.amount }; unit.payments.captures.push(capture); auth.status = "PARTIALLY_CAPTURED"; return json(capture, 201); }
      if (path.endsWith("/void")) { auth.status = "VOIDED"; return json(auth); }
    }
    const capture = unit.payments.captures.find(p => path.includes("/" + p.id));
    if (capture) {
      if (request.method === "GET") return json(capture);
      if (path.endsWith("/refund")) { const refund = { id: "REFUND-" + ++sequence, status: "COMPLETED", amount: body.amount, custom_id: body.custom_id }; unit.payments.refunds.push(refund); capture.status = "PARTIALLY_REFUNDED"; return json(refund, 201); }
    }
    const refund = unit.payments.refunds.find(p => path.endsWith("/" + p.id)); if (refund) return json(refund);
  }
  return json({ name: "RESOURCE_NOT_FOUND", message: "Wire fixture not found", details: [] }, 404);
};
const isolated = (seller: string) => new SandboxPayPalProvider({ environment: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com", clientId: "wire-client-" + seller, clientSecret: "wire-secret", isolatedProject: "wire-fixture" }, wire);
(globalThis as typeof globalThis & { openingNightProviders?: unknown }).openingNightProviders = { venue: isolated("venue"), brightline: isolated("brightline") };
const { handlePayment, callbackState } = await import("../src/server/payment-service");
const tenants: string[] = [];
const admissionScope = `test:payment-wire:${randomUUID()}`;
async function command(actor: Actor, action: Command) { const before = await getShow(actor.tenantId); return (await transactCommand(actor, randomUUID(), before.revision, action, current => applyCommand(current, actor, action))).show; }
async function scenario() {
  const { actor } = await createSession(undefined, admissionScope); tenants.push(actor.tenantId);
  // Preserve coverage of the already-paid legacy contract. Supplier tests separately exercise protocol2.
  await pool.query("UPDATE on_shows SET snapshot=snapshot-'commercialProtocol'-'rentalExecutions' WHERE tenant_id=$1", [actor.tenantId]);
  const disrupted = await command(actor, { type: "load_incidents" });
  const candidates = enumerateCandidates(disrupted); for (const candidate of candidates) candidate.report.engine = testEngine(candidate);
  const generated = (await transactCommand(actor, randomUUID(), disrupted.revision, { type: "generate" }, current => recordRescueRun(current, actor, candidates))).show;
  const candidate = candidates.find(c => c.id.startsWith("doors-brightline"))!;
  const show = (await transactCommand(actor, randomUUID(), generated.revision, { type: "approve" }, current => applyCommand(current, actor, { type: "approve", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: candidate.approvals.map(a => a.id) }))).show;
  return { actor, show };
}
const origin = "http://localhost:4105";
test("isolated PostgreSQL and actual SDK wire preserve rental, ticket and remedy authority", async t => {
  try {
    await paymentStore();
    const { actor, show } = await scenario();
    const [created, duplicate] = await Promise.all([handlePayment(actor, { type: "rental_checkout", expectedRevision: show.revision }, origin), handlePayment(actor, { type: "rental_checkout", expectedRevision: show.revision }, origin)]);
    const root = (await listIntents(actor.tenantId)).find(i => i.purpose === "rental_order")!;
    const settled = await handlePayment(actor, { type: "rental_checkout", expectedRevision: show.revision }, origin);
    await t.test("concurrent clicks claim one durable exact itemized checkout before fetch", () => {
      assert.equal(created.command.intentId, duplicate.command.intentId); assert.equal(settled.status, "succeeded");
      const writes = calls.filter(c => c.path === "/v2/checkout/orders" && c.method === "POST"); assert.equal(writes.length, 1); assert.ok(writes[0].durable);
      const sent = writes[0].body as { purchase_units: { amount: { value: string; breakdown: unknown }; items: { name: string; unit_amount: { value: string }; quantity: string }[] }[]; payment_source: { paypal: unknown } };
      assert.equal(sent.purchase_units[0].amount.value, "780.00"); assert.deepEqual(sent.purchase_units[0].items.map(i => [i.unit_amount.value, i.quantity]), [["480.00", "1"], ["300.00", "1"]]);
      assert.equal(Object.keys(sent).sort().join(","), "intent,payment_source,purchase_units"); assert.equal(financialSummary(show).authorizedMinor, 0);
    });
    const callback = { type: "complete_checkout" as const, intentId: root.id, state: callbackState(root) };
    const refused = await handlePayment(actor, callback, origin);
    await t.test("missing buyer approval is refused without an authorization write", () => { assert.equal(refused.status, "refused"); assert.equal(calls.filter(c => c.path.endsWith("/authorize")).length, 0); });
    const orderId = settled.receipt!.resources.find(r => r.kind === "order")!.id; orders.get(orderId)!.status = "APPROVED";
    const authorized = await handlePayment(actor, { type: "retry_refused", intentId: refused.command.intentId }, origin);
    await t.test("verified buyer approval authorizes with a durable empty JSON body", async () => { assert.equal(authorized.status, "succeeded"); const call = calls.find(c => c.path.endsWith("/authorize"))!; assert.deepEqual(call.body, {}); assert.ok(call.durable); assert.equal(financialSummary(await getShow(actor.tenantId)).authorizedMinor, 78000); });
    await t.test("unaccepted delivery fails before a fee intent or provider claim", async () => { const current = await getShow(actor.tenantId); await assert.rejects(handlePayment(actor, { type: "capture_rental_fee", intentId: root.id, expectedRevision: current.revision }, origin), /acceptance/); assert.equal((await listIntents(actor.tenantId)).filter(i => i.purpose === "rental_fee").length, 0); });
    const supplierToken = await createSupplierCapability(actor); const supplier = (await getActor(supplierToken))!;
    await command(supplier, { type: "fact", kind: "supplier_confirmed", detail: "Controlled fixture confirms exact unit and delivery terms." });
    await command(actor, { type: "advance", time: "17:15" });
    await command(actor, { type: "fact", kind: "delivery_accepted", detail: "Controlled fixture department acceptance, no physical verification claimed." });
    const atCapture = await command(actor, { type: "advance", time: "17:20" });
    const fee = await handlePayment(actor, { type: "capture_rental_fee", intentId: root.id, expectedRevision: atCapture.revision }, origin);
    await t.test("fee capture retains the original authorization and exact300 remainder", async () => { assert.equal(fee.status, "succeeded"); const call = calls.find(c => c.path.startsWith("/v2/payments/authorizations/") && c.path.endsWith("/capture"))!; assert.deepEqual(call.body, { amount: { currency_code: "USD", value: "480.00" }, final_capture: false }); assert.ok(call.durable); assert.equal(financialSummary(await getShow(actor.tenantId)).rentalCapturedMinor, 48000); assert.equal(financialSummary(await getShow(actor.tenantId)).releasedMinor, 0); });
    const latest = await getShow(actor.tenantId);
    await assert.rejects(handlePayment(actor, { type: "release_rental_hold", intentId: root.id, expectedRevision: latest.revision }, origin), /undamaged return/);
    await command(actor, { type: "advance", time: "23:30" });
    const returned = await command(supplier, { type: "fact", kind: "return_accepted", detail: "Controlled fixture undamaged return inspection accepted for wrap." });
    const release = await handlePayment(actor, { type: "release_rental_hold", intentId: root.id, expectedRevision: returned.revision }, origin);
    await t.test("hold closure records only300 released after return and exact current provider budget", async () => { assert.equal(release.status, "succeeded"); const summary = financialSummary(await getShow(actor.tenantId)); assert.equal(summary.releasedMinor, 30000); assert.equal(summary.rentalCapturedMinor, 48000); });
    const ticketId = randomUUID(); const beforeTicket = await getShow(actor.tenantId);
    const ticketOrder = await handlePayment(actor, { type: "ticket_checkout", ticketId, tier: "vip", expectedRevision: beforeTicket.revision }, origin);
    const ticketRoot = (await listIntents(actor.tenantId)).find(i => i.id === ticketOrder.command.intentId)!;
    const ticketOrderId = ticketOrder.receipt!.resources.find(r => r.kind === "order")!.id; orders.get(ticketOrderId)!.status = "APPROVED";
    await handlePayment(actor, { type: "complete_checkout", intentId: ticketRoot.id, state: callbackState(ticketRoot) }, origin);
    const beforeRefund = await getShow(actor.tenantId);
    const refund = await handlePayment(actor, { type: "refund_perk", ticketId, expectedRevision: beforeRefund.revision }, origin);
    await t.test("original-capture15 remedy preserves35 admission and cannot repeat", async () => {
      assert.equal(refund.status, "succeeded"); const summary = financialSummary(await getShow(actor.tenantId)); assert.equal(summary.grossCapturedMinor, 5000); assert.equal(summary.refundedVipCount, 1); assert.equal(summary.vipRemedyMinor, 1500);
      const repeated = await handlePayment(actor, { type: "refund_perk", ticketId, expectedRevision: beforeRefund.revision }, origin); assert.equal(repeated.command.operationId, refund.command.operationId); assert.equal(calls.filter(c => c.path.endsWith("/refund") && c.method === "POST").length, 1); assert.ok(calls.filter(c => c.method === "POST").every(c => c.durable));
    });
    const other = await scenario();
    await t.test("another tenant cannot access the saved rental or callback", async () => { await assert.rejects(handlePayment(other.actor, callback, origin), /does not belong/); });
    loseNextCreate = true; const previousCreates = calls.filter(c => c.path === "/v2/checkout/orders" && c.method === "POST").length;
    const unknown = await handlePayment(other.actor, { type: "rental_checkout", expectedRevision: other.show.revision }, origin);
    const noResend = await handlePayment(other.actor, { type: "rental_checkout", expectedRevision: other.show.revision }, origin);
    await t.test("a lost create response remains unknown and a second click never resends", () => { assert.equal(unknown.status, "pending_reconciliation"); assert.equal(noResend.command.operationId, unknown.command.operationId); assert.equal(calls.filter(c => c.path === "/v2/checkout/orders" && c.method === "POST").length, previousCreates + 1); });
  } finally {
    for (const tenantId of tenants) { for (const table of ["paycore_operations", "paycore_resource_locks", "paycore_attempts", "paycore_webhook_events", "paycore_webhook_deliveries"]) await pool.query("DELETE FROM " + table + " WHERE tenant_id=$1", [tenantId]); await pool.query("DELETE FROM on_shows WHERE tenant_id=$1", [tenantId]); }
    await pool.query("DELETE FROM on_session_admissions WHERE scope=$1", [admissionScope]);
    await database.close();
  }
});
