import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DomainError, type Actor, type ShowSnapshot } from "../src/domain/contracts";
import type { RentalExecution, SupplierId } from "../src/domain/supplier-contracts";
import type { PaymentIntent } from "../src/domain/payment-authority";
import { applyCommand, recordRescueRun, type Command } from "../src/domain/commands";
import { enumerateCandidates } from "../src/domain/scheduling";
import { testEngine, evidence } from "./helpers";
import { currentActual, uniqueActual } from "../src/domain/finance";
import { supplierIsConfirmed, deliveryIsAccepted } from "../src/domain/supplier-contracts";
import { assertPaymentAuthority } from "../src/domain/payment-authority";
import { isolatedDatabase } from "./isolated-database";
import { SandboxPayPalProvider } from "@fracture/paypal-core";
import QRCode from "qrcode";
import jsQR from "jsqr";

// Entire suite uses a disposable local schema and controlled HTTP-handler transport.
// Financial records below are explicit test fixtures, never provider qualification evidence.
const database = await isolatedDatabase();
// A test that has not explicitly installed wireFor's controlled transport must
// never instantiate an ambient merchant client or fall back to the network.
const blockedProvider = new Proxy({} as SandboxPayPalProvider, { get() { throw new Error("Install the controlled supplier wire before any provider access"); } });
(globalThis as typeof globalThis & { openingNightProviders?: Record<"venue" | "brightline", SandboxPayPalProvider> }).openingNightProviders = { venue: blockedProvider, brightline: blockedProvider };
const store = await import("../src/server/store");
const payments = await import("../src/server/payment-store");
const intents = await import("../src/server/payment-intents");
const protocol = await import("../src/server/supplier-protocol");
const rfq = await import("../src/server/supplier-rfq");
const service = await import("../src/server/supplier-service");
const storage = await import("../src/server/supplier-storage");
const delivery = await import("../src/server/delivery-service");
const tokens = await import("../src/server/delivery-token");
const projection = await import("../src/server/supplier-payment-projection");
const cancellation = await import("../src/server/supplier-cancellation");
const rpc = await import("../src/app/api/enrolled-suppliers/[supplier]/rpc/route");
await store.migrate(); await payments.paymentStore();
after(async () => { await database.close(); });
const transport: import("../src/server/supplier-protocol").SupplierTransport = request => rpc.POST(request, { params: Promise.resolve({ supplier: new URL(request.url).pathname.split("/").at(-2)! }) });
const errorCode = (code: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === code);

async function command(actor: Actor, value: Command) {
  const show = await store.getShow(actor.tenantId);
  return (await store.transactCommand(actor, randomUUID(), show.revision, value, current => applyCommand(current, actor, value))).show;
}
async function quoteSetup() {
  const session = await store.createSession(undefined, "supplier-tests:" + randomUUID());
  const show = await command(session.actor, { type: "load_incidents" });
  const id = randomUUID(); await rfq.beginSupplierRfq(session.actor, id, show.revision);
  assert.equal((await rfq.collectSupplierRfq(session.actor.tenantId, id, AbortSignal.timeout(5000), transport)).status, "complete");
  return { actor: session.actor, show: await store.getShow(session.actor.tenantId), rfqId: id };
}
async function approve(actor: Actor) {
  let show = await store.getShow(actor.tenantId);
  const candidates = enumerateCandidates(show); for (const candidate of candidates) candidate.report.engine = testEngine(candidate);
  show = (await store.transactCommand(actor, randomUUID(), show.revision, { type: "test-engine-run" }, current => recordRescueRun(current, actor, candidates))).show;
  const choice = candidates.find(candidate => candidate.id.startsWith("doors-brightline"))!;
  return command(actor, { type: "approve", candidateId: choice.id, candidateDigest: choice.digest, approvals: choice.approvals.map(item => item.id) });
}
async function holdRequest(actor: Actor, requestId = randomUUID()) {
  const show = await store.getShow(actor.tenantId); const quote = show.offers.find(item => item.supplierId === "brightline")!.serviceQuote!;
  return { version: 1 as const, requestId, tenantId: actor.tenantId, actorId: actor.id, action: { type: "hold" as const, quoteId: quote.id, planDigest: show.approvedPlan!.digest, expectedRevision: show.revision, acceptCaptureTerms: true as const } };
}
async function holdSetup() {
  const setup = await quoteSetup(); await approve(setup.actor);
  const request = await holdRequest(setup.actor);
  const result = await protocol.callSupplierService("brightline", request, AbortSignal.timeout(5000), transport);
  assert.equal(result.kind, "execution");
  return { actor: setup.actor, execution: result.kind === "execution" ? result.execution : null!, request };
}
async function prepareRoot(actor: Actor, executionId: string) {
  return storage.supplierTransaction(async client => {
    const show = await storage.lockSupplierShow(client, actor.tenantId);
    const execution = await storage.readRentalExecution(client, actor.tenantId, executionId);
    const result = await intents.preparePaymentIntent(client, actor, { purpose: "rental_order", seller: "brightline", semanticKey: `rental:${show.planVersion}:order`, approvedExecution: execution, build: id => ({ kind: "create_order", money: { currency: "USD", minor: 78000 }, intent: "AUTHORIZE", customId: "on:" + id }) }, show);
    if (result.created) await storage.saveSupplierSnapshot(client, show, actor.id, "fixture.intent_prepared", "Controlled local test prepared an approved intent without calling a provider.");
    return result.intent;
  });
}
async function recordAuthorization(actor: Actor, executionId: string, root: PaymentIntent) {
  const orderId = "TEST-ORDER-" + randomUUID(), authorizationId = "TEST-AUTH-" + randomUUID();
  await storage.supplierTransaction(async client => {
    const show = await storage.lockSupplierShow(client, actor.tenantId);
    for (const [kind, id] of [["order", orderId], ["authorization", authorizationId]]) await client.query("INSERT INTO on_payment_bindings(seller,kind,provider_id,tenant_id,root_intent_id) VALUES('brightline',$1,$2,$3,$4)", [kind, id, actor.tenantId, root.id]);
    const fact = evidence(show, { kind: "authorization", purpose: "rental", providerResourceId: authorizationId, parentId: orderId, amountMinor: 78000 });
    show.financialEvidence.push(fact);
    await projection.projectRentalPayment(client, show, { ...root, id: randomUUID(), parentId: root.id, purpose: "rental_authorize", executionId }, [fact]);
    await storage.saveSupplierSnapshot(client, show, actor.id, "fixture.authorization_projected", "Controlled PostgreSQL test authorization fixture. No provider request was made.");
  });
  return { orderId, authorizationId };
}
async function confirmedSetup() {
  const setup = await holdSetup(); const root = await prepareRoot(setup.actor, setup.execution.id);
  const resource = await recordAuthorization(setup.actor, setup.execution.id, root);
  const result = await protocol.callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: setup.actor.tenantId, actorId: setup.actor.id, action: { type: "confirm", executionId: setup.execution.id } }, AbortSignal.timeout(5000), transport);
  assert.equal(result.kind, "execution");
  const driverLink = await store.createDeliveryCapability(setup.actor, "driver"); const inspectorLink = await store.createDeliveryCapability(setup.actor, "inspector");
  return { ...setup, root, ...resource, driver: (await store.getActor(driverLink.token))!, inspector: (await store.getActor(inspectorLink.token))! };
}
async function scannedSetup() {
  const setup = await confirmedSetup(); const show = await command(setup.actor, { type: "advance", time: "17:15" });
  const issued = await delivery.issueDelivery(setup.actor, setup.execution.id, randomUUID(), show.revision);
  const receipt = await delivery.scanDelivery(setup.driver, issued.token!, randomUUID());
  return { ...setup, issued, receipt };
}
async function backdateHold(actor: Actor, executionId: string) {
  await storage.supplierTransaction(async client => {
    const show = await storage.lockSupplierShow(client, actor.tenantId); const execution = await storage.readRentalExecution(client, actor.tenantId, executionId);
    execution.holdExpiresAt = new Date(Date.now() - 1000).toISOString(); await storage.saveRentalExecution(client, show, execution);
    await client.query("UPDATE on_resource_holds SET expires_at=$2 WHERE id=$1", [executionId, execution.holdExpiresAt]);
    await storage.saveSupplierSnapshot(client, show, actor.id, "fixture.expiry_shifted", "Controlled local test made a real-time lease expire.");
  });
}

