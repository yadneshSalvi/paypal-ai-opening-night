/** Real PostgreSQL + SDK/verifier transport fixtures. No external provider qualification. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { PayPalWebhookVerifier, SandboxPayPalProvider, payloadHash, type ProviderResource, type ProviderReceipt } from "@fracture/paypal-core";
import { isolatedDatabase } from "./isolated-database";
import { digest } from "../src/domain/hash";
import type { PaymentIntent } from "../src/domain/payment-authority";
import type { FinancialObservation } from "../src/domain/contracts";
import type { Job } from "../src/server/jobs";

const db = await isolatedDatabase(); const pool = db.pool;
const { createSession, getShow } = await import("../src/server/store");
const { enqueueJob, claimJob, finishJob, listJobs } = await import("../src/server/jobs");
const { paymentStore, paymentTransaction, importPaymentOperation } = await import("../src/server/payment-store");
const { ingestPaymentWebhook, readWebhookBody, parsePaymentWebhook, paymentEventTypes } = await import("../src/server/payment-webhooks");
const { recordPaymentObservations } = await import("../src/server/payment-observations");
const { requestFinancialCheck } = await import("../src/server/payment-checks");
const { authorizeWorker } = await import("../src/server/worker-auth");
const requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
const resources = new Map<string, Record<string, unknown>>();
let loseCreate = false; let sequence = 0;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const wire: typeof fetch = async input => {
  const request = input as Request; const path = new URL(request.url).pathname;
  const body = request.method === "GET" ? null : await request.clone().text();
  requests.push({ method: request.method, path, body: body && path !== "/v1/oauth2/token" ? JSON.parse(body) : null });
  if (path === "/v1/oauth2/token") return json({ access_token: "local-fixture-token", token_type: "Bearer", expires_in: 3600 });
  if (path === "/v1/notifications/verify-webhook-signature") return json({ verification_status: "SUCCESS" });
  if (request.method === "GET" && resources.has(path)) return json(resources.get(path));
  if (request.method === "POST" && path === "/v2/checkout/orders") {
    const id = "FIXTURE-ORDER-" + ++sequence; const payload = JSON.parse(body!);
    const order = { id, status: "CREATED", intent: payload.intent, purchase_units: payload.purchase_units, links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=" + id, method: "GET", rel: "payer-action" }] };
    resources.set(path + "/" + id, order);
    const committed = await pool.query("SELECT status FROM paycore_operations WHERE provider_request_id=$1", [request.headers.get("PayPal-Request-Id")]); assert.equal(committed.rows[0]?.status, "dispatching");
    const savedWork = await pool.query("SELECT count(*)::int AS count FROM on_jobs WHERE kind='payment_reconcile' AND payload->>'intentId'=$1", [payload.purchase_units[0].custom_id.slice(3)]); assert.equal(savedWork.rows[0]?.count, 1);
    if (loseCreate) { loseCreate = false; throw new TypeError("Local fixture lost a dispatched create response"); } return json(order, 201);
  }
  return json({ name: "RESOURCE_NOT_FOUND", message: "Isolated fixture resource missing" }, 404);
};
const provider = (seller: string) => new SandboxPayPalProvider({ environment: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com", isolatedProject: "fixture:" + seller, clientId: "fixture-client-" + seller, clientSecret: "fixture-secret" }, wire);
(globalThis as typeof globalThis & { openingNightProviders?: unknown }).openingNightProviders = { venue: provider("venue"), brightline: provider("brightline") };
const { handlePayment, reconcilePaymentIntent } = await import("../src/server/payment-service");
const { runJobTick } = await import("../src/server/job-runner");
const admission = "test:durable:" + randomUUID();
after(async () => { await db.close(); });
const signatureHeaders = () => new Headers({ "paypal-transmission-id": "fixture-transmission-" + randomUUID(), "paypal-transmission-time": "2026-11-11T12:00:00Z", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/FIXTURE", "paypal-auth-algo": "SHA256withRSA", "paypal-transmission-sig": "fixture-signature" });
const verifier = new PayPalWebhookVerifier({ environment: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com", isolatedProject: "fixture:webhook", clientId: "fixture-webhook-client", clientSecret: "fixture-secret" }, "FIXTURE-REGISTERED-ID", wire);
const boundary = { verifier, transport: "local_fixture" as const };
const newSession = () => createSession(undefined, admission);
async function seedRoot() {
  await paymentStore(); const session = await newSession(); const id = randomUUID(); const ticketId = randomUUID();
  const action = { kind: "create_order" as const, intent: "CAPTURE" as const, money: { currency: "USD", minor: 5000 }, customId: "on:" + id };
  const intent: PaymentIntent = { id, tenantId: session.actor.tenantId, seller: "venue", purpose: "ticket_order", semanticKey: "ticket:" + ticketId + ":order", planVersion: 1, planDigest: null, parentId: null, ticketId, resourceIds: [], approvedBy: session.actor.id, createdAt: new Date().toISOString(), feeMinor: 0, depositMinor: 0, tier: "vip", command: { scope: { tenantId: session.actor.tenantId, projectId: "opening-night:venue" }, operationId: id, businessKey: "ticket:" + ticketId + ":order", intentId: id, providerRequestId: randomUUID(), payloadHash: payloadHash(action), action, approval: { id: "approval:" + id, version: 1, digest: digest(action), expiresAt: new Date(Date.now() + 3600000).toISOString() } } };
  await pool.query("INSERT INTO on_payment_intents(id,tenant_id,seller,semantic_key,document) VALUES($1,$2,$3,$4,$5)", [id, intent.tenantId, intent.seller, intent.semanticKey, intent]);
  return { ...session, intent };
}
async function bind(intent: PaymentIntent, kind: ProviderResource["kind"], id: string) { await pool.query("INSERT INTO on_payment_bindings(seller,kind,provider_id,tenant_id,root_intent_id) VALUES($1,$2,$3,$4,$5)", [intent.seller, kind, id, intent.tenantId, intent.id]); }
const eventBody = (id: string, captureId: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture", resource: { id: captureId, status: "COMPLETED", ...extra } });

test("PostgreSQL claims one concurrent owner and rejects changed job payloads", async () => {
  const { actor } = await newSession(); const spec = { tenantId: actor.tenantId, kind: "payment_reconcile" as const, semanticKey: "unique", payload: { intentId: randomUUID() } };
  const jobs = await Promise.all(Array.from({ length: 8 }, () => paymentTransaction(client => enqueueJob(client, spec))));
  assert.equal(new Set(jobs.map(job => job.id)).size, 1);
  await assert.rejects(paymentTransaction(client => enqueueJob(client, { ...spec, payload: { intentId: randomUUID() } })), /different instructions/);
  const claims = await Promise.all(Array.from({ length: 8 }, () => claimJob(actor.tenantId))); assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await finishJob(claims.find(Boolean)!, { status: "complete" }), true); assert.equal(await claimJob(actor.tenantId), null);
});
test("a killed worker leaves a claim that a restarted worker can fence safely", async () => {
  const { actor } = await newSession(); await paymentTransaction(client => enqueueJob(client, { tenantId: actor.tenantId, kind: "payment_reconcile", semanticKey: "crash", payload: { intentId: randomUUID() } }));
  const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/claim-worker.ts", db.schema, actor.tenantId], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const claimed = await new Promise<Job>((resolve, reject) => {
    let output = ""; const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Fixture worker did not claim in time")); }, 10000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.stdout.on("data", data => { output += data.toString(); if (output.includes("\n")) { clearTimeout(timeout); resolve(JSON.parse(output.split("\n")[0]!)); } });
    child.on("exit", code => { if (!output.includes("\n")) { clearTimeout(timeout); reject(new Error("Fixture worker exited before its claim: " + code)); } });
  });
  const stopped = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await stopped;
  assert.ok(claimed.leaseId); assert.equal((await listJobs(actor.tenantId))[0]!.status, "running");
  await pool.query("UPDATE on_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [claimed.id]);
  const restarted = await claimJob(actor.tenantId); assert.ok(restarted); assert.notEqual(restarted.leaseId, claimed.leaseId); assert.equal(restarted.attempts, 2);
  assert.equal(await finishJob(claimed, { status: "complete" }), false); assert.equal(await finishJob(restarted, { status: "complete" }), true);
});
test("backoff has a finite attention boundary and cannot be bypassed by another tick", async () => {
  const { actor } = await newSession(); await paymentTransaction(client => enqueueJob(client, { tenantId: actor.tenantId, kind: "payment_reconcile", semanticKey: "bounded", payload: { intentId: randomUUID() }, maxAttempts: 1 }));
  const result = await runJobTick({ tenantId: actor.tenantId, handler: async () => ({ status: "waiting", code: "PROVIDER_OUTCOME_UNKNOWN" }) });
  assert.equal(result.results[0]!.status, "needs_attention"); assert.equal((await listJobs(actor.tenantId))[0]!.lastCode, "ATTEMPT_LIMIT"); assert.equal(await claimJob(actor.tenantId), null);
});
test("an aborted transaction cannot leave a detached wakeup", async () => {
  const { actor } = await newSession(); await assert.rejects(paymentTransaction(async client => { await enqueueJob(client, { tenantId: actor.tenantId, kind: "payment_reconcile", semanticKey: "rollback", payload: { intentId: randomUUID() } }); throw new Error("fixture rollback"); }), /rollback/);
  assert.equal((await listJobs(actor.tenantId)).length, 0);
});
test("a slow preceding read cannot consume the next purchase's execution allowance", async t => {
  const { actor } = await newSession();
  for (const semanticKey of ["first-read", "next-original-purchase"]) await paymentTransaction(client => enqueueJob(client, {
    tenantId: actor.tenantId, kind: "payment_reconcile", semanticKey, payload: { intentId: randomUUID() },
  }));
  const now = Date.now(); let elapsed = 0;
  const clock = t.mock.method(Date, "now", () => now + elapsed);
  const tick = await runJobTick({ tenantId: actor.tenantId, limit: 8, budgetMs: 45000, handler: async () => {
    elapsed = 24000; return { status: "complete" };
  } });
  clock.mock.restore();
  assert.equal(tick.processed, 1);
  const remaining = (await listJobs(actor.tenantId)).find(job => job.status === "queued");
  assert.ok(remaining); assert.equal(remaining.attempts, 0); assert.equal(remaining.leaseId, null);
  const next = await runJobTick({ tenantId: actor.tenantId, limit: 1, handler: async () => ({ status: "complete" }) });
  assert.equal(next.results[0]?.id, remaining.id); assert.equal(next.results[0]?.status, "complete");
});
test("a paused cohort holds unrelated tickets without spending their retry allowance", async () => {
  const { actor } = await newSession(); const cohortId = randomUUID(), original = randomUUID(), held = randomUUID();
  await pool.query("INSERT INTO on_ticket_cohorts(id,tenant_id,document) VALUES($1,$2,$3)",
    [cohortId, actor.tenantId, { state: "paused", pauseTicketId: original }]);
  const other = await paymentTransaction(client => enqueueJob(client, { tenantId: actor.tenantId, kind: "cohort_ticket", semanticKey: held, payload: { cohortId, ticketId: held } }));
  const recovering = await paymentTransaction(client => enqueueJob(client, { tenantId: actor.tenantId, kind: "cohort_ticket", semanticKey: original, payload: { cohortId, ticketId: original } }));
  const tick = await runJobTick({ tenantId: actor.tenantId, handler: async () => ({ status: "complete" }) });
  assert.deepEqual(tick.results.map(job => job.id), [recovering.id]);
  const preserved = (await listJobs(actor.tenantId)).find(job => job.id === other.id)!;
  assert.equal(preserved.status, "queued"); assert.equal(preserved.attempts, 0); assert.equal(preserved.leaseId, null);
  await pool.query("UPDATE on_ticket_cohorts SET document=$2 WHERE id=$1", [cohortId, { state: "approved", pauseTicketId: null }]);
  const resumed = await runJobTick({ tenantId: actor.tenantId, handler: async () => ({ status: "complete" }) });
  assert.deepEqual(resumed.results.map(job => job.id), [other.id]);
});
test("the real verifier receives exact signature postback fields and fixture provenance stays separate", async () => {
  const { intent } = await seedRoot(); const capture = "CAPTURE-" + randomUUID(); await bind(intent, "capture", capture);
  const raw = eventBody("EVENT-" + randomUUID(), capture); const headers = signatureHeaders();
  const result = await ingestPaymentWebhook("venue", raw, headers, boundary); assert.equal(result.accepted, true);
  const postback = requests.findLast(request => request.path.endsWith("verify-webhook-signature"))!.body!;
  assert.deepEqual(Object.keys(postback).sort(), ["auth_algo", "cert_url", "transmission_id", "transmission_sig", "transmission_time", "webhook_event", "webhook_id"].sort());
  assert.equal(postback.webhook_id, "FIXTURE-REGISTERED-ID"); assert.deepEqual(postback.webhook_event, JSON.parse(raw));
  const audit = await pool.query("SELECT document FROM paycore_webhook_deliveries WHERE event_id=$1", [JSON.parse(raw).id]); const document = JSON.parse(audit.rows[0].document);
  assert.equal(document.verified, true); assert.equal(document.source, "sample"); assert.equal(JSON.stringify(document).includes("fixture-signature"), false);
  const inbox = await pool.query("SELECT transport FROM on_webhook_inbox WHERE event_id=$1", [JSON.parse(raw).id]); assert.equal(inbox.rows[0].transport, "local_fixture");
});
test("unsigned or malicious-certificate deliveries do not enter the app inbox", async () => {
  const raw = eventBody("EVENT-" + randomUUID(), "UNKNOWN-CAPTURE"); const before = requests.length;
  await assert.rejects(ingestPaymentWebhook("venue", raw, new Headers(), boundary), /signature/);
  const headers = signatureHeaders(); headers.set("paypal-cert-url", "https://attacker.invalid/v1/notifications/certs/a");
  await assert.rejects(ingestPaymentWebhook("venue", raw, headers, boundary), /signature/);
  assert.equal(requests.length, before); assert.equal((await pool.query("SELECT 1 FROM on_webhook_inbox WHERE event_id=$1", [JSON.parse(raw).id])).rowCount, 0);
});
test("duplicate deliveries enqueue once, conflicting payloads are rejected", async () => {
  const { intent } = await seedRoot(); const capture = "CAPTURE-" + randomUUID(); await bind(intent, "capture", capture); const id = "EVENT-" + randomUUID(); const raw = eventBody(id, capture);
  await Promise.all(Array.from({ length: 6 }, () => ingestPaymentWebhook("venue", raw, signatureHeaders(), boundary)));
  assert.equal((await listJobs(intent.tenantId)).length, 1);
  await assert.rejects(ingestPaymentWebhook("venue", eventBody(id, capture, { status: "REVERSED" }), signatureHeaders(), boundary), /different body/);
  assert.equal((await listJobs(intent.tenantId)).length, 1);
});
test("a duplicate delivery repairs the crash gap after core audit commit", async () => {
  const { intent } = await seedRoot(); const capture = "CAPTURE-" + randomUUID(); await bind(intent, "capture", capture); const raw = eventBody("EVENT-" + randomUUID(), capture);
  await ingestPaymentWebhook("venue", raw, signatureHeaders(), boundary);
  await paymentTransaction(async client => { await client.query("DELETE FROM on_jobs WHERE tenant_id=$1", [intent.tenantId]); await client.query("DELETE FROM on_webhook_inbox WHERE event_id=$1", [JSON.parse(raw).id]); });
  const repaired = await ingestPaymentWebhook("venue", raw, signatureHeaders(), boundary); assert.equal(repaired.duplicate, true); assert.equal(repaired.accepted, true); assert.equal((await listJobs(intent.tenantId)).length, 1);
});
test("foreign merchants, unknown resources, and conflicting owned hints cannot schedule payment work", async () => {
  const one = await seedRoot(); const two = await seedRoot(); const first = "CAPTURE-" + randomUUID(); const second = "ORDER-" + randomUUID(); await bind(one.intent, "capture", first); await bind(two.intent, "order", second);
  assert.equal((await ingestPaymentWebhook("brightline", eventBody("EVENT-" + randomUUID(), first), signatureHeaders(), boundary)).status, "unmatched");
  assert.equal((await ingestPaymentWebhook("venue", eventBody("EVENT-" + randomUUID(), "UNKNOWN-RESOURCE"), signatureHeaders(), boundary)).status, "unmatched");
  const mixed = eventBody("EVENT-" + randomUUID(), first, { supplementary_data: { related_ids: { order_id: second } } });
  assert.equal((await ingestPaymentWebhook("venue", mixed, signatureHeaders(), boundary)).status, "conflict");
  assert.equal((await listJobs(one.intent.tenantId)).length, 0); assert.equal((await listJobs(two.intent.tenantId)).length, 0);
});
test("the explicit v2 event catalog handles refund resources without treating them as captures", () => {
  for (const type of ["PAYMENT.CAPTURE.DECLINED", "PAYMENT.REFUND.PENDING", "PAYMENT.REFUND.FAILED", "CHECKOUT.PAYMENT-APPROVAL.REVERSED"]) assert.equal(paymentEventTypes.has(type), true);
  const parsed = parsePaymentWebhook(JSON.stringify({ id: "EVENT-REFUND", event_type: "PAYMENT.CAPTURE.REFUNDED", resource_type: "refund", resource: { id: "REFUND-ONE", supplementary_data: { related_ids: { capture_id: "CAPTURE-ONE" } } } }));
  assert.deepEqual(parsed?.resources, [{ kind: "refund", id: "REFUND-ONE" }, { kind: "capture", id: "CAPTURE-ONE" }]);
  assert.equal(parsePaymentWebhook(JSON.stringify({ id: "EVENT-WRONG", event_type: "PAYMENT.REFUND.FAILED", resource_type: "authorization", resource: { id: "AUTH-ONE" } })), null);
});
test("unsupported signed events are audited without a job or false provider success", async () => {
  const result = await ingestPaymentWebhook("venue", JSON.stringify({ id: "EVENT-" + randomUUID(), event_type: "BILLING.UNKNOWN.NEW", resource: { id: "UNKNOWN" } }), signatureHeaders(), boundary);
  assert.equal(result.accepted, false); assert.equal(result.status, "unsupported");
});
test("streamed webhook intake bounds bytes, encoding and content type", async () => {
  await assert.rejects(readWebhookBody(new Request("http://localhost/webhook", { method: "POST", body: "{}" })), /JSON/);
  await assert.rejects(readWebhookBody(new Request("http://localhost/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(1048577) })), /limit/);
  await assert.rejects(readWebhookBody(new Request("http://localhost/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: new Uint8Array([0xff]) })), /UTF-8/);
  assert.equal(await readWebhookBody(new Request("http://localhost/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })), "{}");
});
test("worker authorization fails closed and never accepts a capability substring", () => {
  const previous = process.env.CRON_SECRET; process.env.CRON_SECRET = "fixture-".repeat(8);
  try { assert.doesNotThrow(() => authorizeWorker(new Request("http://localhost/tick", { headers: { Authorization: "Bearer " + process.env.CRON_SECRET } }))); assert.throws(() => authorizeWorker(new Request("http://localhost/tick", { headers: { Authorization: "Bearer " + process.env.CRON_SECRET!.slice(1) } })), /capability/); delete process.env.CRON_SECRET; assert.throws(() => authorizeWorker(new Request("http://localhost/tick")), /enabled/); }
  finally { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous; }
});
test("a prepared payment and expired undispatched claim resume with the original durable identity", async () => {
  for (const claimed of [false, true]) {
    const { intent } = await seedRoot(); await paymentTransaction(client => enqueueJob(client, { tenantId: intent.tenantId, kind: "payment_reconcile", semanticKey: intent.id, payload: { intentId: intent.id } }));
    if (claimed) { const store = await paymentStore(); const old = await store.claim(intent.command); const document = { ...old.operation, leaseUntil: new Date(Date.now() - 1000).toISOString() }; await pool.query("UPDATE paycore_operations SET document=$2 WHERE id=$1", [intent.id, JSON.stringify(document)]); }
    const before = requests.filter(r => r.method === "POST" && r.path === "/v2/checkout/orders").length;
    const result = await runJobTick({ tenantId: intent.tenantId }); assert.equal(result.results[0]!.status, "complete");
    assert.equal(requests.filter(r => r.method === "POST" && r.path === "/v2/checkout/orders").length, before + 1);
    const operation = await (await paymentStore()).get(intent.command.scope, intent.id); assert.equal(operation?.command.providerRequestId, intent.command.providerRequestId); assert.equal(operation?.status, "succeeded");
  }
});
test("read-only webhook reconciliation never dispatches a prepared payment", async () => {
  const { intent } = await seedRoot(); const before = requests.length;
  assert.deepEqual(await reconcilePaymentIntent(intent.tenantId, intent.id, AbortSignal.timeout(5000), false), { status: "needs_attention", code: "NOT_DISPATCHED" }); assert.equal(requests.length, before);
});
test("a lost create response remains reserved through repeated worker checks without another POST", async () => {
  const { actor, show } = await newSession(); loseCreate = true;
  const operation = await handlePayment(actor, { type: "ticket_checkout", expectedRevision: show.revision, ticketId: randomUUID(), tier: "vip" }, "http://localhost:4105");
  assert.equal(operation.status, "pending_reconciliation"); const before = requests.filter(r => r.method === "POST" && r.path === "/v2/checkout/orders").length;
  for (let index = 0; index < 3; index++) { await pool.query("UPDATE on_jobs SET run_after=now() WHERE tenant_id=$1", [actor.tenantId]); const tick = await runJobTick({ tenantId: actor.tenantId }); assert.equal(tick.results[0]!.status, "waiting"); }
  assert.equal(requests.filter(r => r.method === "POST" && r.path === "/v2/checkout/orders").length, before);
  assert.equal((await getShow(actor.tenantId)).tickets.length, 0);
});
test("stale observations cannot overwrite a fresh adverse read and fixture reads cannot reverse it", async () => {
  const { intent } = await seedRoot(); await bind(intent, "capture", "OBSERVED-CAPTURE");
  const base = (overrides: Partial<FinancialObservation>): FinancialObservation => ({ id: randomUUID(), seller: "venue", kind: "capture", providerResourceId: "OBSERVED-CAPTURE", status: "REVERSED", amountMinor: 5000, currency: "USD", parentId: null, observedAt: "2026-11-11T12:00:00Z", transport: "paypal_https", ...overrides });
  await recordPaymentObservations(intent, [base({})]); await recordPaymentObservations(intent, [base({ status: "COMPLETED", observedAt: "2026-11-11T11:59:00Z" })]); await recordPaymentObservations(intent, [base({ status: "COMPLETED", transport: "local_fixture", observedAt: "2026-11-11T12:01:00Z" })]);
  const show = await getShow(intent.tenantId); assert.equal(show.financialObservations?.find(item => item.transport === "paypal_https")?.status, "REVERSED");
  await assert.rejects(recordPaymentObservations(intent, [base({ providerResourceId: "FOREIGN-CAPTURE" })]), /owned set/);
});
test("tenant-scoped manual work cannot claim another production's queued job", async () => {
  const first = await newSession(); const second = await newSession(); await paymentTransaction(client => enqueueJob(client, { tenantId: first.actor.tenantId, kind: "payment_reconcile", semanticKey: "tenant-test", payload: { intentId: randomUUID() } }));
  assert.equal((await runJobTick({ tenantId: second.actor.tenantId, handler: async () => ({ status: "complete" }) })).processed, 0); assert.equal((await listJobs(first.actor.tenantId))[0]!.status, "queued");
});

test("a signed wakeup reconciles a pending refund by exact order membership without another money write", async () => {
  const { intent } = await seedRoot(); const orderId = "READ-ORDER-" + randomUUID(); const captureId = "READ-CAPTURE-" + randomUUID(); const refundId = "READ-REFUND-" + randomUUID();
  const resource = (kind: ProviderResource["kind"], id: string, status: string, minor: number | null, parentId: string | null, customId: string | null = null): ProviderResource => ({ kind, id, status, money: minor === null ? null : { currency: "USD", minor }, parentId, customId, observedAt: new Date().toISOString(), source: "live_sandbox", links: [] });
  const store = await paymentStore(); const claimedRoot = (await store.claim(intent.command)).operation;
  const rootResources = [resource("order", orderId, "COMPLETED", null, null), resource("capture", captureId, "COMPLETED", 5000, orderId)];
  const receipt = (operationId: string, requestId: string, rows: ProviderResource[]): ProviderReceipt => ({ id: randomUUID(), operationId, providerRequestId: requestId, resources: rows, status: 201, transport: "apimatic_sdk", source: "live_sandbox", observedAt: new Date().toISOString(), bodyHash: digest(rows), debugId: "fixture-only", reconciled: false });
  const succeeded = await store.transition(intent.command.scope, intent.id, claimedRoot.version, "succeeded", receipt(intent.id, intent.command.providerRequestId, rootResources), null);
  await importPaymentOperation(intent, succeeded);
  const id = randomUUID(); const action = { kind: "refund_capture" as const, orderId, captureId, money: { currency: "USD", minor: 1500 } };
  const refund: PaymentIntent = { ...intent, id, purpose: "vip_refund", parentId: intent.id, semanticKey: "ticket:" + intent.ticketId + ":vip-remedy", resourceIds: [orderId, captureId], command: { ...intent.command, operationId: id, intentId: id, businessKey: "ticket:" + intent.ticketId + ":vip-remedy", providerRequestId: randomUUID(), payloadHash: payloadHash(action), action } };
  await pool.query("INSERT INTO on_payment_intents(id,tenant_id,seller,semantic_key,document) VALUES($1,$2,$3,$4,$5)", [id, intent.tenantId, intent.seller, refund.semanticKey, refund]);
  const pending = (await store.claim(refund.command)).operation;
  await store.transition(refund.command.scope, id, pending.version, "pending_reconciliation", receipt(id, refund.command.providerRequestId, [resource("refund", refundId, "PENDING", 1500, captureId, id)]), null);
  const captureWire = { id: captureId, status: "PARTIALLY_REFUNDED", amount: { currency_code: "USD", value: "50.00" } };
  const refundWire = { id: refundId, status: "COMPLETED", amount: { currency_code: "USD", value: "15.00" }, custom_id: id };
  const orderRefund = { ...refundWire, custom_id: "another-operation" };
  resources.set("/v2/checkout/orders/" + orderId, { id: orderId, status: "COMPLETED", intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "50.00" }, payments: { captures: [captureWire], refunds: [orderRefund] } }] });
  resources.set("/v2/payments/captures/" + captureId, captureWire); resources.set("/v2/payments/refunds/" + refundId, refundWire);
  const eventId = "EVENT-" + randomUUID(); const raw = JSON.stringify({ id: eventId, event_type: "PAYMENT.CAPTURE.REFUNDED", resource_type: "refund", resource: { id: refundId, custom_id: id, supplementary_data: { related_ids: { capture_id: captureId, order_id: orderId } } } });
  await ingestPaymentWebhook("venue", raw, signatureHeaders(), boundary); const before = requests.filter(request => request.method === "POST" && request.path.startsWith("/v2/")).length;
  const unproven = await runJobTick({ tenantId: intent.tenantId }); assert.equal(unproven.results[0]!.status, "waiting"); assert.equal((await getShow(intent.tenantId)).financialEvidence.filter(item => item.kind === "refund").length, 0);
  orderRefund.custom_id = id; await pool.query("UPDATE on_jobs SET run_after=now() WHERE tenant_id=$1", [intent.tenantId]);
  const result = await runJobTick({ tenantId: intent.tenantId }); assert.equal(result.results[0]!.status, "complete");
  const show = await getShow(intent.tenantId); const remedy = show.financialEvidence.find(item => item.kind === "refund"); assert.equal(remedy?.parentId, captureId); assert.equal(remedy?.amountMinor, 1500); assert.equal(show.tickets[0]!.refundedMinor, 1500);
  assert.equal(requests.filter(request => request.method === "POST" && request.path.startsWith("/v2/")).length, before);
  assert.equal((await pool.query("SELECT status FROM on_webhook_inbox WHERE event_id=$1", [eventId])).rows[0].status, "processed");
  const durableReadback = await pool.query("SELECT readback FROM on_payment_imports WHERE operation_id=$1", [id]); assert.equal(durableReadback.rows[0]?.readback.orderId, orderId);
  const revision = show.revision; await reconcilePaymentIntent(intent.tenantId, refund.id, AbortSignal.timeout(5000), false); assert.equal((await getShow(intent.tenantId)).revision, revision);
  const duplicate = await ingestPaymentWebhook("venue", raw, signatureHeaders(), boundary); assert.equal(duplicate.status, "processed"); assert.equal((await runJobTick({ tenantId: intent.tenantId })).processed, 0);
});
test("expired original payment approval blocks durable recovery before provider dispatch", async () => {
  const { intent } = await seedRoot(); intent.command.approval.expiresAt = new Date(Date.now() - 1000).toISOString();
  await pool.query("UPDATE on_payment_intents SET document=$2 WHERE id=$1", [intent.id, intent]);
  await paymentTransaction(client => enqueueJob(client, { tenantId: intent.tenantId, kind: "payment_reconcile", semanticKey: intent.id, payload: { intentId: intent.id } }));
  const before = requests.length; const result = await runJobTick({ tenantId: intent.tenantId }); assert.equal(result.results[0]!.status, "needs_attention"); assert.equal(requests.length, before); assert.equal((await listJobs(intent.tenantId))[0]!.lastCode, "APPROVAL_EXPIRED");
});

test("lost capture response requires exact owned-order child readback before one ticket is imported", async () => {
  const { intent } = await seedRoot(); const orderId = "ORDER-" + randomUUID(); const captureId = "CAPTURE-" + randomUUID(); await bind(intent, "order", orderId);
  const id = randomUUID(); const action = { kind: "capture_order" as const, orderId, money: { currency: "USD", minor: 5000 } };
  const child: PaymentIntent = { ...intent, id, purpose: "ticket_capture", parentId: intent.id, semanticKey: intent.id + ":capture", resourceIds: [orderId], command: { ...intent.command, operationId: id, intentId: id, businessKey: intent.id + ":capture", providerRequestId: randomUUID(), payloadHash: payloadHash(action), action } };
  await pool.query("INSERT INTO on_payment_intents(id,tenant_id,seller,semantic_key,document) VALUES($1,$2,$3,$4,$5)", [id, child.tenantId, child.seller, child.semanticKey, child]);
  const store = await paymentStore(); const claimed = (await store.claim(child.command)).operation; await store.transition(child.command.scope, id, claimed.version, "pending_reconciliation", null, { kind: "connection", message: "Controlled lost response", httpStatus: 202 });
  const capture = { id: captureId, status: "COMPLETED", amount: { currency_code: "USD", value: "50.00" } };
  resources.set("/v2/checkout/orders/" + orderId, { id: orderId, status: "COMPLETED", intent: "CAPTURE", purchase_units: [{ amount: capture.amount, payments: { captures: [capture] } }] }); resources.set("/v2/payments/captures/" + captureId, capture);
  const before = requests.filter(request => request.method === "POST" && request.path.startsWith("/v2/")).length;
  assert.deepEqual(await reconcilePaymentIntent(intent.tenantId, id, AbortSignal.timeout(5000), false), { status: "complete" });
  const show = await getShow(intent.tenantId); assert.equal(show.tickets.length, 1); assert.equal(show.tickets[0]!.captureId, captureId); assert.equal(show.financialEvidence[0]!.parentId, orderId);
  assert.equal((await store.get(child.command.scope, id))?.receipt?.resources.find(item => item.kind === "capture")?.parentId, null);
  assert.equal(requests.filter(request => request.method === "POST" && request.path.startsWith("/v2/")).length, before);
});

test("an early unmatched webhook is atomically rebound when its owned receipt arrives, including concurrent intake", async () => {
  for (const concurrent of [false, true, true, true]) {
    const { intent } = await seedRoot(); const orderId = "EARLY-ORDER-" + randomUUID(); const eventId = "EARLY-EVENT-" + randomUUID();
    const raw = JSON.stringify({ id: eventId, event_type: "CHECKOUT.ORDER.APPROVED", resource_type: "checkout-order", resource: { id: orderId } });
    const store = await paymentStore(); const claimed = (await store.claim(intent.command)).operation;
    const resource: ProviderResource = { kind: "order", id: orderId, status: "CREATED", money: null, parentId: null, customId: null, observedAt: new Date().toISOString(), source: "live_sandbox", links: [] };
    const receipt: ProviderReceipt = { id: randomUUID(), operationId: intent.id, providerRequestId: intent.command.providerRequestId, resources: [resource], status: 201, transport: "apimatic_sdk", source: "live_sandbox", observedAt: new Date().toISOString(), bodyHash: digest(resource), debugId: "fixture-only", reconciled: false };
    const operation = await store.transition(intent.command.scope, intent.id, claimed.version, "succeeded", receipt, null);
    if (concurrent) await Promise.all([ingestPaymentWebhook("venue", raw, signatureHeaders(), boundary), importPaymentOperation(intent, operation)]);
    else { assert.equal((await ingestPaymentWebhook("venue", raw, signatureHeaders(), boundary)).status, "unmatched"); await importPaymentOperation(intent, operation); }
    const inbox = await pool.query("SELECT status,tenant_id FROM on_webhook_inbox WHERE event_id=$1", [eventId]); assert.equal(inbox.rows[0].status, "queued"); assert.equal(inbox.rows[0].tenant_id, intent.tenantId); assert.equal((await listJobs(intent.tenantId)).length, 1);
  }
});
test("an early custom-id wakeup waits for a provider binding without dispatching the prepared order", async () => {
  const { intent } = await seedRoot(); const raw = JSON.stringify({ id: "EVENT-" + randomUUID(), event_type: "CHECKOUT.ORDER.APPROVED", resource_type: "checkout-order", resource: { id: "EARLY-" + randomUUID(), purchase_units: [{ custom_id: "on:" + intent.id }] } });
  assert.equal((await ingestPaymentWebhook("venue", raw, signatureHeaders(), boundary)).status, "queued");
  const before = requests.filter(request => request.method === "POST" && request.path.startsWith("/v2/")).length;
  const tick = await runJobTick({ tenantId: intent.tenantId }); assert.equal(tick.results[0]!.status, "waiting"); assert.equal((await listJobs(intent.tenantId))[0]!.lastCode, "RESOURCE_BINDING_REQUIRED");
  assert.equal(requests.filter(request => request.method === "POST" && request.path.startsWith("/v2/")).length, before);
});
test("an older in-flight resource read cannot clear a newer reconciliation requirement", async () => {
  const { intent } = await seedRoot(); const capture = "CHECK-CAPTURE-" + randomUUID(); await bind(intent, "capture", capture);
  const event = parsePaymentWebhook(JSON.stringify({ id: "CHECK-EVENT-" + randomUUID(), event_type: "PAYMENT.CAPTURE.REVERSED", resource_type: "capture", resource: { id: capture } }))!;
  await paymentTransaction(client => requestFinancialCheck(client, intent.tenantId, "venue", event, "local_fixture"));
  const checked = await getShow(intent.tenantId); const check = checked.financialChecks![0]!;
  const observation: FinancialObservation = { id: randomUUID(), seller: "venue", kind: "capture", providerResourceId: capture, status: "COMPLETED", amountMinor: 5000, currency: "USD", parentId: null, observedAt: new Date(Date.now() + 1000).toISOString(), transport: "local_fixture", readRevision: check.revision - 1 };
  await recordPaymentObservations(intent, [observation]); assert.equal((await getShow(intent.tenantId)).financialChecks![0]!.status, "pending");
  await recordPaymentObservations(intent, [{ ...observation, id: randomUUID(), observedAt: new Date(Date.now() + 2000).toISOString(), readRevision: (await getShow(intent.tenantId)).revision }]);
  assert.equal((await getShow(intent.tenantId)).financialChecks![0]!.status, "resolved");
});
test("receipt-driven rebinding preserves an adverse check and both append-only events", async () => {
  const { intent } = await seedRoot(); const orderId = "LATE-ORDER-" + randomUUID(); const captureId = "LATE-CAPTURE-" + randomUUID(); const eventId = "LATE-EVENT-" + randomUUID();
  const raw = JSON.stringify({ id: eventId, event_type: "PAYMENT.CAPTURE.PENDING", resource_type: "capture", resource: { id: captureId, supplementary_data: { related_ids: { order_id: orderId } } } });
  assert.equal((await ingestPaymentWebhook("venue", raw, signatureHeaders(), boundary)).status, "unmatched");
  const rows: ProviderResource[] = [{ kind: "order", id: orderId, status: "COMPLETED", money: null, parentId: null, customId: null, observedAt: new Date().toISOString(), source: "live_sandbox", links: [] }, { kind: "capture", id: captureId, status: "COMPLETED", money: { currency: "USD", minor: 5000 }, parentId: orderId, customId: null, observedAt: new Date().toISOString(), source: "live_sandbox", links: [] }];
  const store = await paymentStore(); const claimed = (await store.claim(intent.command)).operation;
  const receipt: ProviderReceipt = { id: randomUUID(), operationId: intent.id, providerRequestId: intent.command.providerRequestId, resources: rows, status: 201, transport: "apimatic_sdk", source: "live_sandbox", observedAt: new Date().toISOString(), bodyHash: digest(rows), debugId: "fixture-only", reconciled: false };
  await importPaymentOperation(intent, await store.transition(intent.command.scope, intent.id, claimed.version, "succeeded", receipt, null));
  const show = await getShow(intent.tenantId); assert.equal(show.revision, 3); assert.equal(show.tickets.length, 1); assert.equal(show.financialChecks?.[0]?.status, "pending");
  assert.deepEqual(show.events.map(event => event.revision), [1, 2, 3]); assert.equal((await pool.query("SELECT count(*)::int AS count FROM on_events WHERE tenant_id=$1", [intent.tenantId])).rows[0].count, 3);
});