test("three authenticated service scopes return signed immutable terms while the loan's missing evidence stays unknown", async () => {
  const { actor, show } = await quoteSetup(); const overview = await rfq.supplierOverview(actor);
  assert.equal(overview.quotes.length, 3); assert.equal(show.offers.length, 3);
  for (const quote of overview.quotes) { assert.equal(protocol.verifySupplierQuote(quote), true); assert.equal(quote.tenantId, actor.tenantId); assert.equal(quote.source, "controlled_fixture"); assert.ok(Date.parse(quote.validUntil) > Date.now()); }
  const loan = overview.quotes.find(quote => quote.supplierId === "sister")!;
  assert.equal(loan.offer.feeMinor, 0); assert.equal(loan.equipment.driverEvidence, null); assert.equal(loan.equipment.conditionEvidence, null);
  assert.equal(show.financialEvidence.length, 0); assert.equal(show.rentalExecutions?.length, 0);
});
test("unsigned, stale, changed and cross-supplier requests cannot enter the enrolled service", async () => {
  const session = await store.createSession(undefined, "supplier-auth:" + randomUUID());
  const body = { version: 1 as const, requestId: randomUUID(), tenantId: session.actor.tenantId, actorId: session.actor.id, action: { type: "quote" as const } };
  const path = "http://localhost:4105/api/enrolled-suppliers/brightline/rpc";
  const attempts = [
    new Request(path, { method: "POST", body: JSON.stringify(body) }),
    new Request(path, { method: "POST", body: JSON.stringify(body), headers: protocol.supplierHeaders("northside", body) }),
    new Request(path, { method: "POST", body: JSON.stringify(body), headers: protocol.supplierHeaders("brightline", body, "2020-01-01T00:00:00Z") }),
    new Request(path, { method: "POST", body: JSON.stringify({ ...body, requestId: randomUUID() }), headers: protocol.supplierHeaders("brightline", body) }),
  ];
  for (const request of attempts) assert.equal((await rpc.POST(request, { params: Promise.resolve({ supplier: "brightline" }) })).status, 401);
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_supplier_quotes WHERE tenant_id=$1", [session.actor.tenantId])).rows[0].count, 0);
});
test("lost quote responses resume the original service request identities without replacing partial offers", async () => {
  const session = await store.createSession(undefined, "supplier-partial:" + randomUUID());
  const show = await command(session.actor, { type: "load_incidents" }); const id = randomUUID();
  await rfq.beginSupplierRfq(session.actor, id, show.revision);
  const lost: typeof transport = async request => { const response = await transport(request); if (request.url.includes("northside")) throw new Error("Controlled lost response after supplier commit"); return response; };
  assert.equal((await rfq.collectSupplierRfq(session.actor.tenantId, id, AbortSignal.timeout(5000), lost)).status, "waiting");
  assert.ok((await store.getShow(session.actor.tenantId)).offers.every(offer => !offer.serviceQuote));
  assert.equal((await rfq.collectSupplierRfq(session.actor.tenantId, id, AbortSignal.timeout(5000), transport)).status, "complete");
  const current = await store.getShow(session.actor.tenantId);
  assert.equal(current.revision, show.revision + 1);
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_supplier_quotes WHERE tenant_id=$1", [session.actor.tenantId])).rows[0].count, 3);
  assert.equal((await database.pool.query("SELECT status FROM on_jobs WHERE tenant_id=$1 AND kind='supplier_rfq' AND semantic_key=$2", [session.actor.tenantId, id])).rows[0].status, "complete");
  assert.equal((await rfq.collectSupplierRfq(session.actor.tenantId, id, AbortSignal.timeout(5000), transport)).status, "complete");
  assert.equal((await store.getShow(session.actor.tenantId)).revision, current.revision);
});
test("a production revision during quote collection keeps new terms unapplied for review", async () => {
  const session = await store.createSession(undefined, "supplier-stale:" + randomUUID()); const id = randomUUID();
  await rfq.beginSupplierRfq(session.actor, id, session.show.revision);
  await command(session.actor, { type: "advance", time: "16:10" });
  const result = await rfq.collectSupplierRfq(session.actor.tenantId, id, AbortSignal.timeout(5000), transport);
  assert.deepEqual(result, { status: "needs_attention", code: "RFQ_PLAN_CHANGED" });
  assert.ok((await store.getShow(session.actor.tenantId)).offers.every(offer => !offer.serviceQuote));
});
test("concurrent identical hold deliveries produce one execution, one lease and one expiry job", async () => {
  const setup = await quoteSetup(); await approve(setup.actor); const body = await holdRequest(setup.actor);
  const replies = await Promise.all([0, 1, 2].map(() => protocol.callSupplierService("brightline", body, AbortSignal.timeout(5000), transport)));
  assert.ok(replies.every(reply => reply.kind === "execution"));
  assert.equal(new Set(replies.map(reply => reply.kind === "execution" && reply.execution.id)).size, 1);
  for (const table of ["on_resource_holds", "on_rental_executions"]) assert.equal((await database.pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE tenant_id=$1`, [setup.actor.tenantId])).rows[0].count, 1);
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_jobs WHERE tenant_id=$1 AND kind='supplier_expire'", [setup.actor.tenantId])).rows[0].count, 1);
  await assert.rejects(() => protocol.callSupplierService("brightline", { ...body, action: { ...body.action, planDigest: "0".repeat(64) } }, AbortSignal.timeout(5000), transport), errorCode("SUPPLIER_REQUEST_CONFLICT"));
});
test("another approved plan cannot reserve the same fixture unit during an overlapping hold", async () => {
  const setup = await holdSetup(); await approve(setup.actor);
  const body = await holdRequest(setup.actor);
  await assert.rejects(() => protocol.callSupplierService("brightline", body, AbortSignal.timeout(5000), transport), errorCode("UNIT_ALREADY_HELD"));
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_resource_holds WHERE tenant_id=$1", [setup.actor.tenantId])).rows[0].count, 1);
});
test("independent rehearsal networks can hold their own controlled copies without sharing capacity or identities", async () => {
  const first = await holdSetup(), second = await holdSetup();
  assert.notEqual(first.actor.tenantId, second.actor.tenantId); assert.notEqual(first.execution.id, second.execution.id); assert.equal(first.execution.unitId, second.execution.unitId);
  await assert.rejects(() => storage.readRentalExecution(database.pool, first.actor.tenantId, second.execution.id), errorCode("EXECUTION_NOT_FOUND"));
});
test("real hold expiry is durable and blocks new dispatch while the scenario clock remains unchanged", async () => {
  const setup = await holdSetup(); const before = await store.getShow(setup.actor.tenantId);
  await backdateHold(setup.actor, setup.execution.id); assert.equal((await service.expireSupplierHold(setup.actor.tenantId, setup.execution.id)).status, "complete");
  const after = await store.getShow(setup.actor.tenantId); assert.equal(after.clock, before.clock); assert.equal(after.rentalExecutions?.[0]?.state, "expired"); assert.equal(after.financialEvidence.length, 0);
  await assert.rejects(() => prepareRoot(setup.actor, setup.execution.id), errorCode("SUPPLIER_HOLD_EXPIRED"));
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_payment_intents WHERE tenant_id=$1", [setup.actor.tenantId])).rows[0].count, 0);
});
test("an authorization arriving after hold expiry is retained and never becomes confirmed supplier capacity", async () => {
  const setup = await holdSetup(); const root = await prepareRoot(setup.actor, setup.execution.id);
  await backdateHold(setup.actor, setup.execution.id); await service.expireSupplierHold(setup.actor.tenantId, setup.execution.id);
  const original = await recordAuthorization(setup.actor, setup.execution.id, root); const show = await store.getShow(setup.actor.tenantId);
  assert.equal(show.rentalExecutions?.[0]?.state, "reconfirmation_required"); assert.equal(uniqueActual(show)[0]?.providerResourceId, original.authorizationId); assert.equal(supplierIsConfirmed(show), false);
  await assert.rejects(() => protocol.callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: setup.actor.tenantId, actorId: setup.actor.id, action: { type: "confirm", executionId: setup.execution.id } }, AbortSignal.timeout(5000), transport), errorCode("HOLD_EXPIRED"));
  const result = await protocol.callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: setup.actor.tenantId, actorId: setup.actor.id, action: { type: "reconfirm", executionId: setup.execution.id } }, AbortSignal.timeout(5000), transport);
  assert.ok(result.kind === "execution" && result.execution.state === "confirmed");
  assert.equal((await store.getShow(setup.actor.tenantId)).financialEvidence.length, 1);
});
test("driver scan requires the current real-time signed code and never accepts condition or creates a fee", async () => {
  const setup = await confirmedSetup(); let show = await store.getShow(setup.actor.tenantId);
  const issued = await delivery.issueDelivery(setup.actor, setup.execution.id, randomUUID(), show.revision);
  await assert.rejects(() => delivery.scanDelivery(setup.driver, issued.token!, randomUUID()), errorCode("DELIVERY_NOT_DUE"));
  await assert.rejects(() => delivery.scanDelivery(setup.actor, issued.token!, randomUUID()), errorCode("ASSIGNED_DRIVER_REQUIRED"));
  await assert.rejects(() => delivery.scanDelivery(setup.driver, issued.token!.slice(0, -1) + (issued.token!.endsWith("a") ? "b" : "a"), randomUUID()), errorCode("DELIVERY_QR_INVALID"));
  await command(setup.actor, { type: "advance", time: "17:15" });
  const scanId = randomUUID(); const scanned = await delivery.scanDelivery(setup.driver, issued.token!, scanId);
  assert.equal(scanned.state, "scanned"); assert.equal((await delivery.scanDelivery(setup.driver, issued.token!, scanId)).id, scanned.id);
  await assert.rejects(() => delivery.scanDelivery(setup.driver, issued.token!, randomUUID()), errorCode("DELIVERY_QR_ALREADY_USED"));
  show = await store.getShow(setup.actor.tenantId); assert.equal(deliveryIsAccepted(show), false); assert.equal(show.financialEvidence.filter(item => item.kind === "capture").length, 0);
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_payment_intents WHERE tenant_id=$1 AND document->>'purpose'='rental_fee'", [setup.actor.tenantId])).rows[0].count, 0);
});
test("reissuing a lost handoff code revokes the old nonce and preserves issue idempotency", async () => {
  const setup = await confirmedSetup(); let show = await command(setup.actor, { type: "advance", time: "17:15" }); const id = randomUUID();
  const first = await delivery.issueDelivery(setup.actor, setup.execution.id, id, show.revision);
  const replay = await delivery.issueDelivery(setup.actor, setup.execution.id, id, show.revision); assert.equal(replay.token, null); assert.equal(replay.delivery?.version, first.delivery?.version);
  show = await store.getShow(setup.actor.tenantId); const second = await delivery.issueDelivery(setup.actor, setup.execution.id, randomUUID(), show.revision);
  assert.equal(second.delivery?.version, 2);
  await assert.rejects(() => delivery.scanDelivery(setup.driver, first.token!, randomUUID()), errorCode("DELIVERY_VERSION_CHANGED"));
  assert.equal((await delivery.scanDelivery(setup.driver, second.token!, randomUUID())).state, "scanned");
});
test("concurrent different scan identities consume the QR once", async () => {
  const setup = await confirmedSetup(); const show = await command(setup.actor, { type: "advance", time: "17:15" });
  const issued = await delivery.issueDelivery(setup.actor, setup.execution.id, randomUUID(), show.revision);
  const results = await Promise.allSettled([0, 1, 2].map(() => delivery.scanDelivery(setup.driver, issued.token!, randomUUID())));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await store.getShow(setup.actor.tenantId)).events.filter(event => event.type === "delivery.scanned").length, 1);
});
test("a validly signed but mismatched tenant, unit, delivery version or expiry remains unusable", async () => {
  const setup = await confirmedSetup(); const show = await command(setup.actor, { type: "advance", time: "17:15" });
  const issued = await delivery.issueDelivery(setup.actor, setup.execution.id, randomUUID(), show.revision); const content = tokens.verifyDeliveryToken(issued.token!);
  for (const changed of [{ unitId: "different-unit" }, { version: 99 }, { tenantId: randomUUID() }, { expiresAt: "2020-01-01T00:00:00Z" }]) {
    const { v: _version, nonce: _nonce, ...bound } = content; const altered = tokens.issueDeliveryToken({ ...bound, ...changed });
    await assert.rejects(() => delivery.scanDelivery(setup.driver, altered.token, randomUUID()));
  }
  assert.equal((await delivery.deliveryOverview(setup.driver, setup.execution.id)).delivery?.state, "issued");
});
test("only the assigned qualified lighting lead can accept the exact scanned handoff", async () => {
  const setup = await scannedSetup(); const show = await store.getShow(setup.actor.tenantId);
  const input = { executionId: setup.execution.id, deliveryId: setup.receipt.id, version: setup.receipt.version, commandId: randomUUID(), expectedRevision: show.revision, decision: "accept" as const, condition: { report: "Controlled power, accessories and safe-condition acceptance.", powerOn: true, accessories: true, safeCondition: true } };
  for (const actor of [setup.actor, setup.driver]) await assert.rejects(() => delivery.inspectDelivery(actor, input), errorCode("ASSIGNED_INSPECTOR_REQUIRED"));
  await assert.rejects(() => delivery.inspectDelivery({ ...setup.inspector, personId: "tom" }, input), errorCode("DELIVERY_SCOPE_REQUIRED"));
  await assert.rejects(() => delivery.inspectDelivery(setup.inspector, { ...input, condition: { ...input.condition, powerOn: false } }), errorCode("INSPECTION_INCOMPLETE"));
  assert.equal((await store.getShow(setup.actor.tenantId)).facts.filter(fact => fact.kind === "delivery_accepted").length, 0);
});
test("acceptance and the one existing approved nonfinal fee intent commit atomically under concurrent retries", async () => {
  const setup = await scannedSetup(); const show = await store.getShow(setup.actor.tenantId);
  const input = { executionId: setup.execution.id, deliveryId: setup.receipt.id, version: setup.receipt.version, commandId: randomUUID(), expectedRevision: show.revision, decision: "accept" as const, condition: { report: "Controlled console boots, accessories present and condition accepted.", powerOn: true, accessories: true, safeCondition: true } };
  const results = await Promise.all([0, 1].map(() => delivery.inspectDelivery(setup.inspector, input)));
  assert.ok(results.every(result => result.state === "accepted"));
  const after = await store.getShow(setup.actor.tenantId); assert.equal(deliveryIsAccepted(after), true); assert.equal(after.facts.filter(fact => fact.kind === "delivery_accepted").length, 1);
  const fees = (await payments.listIntents(setup.actor.tenantId)).filter(intent => intent.purpose === "rental_fee"); assert.equal(fees.length, 1);
  const fee = fees[0]!; assert.equal(fee.parentId, setup.root.id); assert.equal(fee.executionId, setup.execution.id); assert.equal(fee.approvedBy, setup.actor.id);
  assert.ok(fee.command.action.kind === "capture_authorization" && fee.command.action.finalCapture === false && fee.command.action.money.minor === 48000 && fee.command.action.authorizationId === setup.authorizationId);
  assert.equal(after.financialEvidence.filter(item => item.kind === "capture").length, 0);
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_jobs WHERE tenant_id=$1 AND kind='payment_reconcile' AND semantic_key=$2", [setup.actor.tenantId, fee.id])).rows[0].count, 1);
});
test("a failed durable fee insert rolls the acceptance and every related fact back", async () => {
  const setup = await scannedSetup(); const show = await store.getShow(setup.actor.tenantId);
  await database.pool.query(`CREATE FUNCTION reject_fixture_fee() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.document->>'purpose'='rental_fee' THEN RAISE EXCEPTION 'controlled insert failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_fixture_fee BEFORE INSERT ON on_payment_intents FOR EACH ROW EXECUTE FUNCTION reject_fixture_fee()`);
  const input = { executionId: setup.execution.id, deliveryId: setup.receipt.id, version: setup.receipt.version, commandId: randomUUID(), expectedRevision: show.revision, decision: "accept" as const, condition: { report: "Controlled accepted inspection for the rollback test.", powerOn: true, accessories: true, safeCondition: true } };
  try { await assert.rejects(() => delivery.inspectDelivery(setup.inspector, input)); }
  finally { await database.pool.query("DROP TRIGGER reject_fixture_fee ON on_payment_intents; DROP FUNCTION reject_fixture_fee()"); }
  const after = await store.getShow(setup.actor.tenantId); assert.equal(after.revision, show.revision); assert.equal(deliveryIsAccepted(after), false); assert.equal((await delivery.deliveryOverview(setup.inspector, setup.execution.id)).delivery?.state, "scanned");
  assert.equal((await delivery.inspectDelivery(setup.inspector, input)).state, "accepted");
});
test("rejecting condition creates an attributed blocker without a fee instruction", async () => {
  const setup = await scannedSetup(); const show = await store.getShow(setup.actor.tenantId);
  await delivery.inspectDelivery(setup.inspector, { executionId: setup.execution.id, deliveryId: setup.receipt.id, version: setup.receipt.version, commandId: randomUUID(), expectedRevision: show.revision, decision: "reject", condition: { report: "Controlled inspection rejected a damaged output connector.", powerOn: true, accessories: true, safeCondition: false } });
  const after = await store.getShow(setup.actor.tenantId); assert.equal(after.rentalExecutions?.[0]?.state, "needs_attention"); assert.equal(deliveryIsAccepted(after), false);
  assert.equal((await payments.listIntents(setup.actor.tenantId)).filter(intent => intent.purpose === "rental_fee").length, 0);
});
test("only the scoped supplier can receive a rejected unit before an uncaptured cancellation is approved", async () => {
  const setup = await scannedSetup(); let show = await store.getShow(setup.actor.tenantId);
  const supplierToken = await store.createSupplierCapability(setup.actor); const supplier = (await store.getActor(supplierToken))!;
  const request = { version: 1 as const, requestId: randomUUID(), tenantId: setup.actor.tenantId, actorId: supplier.id, action: { type: "return_rejected" as const, executionId: setup.execution.id, expectedRevision: show.revision, detail: "Controlled supplier received the rejected unit with its damaged connector recorded." } };
  await assert.rejects(() => protocol.callSupplierService("brightline", request, AbortSignal.timeout(5000), transport), errorCode("REJECTED_RETURN_REQUIRED"));
  await delivery.inspectDelivery(setup.inspector, { executionId: setup.execution.id, deliveryId: setup.receipt.id, version: setup.receipt.version, commandId: randomUUID(), expectedRevision: show.revision, decision: "reject", condition: { report: "Controlled inspection rejected a damaged output connector.", powerOn: true, accessories: true, safeCondition: false } });
  show = await store.getShow(setup.actor.tenantId); request.action.expectedRevision = show.revision;
  await assert.rejects(() => cancellation.approveRentalCancellation(setup.actor, setup.execution.id, randomUUID(), show.revision, "The unit must first be accounted for by the supplier."), errorCode("UNCAPTURED_CANCELLATION_REQUIRED"));
  await assert.rejects(() => protocol.callSupplierService("brightline", { ...request, actorId: setup.actor.id }, AbortSignal.timeout(5000), transport), errorCode("SUPPLIER_SCOPE_REQUIRED"));
  const result = await protocol.callSupplierService("brightline", request, AbortSignal.timeout(5000), transport);
  assert.ok(result.kind === "execution" && result.execution.state === "returned_unaccepted" && result.execution.rejectedReturn?.deliveryId === setup.receipt.id && result.execution.rejectedReturn.actorId === supplier.id);
  assert.deepEqual(await protocol.callSupplierService("brightline", request, AbortSignal.timeout(5000), transport), result);
  show = await store.getShow(setup.actor.tenantId);
  assert.equal(deliveryIsAccepted(show), false); assert.equal(show.facts.some(fact => fact.kind === "return_accepted"), false);
  assert.equal((await delivery.deliveryOverview(setup.inspector, setup.execution.id)).delivery?.state, "rejected");
  assert.equal((await payments.listIntents(setup.actor.tenantId)).filter(intent => intent.purpose === "rental_fee").length, 0);
  assert.equal((await database.pool.query("SELECT status FROM on_resource_holds WHERE id=$1", [setup.execution.id])).rows[0].status, "returned");
  await cancellation.approveRentalCancellation(setup.actor, setup.execution.id, randomUUID(), show.revision, "The rejected console is back with the supplier and its uncaptured authorization should be canceled.");
  const pending = (await payments.listIntents(setup.actor.tenantId)).filter(intent => intent.purpose === "rental_cancel"); assert.equal(pending.length, 1); assert.equal(pending[0]?.command.action.money.minor, 78000);
});
test("explicit uncaptured cancellation queues its own full780 void and preserves the original authorization", async () => {
  const setup = await confirmedSetup(); const show = await store.getShow(setup.actor.tenantId); const id = randomUUID(); const detail = "Controlled supplier cannot complete the original delivery window.";
  const cancelled = await cancellation.approveRentalCancellation(setup.actor, setup.execution.id, id, show.revision, detail);
  assert.equal(cancelled.rentalExecutions?.[0]?.state, "compensation_pending"); assert.equal(uniqueActual(cancelled)[0]?.providerResourceId, setup.authorizationId);
  await cancellation.approveRentalCancellation(setup.actor, setup.execution.id, id, show.revision, detail);
  const pending = (await payments.listIntents(setup.actor.tenantId)).filter(intent => intent.purpose === "rental_cancel"); assert.equal(pending.length, 1);
  assert.equal(pending[0]?.command.action.money.minor, 78000); assert.equal(pending[0]?.command.action.kind, "void_authorization"); assertPaymentAuthority(cancelled, pending[0]!);
  assert.equal(cancelled.financialEvidence.filter(item => item.kind === "refund" || item.kind === "void").length, 0);
});
test("a fee instruction, accepted delivery or historical480 capture excludes full-authorization cancellation", async () => {
  const setup = await scannedSetup(); const show = await store.getShow(setup.actor.tenantId);
  await assert.rejects(() => cancellation.approveRentalCancellation(setup.actor, setup.execution.id, randomUUID(), show.revision, "Controlled request must not cancel delivered equipment."), errorCode("UNCAPTURED_CANCELLATION_REQUIRED"));
  const other = await confirmedSetup();
  await storage.supplierTransaction(async client => { const current = await storage.lockSupplierShow(client, other.actor.tenantId); current.financialEvidence.push(evidence(current, { kind: "capture", purpose: "rental", parentId: other.authorizationId, amountMinor: 48000 })); await storage.saveSupplierSnapshot(client, current, other.actor.id, "fixture.capture", "Controlled historical capture fixture for cancellation exclusion."); });
  const current = await store.getShow(other.actor.tenantId);
  await assert.rejects(() => cancellation.approveRentalCancellation(other.actor, other.execution.id, randomUUID(), current.revision, "Controlled attempted cancellation of an already captured authorization."), errorCode("AUTHORIZATION_REVIEW_REQUIRED"));
  assert.equal((await payments.listIntents(other.actor.tenantId)).filter(intent => intent.purpose === "rental_cancel").length, 0);
});
test("confirmed cancellation withdraws current authorization while retaining historical gross evidence", async () => {
  const setup = await confirmedSetup(); const before = await store.getShow(setup.actor.tenantId);
  await cancellation.approveRentalCancellation(setup.actor, setup.execution.id, randomUUID(), before.revision, "Controlled cancellation after a missed supplier window.");
  const intent = (await payments.listIntents(setup.actor.tenantId)).find(item => item.purpose === "rental_cancel")!;
  await storage.supplierTransaction(async client => {
    const show = await storage.lockSupplierShow(client, setup.actor.tenantId);
    const confirmation = evidence(show, { kind: "void", purpose: "rental_cancel", amountMinor: 78000, providerResourceId: setup.authorizationId, parentId: setup.authorizationId });
    show.financialEvidence.push(confirmation); await projection.projectRentalPayment(client, show, intent, [confirmation]);
    await storage.saveSupplierSnapshot(client, show, setup.actor.id, "fixture.cancelled", "Controlled successful-void fixture; no provider request was made.");
  });
  const after = await store.getShow(setup.actor.tenantId);
  assert.equal(uniqueActual(after).filter(item => item.kind === "authorization").length, 1); assert.equal(currentActual(after).filter(item => item.kind === "authorization").length, 0); assert.equal(after.rentalExecutions?.[0]?.state, "cancelled"); assert.equal(supplierIsConfirmed(after), false);
});

test("renewing an expired unpaid hold retains its original checkout and creates no second payment", async () => {
  const setup = await holdSetup(); const root = await prepareRoot(setup.actor, setup.execution.id);
  await backdateHold(setup.actor, setup.execution.id); await service.expireSupplierHold(setup.actor.tenantId, setup.execution.id);
  const renewed = await protocol.callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: setup.actor.tenantId, actorId: setup.actor.id, action: { type: "reconfirm", executionId: setup.execution.id } }, AbortSignal.timeout(5000), transport);
  assert.ok(renewed.kind === "execution" && renewed.execution.state === "awaiting_payment" && renewed.execution.paymentRootId === root.id && Date.parse(renewed.execution.holdExpiresAt) > Date.now());
  assert.equal((await prepareRoot(setup.actor, setup.execution.id)).id, root.id);
  assert.equal((await payments.listIntents(setup.actor.tenantId)).length, 1);
  assert.equal(supplierIsConfirmed(await store.getShow(setup.actor.tenantId)), false);
});
test("the generated QR matrix round-trips through an independent pixel decoder", async () => {
  const setup = await confirmedSetup(); const show = await store.getShow(setup.actor.tenantId);
  const issued = await delivery.issueDelivery(setup.actor, setup.execution.id, randomUUID(), show.revision);
  const payload = "http://localhost:4105/delivery/access?execution=" + setup.execution.id + "#handoff=" + issued.token;
  const encoded = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const scale = 5, margin = 4, size = (encoded.modules.size + margin * 2) * scale; const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < encoded.modules.size; y++) for (let x = 0; x < encoded.modules.size; x++) if (encoded.modules.get(y, x)) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const index = (((y + margin) * scale + dy) * size + (x + margin) * scale + dx) * 4; pixels[index] = 0; pixels[index + 1] = 0; pixels[index + 2] = 0; }
  }
  const decoded = jsQR(pixels, size, size); assert.ok(decoded && decoded.data === payload);
});

async function wireFor(setup: Awaited<ReturnType<typeof confirmedSetup>>, options: { captureStatus?: string; authStatus?: string; loseVoid?: boolean } = {}) {
  const calls: { method: string; path: string; body: unknown; durable: boolean }[] = [];
  const auth = { id: setup.authorizationId, status: options.authStatus ?? "CREATED", amount: { currency_code: "USD", value: "780.00" } };
  const captures: { id: string; status: string; amount: { currency_code: string; value: string } }[] = options.captureStatus ? [{ id: "TEST-EXISTING-CAPTURE", status: options.captureStatus, amount: { currency_code: "USD", value: "480.00" } }] : [];
  const order = { id: setup.orderId, status: "COMPLETED", intent: "AUTHORIZE", purchase_units: [{ amount: auth.amount, custom_id: "on:" + setup.root.id, payments: { authorizations: [auth], captures, refunds: [] } }] };
  let blockReads = false;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Paypal-Debug-Id": "controlled-supplier-wire" } });
  const wire: typeof fetch = async input => {
    const request = input as Request; const path = new URL(request.url).pathname;
    if (path === "/v1/oauth2/token") return json({ access_token: "controlled-wire-token", token_type: "Bearer", expires_in: 3600 });
    const body = request.method === "GET" ? null : JSON.parse(await request.clone().text() || "null");
    const committed = request.method === "GET" ? null : await database.pool.query("SELECT status FROM paycore_operations WHERE provider_request_id=$1", [request.headers.get("PayPal-Request-Id")]);
    calls.push({ method: request.method, path, body, durable: request.method === "GET" || committed?.rows[0]?.status === "dispatching" });
    if (request.method === "GET" && blockReads) return json({ name: "SERVICE_UNAVAILABLE", details: [] }, 503);
    if (request.method === "GET" && path === "/v2/checkout/orders/" + setup.orderId) return json(order);
    if (request.method === "GET" && path === "/v2/payments/authorizations/" + setup.authorizationId) return json(auth);
    if (request.method === "POST" && path === "/v2/payments/authorizations/" + setup.authorizationId + "/capture") {
      const capture = { id: "TEST-NEW-CAPTURE-" + randomUUID(), status: "COMPLETED", amount: body.amount }; captures.push(capture); auth.status = "PARTIALLY_CAPTURED"; return json(capture, 201);
    }
    if (request.method === "POST" && path === "/v2/payments/authorizations/" + setup.authorizationId + "/void") {
      auth.status = "VOIDED";
      if (options.loseVoid) { blockReads = true; throw new TypeError("Controlled lost void response after provider fixture commit"); }
      return new Response(null, { status: 204 });
    }
    const capture = captures.find(value => path === "/v2/payments/captures/" + value.id); if (request.method === "GET" && capture) return json(capture);
    throw new Error("Unexpected SDK fixture request; no network fallback exists");
  };
  const paymentService = await import("../src/server/payment-service");
  paymentService.providers.brightline = new SandboxPayPalProvider({ environment: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com", isolatedProject: "supplier-wire-fixture", clientId: "supplier-wire-client", clientSecret: "supplier-wire-fixture-secret" }, wire);
  return { calls, paymentService, allowReads: () => { blockReads = false; } };
}
test("the actual SDK sends one480 nonfinal capture only after atomic signed acceptance", async () => {
  const setup = await scannedSetup(); const show = await store.getShow(setup.actor.tenantId); const wire = await wireFor(setup);
  await delivery.inspectDelivery(setup.inspector, { executionId: setup.execution.id, deliveryId: setup.receipt.id, version: setup.receipt.version, commandId: randomUUID(), expectedRevision: show.revision, decision: "accept", condition: { report: "Controlled accepted condition for the real SDK wire boundary.", powerOn: true, accessories: true, safeCondition: true } });
  assert.equal(wire.calls.length, 0);
  const fee = (await payments.listIntents(setup.actor.tenantId)).find(intent => intent.purpose === "rental_fee")!;
  assert.equal((await wire.paymentService.reconcilePaymentIntent(setup.actor.tenantId, fee.id, AbortSignal.timeout(5000), true)).status, "complete");
  assert.equal((await wire.paymentService.reconcilePaymentIntent(setup.actor.tenantId, fee.id, AbortSignal.timeout(5000), true)).status, "complete");
  const writes = wire.calls.filter(call => call.method === "POST"); assert.equal(writes.length, 1); assert.equal(writes[0]?.durable, true);
  assert.deepEqual(writes[0]?.body, { amount: { currency_code: "USD", value: "480.00" }, final_capture: false });
  assert.equal((await store.getShow(setup.actor.tenantId)).financialEvidence.filter(item => item.kind === "capture" && item.parentId === setup.authorizationId).length, 1);
});
test("fresh SDK reads block uncaptured cancellation when a captured or pending fee appears at the provider", async () => {
  for (const status of ["COMPLETED", "PENDING"]) {
    const setup = await confirmedSetup(); const show = await store.getShow(setup.actor.tenantId);
    await cancellation.approveRentalCancellation(setup.actor, setup.execution.id, randomUUID(), show.revision, "Controlled cancellation whose provider budget needs a fresh check.");
    const pending = (await payments.listIntents(setup.actor.tenantId)).find(intent => intent.purpose === "rental_cancel")!;
    const wire = await wireFor(setup, { captureStatus: status, authStatus: status === "COMPLETED" ? "PARTIALLY_CAPTURED" : "CREATED" });
    await assert.rejects(() => wire.paymentService.reconcilePaymentIntent(setup.actor.tenantId, pending.id, AbortSignal.timeout(5000), true), errorCode("UNCAPTURED_CANCELLATION_UNPROVEN"));
    assert.equal(wire.calls.filter(call => call.method === "POST").length, 0);
    assert.equal((await store.getShow(setup.actor.tenantId)).financialEvidence.filter(item => item.kind === "void").length, 0);
  }
});
test("a lost full-authorization void response reconciles the same intent without another write", async () => {
  const setup = await confirmedSetup(); const show = await store.getShow(setup.actor.tenantId);
  await cancellation.approveRentalCancellation(setup.actor, setup.execution.id, randomUUID(), show.revision, "Controlled uncaptured cancellation with an interrupted provider response.");
  const pending = (await payments.listIntents(setup.actor.tenantId)).find(intent => intent.purpose === "rental_cancel")!;
  const wire = await wireFor(setup, { loseVoid: true });
  assert.equal((await wire.paymentService.reconcilePaymentIntent(setup.actor.tenantId, pending.id, AbortSignal.timeout(5000), true)).status, "waiting");
  assert.equal((await store.getShow(setup.actor.tenantId)).rentalExecutions?.[0]?.state, "compensation_pending");
  wire.allowReads();
  assert.equal((await wire.paymentService.reconcilePaymentIntent(setup.actor.tenantId, pending.id, AbortSignal.timeout(5000), true)).status, "complete");
  const writes = wire.calls.filter(call => call.method === "POST"); assert.equal(writes.length, 1); assert.equal(writes[0]?.durable, true);
  const after = await store.getShow(setup.actor.tenantId); assert.equal(after.rentalExecutions?.[0]?.state, "cancelled");
  assert.equal(uniqueActual(after).find(item => item.kind === "authorization")?.amountMinor, 78000);
  assert.equal(uniqueActual(after).find(item => item.kind === "void")?.purpose, "rental_cancel");
  assert.equal(uniqueActual(after).find(item => item.kind === "void")?.amountMinor, 78000);
  assert.equal(after.financialEvidence.some(item => item.kind === "refund" || item.kind === "capture"), false);
});
test("an unauthenticated supplier response keeps RFQ review terminal despite another temporary outage", async () => {
  const session = await store.createSession(undefined, "rfq-failure-priority:" + randomUUID()); const show = await command(session.actor, { type: "load_incidents" });
  const id = randomUUID(); await rfq.beginSupplierRfq(session.actor, id, show.revision);
  const failingTransport: import("../src/server/supplier-protocol").SupplierTransport = async request => {
    const supplier = new URL(request.url).pathname.split("/").at(-2);
    if (supplier === "brightline") return Response.json({ code: "SUPPLIER_AUTH_REQUIRED", error: "Controlled fixture authentication failure." }, { status: 401 });
    if (supplier === "northside") return Response.json({ code: "SUPPLIER_UNAVAILABLE", error: "Controlled fixture temporary outage." }, { status: 503 });
    return transport(request);
  };
  const result = await rfq.collectSupplierRfq(session.actor.tenantId, id, AbortSignal.timeout(5000), failingTransport);
  assert.deepEqual(result, { status: "needs_attention", code: "SUPPLIER_AUTH_REQUIRED" });
  assert.equal((await rfq.supplierOverview(session.actor)).requests[0]?.status, "needs_review");
  assert.equal((await store.getShow(session.actor.tenantId)).offers.some(offer => offer.serviceQuote), false);
});
test("bounded signed HTTP rejects oversized streams and invalid UTF8 before any supplier record", async () => {
  const path = "http://localhost:4105/api/enrolled-suppliers/brightline/rpc";
  const context = { params: Promise.resolve({ supplier: "brightline" }) };
  const before = (await database.pool.query("SELECT count(*)::int AS count FROM on_supplier_requests")).rows[0].count;
  const oversized = await rpc.POST(new Request(path, { method: "POST", body: "x".repeat(9000) }), context); assert.equal(oversized.status, 413);
  const invalid = await rpc.POST(new Request(path, { method: "POST", body: Uint8Array.from([0x7b, 0xff, 0x7d]) }), context); assert.equal(invalid.status, 400);
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_supplier_requests")).rows[0].count, before);
});
test("a temporary supplier failure keeps the durable job retryable with a bounded future attempt", async () => {
  const session = await store.createSession(undefined, "supplier-job-retry:" + randomUUID()); const show = await store.getShow(session.actor.tenantId); const id = randomUUID();
  await rfq.beginSupplierRfq(session.actor, id, show.revision); await database.pool.query("UPDATE on_jobs SET run_after=now() WHERE tenant_id=$1", [session.actor.tenantId]);
  const { runJobTick } = await import("../src/server/job-runner");
  const result = await runJobTick({ tenantId: session.actor.tenantId, limit: 1, handler: async () => { throw new DomainError("SUPPLIER_UNAVAILABLE", "Controlled temporary service failure.", 503); } });
  assert.equal(result.results[0]?.status, "waiting");
  const job = (await database.pool.query("SELECT status,attempts,max_attempts,run_after FROM on_jobs WHERE tenant_id=$1", [session.actor.tenantId])).rows[0];
  assert.equal(job.status, "waiting"); assert.equal(job.attempts, 1); assert.ok(job.max_attempts <= 12); assert.ok(new Date(job.run_after).getTime() > Date.now());
});
test("delivery-only capabilities cannot use the general command route to sign unrelated production facts", async () => {
  const setup = await confirmedSetup(); const capability = await store.createDeliveryCapability(setup.actor, "inspector");
  const show = await store.getShow(setup.actor.tenantId); const route = await import("../src/app/api/show/route");
  const response = await route.POST(new Request("http://localhost:4105/api/show", { method: "POST", headers: { Origin: "http://localhost:4105", Authorization: "Bearer " + capability.token, "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: randomUUID(), expectedRevision: show.revision, command: { type: "fact", kind: "quiet_prep", detail: "A lighting-only inspector cannot sign the sound department's preparation." } }) }));
  assert.equal(response.status, 403); assert.equal((await response.json()).code, "SCOPED_CLIENT_REQUIRED");
  assert.equal((await store.getShow(setup.actor.tenantId)).revision, show.revision);
});
