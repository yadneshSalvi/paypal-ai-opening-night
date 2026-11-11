import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedDatabase } from "./isolated-database";
import { CommerceWire } from "./commerce-wire";

const database = await isolatedDatabase(), wire = new CommerceWire(database.pool);
(globalThis as typeof globalThis & { openingNightProviders?: unknown }).openingNightProviders = { venue: wire.provider(), brightline: wire.provider() };
const store = await import("../src/server/store"), payments = await import("../src/server/payment-store"), paymentService = await import("../src/server/payment-service");
const wallet = await import("../src/server/wallet-service"), walletStorage = await import("../src/server/wallet-storage");
const cohort = await import("../src/server/cohort-service"), storage = await import("../src/server/commerce-storage");
await payments.paymentStore(); after(async () => { await storage.closeCommerceLocks(); await database.close(); });
const signal = () => AbortSignal.timeout(10000);
const code = (value: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === value);
async function draft(mode: "saved_wallet" | "buyer_present" = "saved_wallet", origin = "http://localhost:4105") {
  const session = await store.createSession(undefined, "cohort-test:" + randomUUID()); let walletId: string | null = null;
  if (mode === "saved_wallet") {
    const setup = await wallet.beginWalletSetup(session.actor, randomUUID(), session.show.revision, origin);
    await wallet.runWalletSetup(session.actor.tenantId, setup.id, signal());
    const pending = await walletStorage.readWalletSetup(session.actor.tenantId, setup.id); wire.setups.get(pending.setupTokenId!)!.status = "APPROVED";
    await wallet.runWalletSetup(session.actor.tenantId, setup.id, signal()); walletId = (await walletStorage.readWalletSetup(session.actor.tenantId, setup.id)).savedWalletId;
  }
  const current = await store.getShow(session.actor.tenantId);
  const prepared = await cohort.draftCohort(session.actor, mode, walletId, current.revision, origin);
  const lines = (await database.pool.query<{ document: import("../src/server/commerce-storage").CohortTicketRecord }>("SELECT document FROM on_cohort_tickets WHERE tenant_id=$1 ORDER BY ordinal", [session.actor.tenantId])).rows.map(row => row.document);
  return { ...session, cohort: prepared, lines, walletId };
}
async function approved(mode: "saved_wallet" | "buyer_present" = "saved_wallet", origin = "http://localhost:4105") {
  const value = await draft(mode, origin); const current = await store.getShow(value.actor.tenantId);
  return { ...value, cohort: await cohort.approveCohort(value.actor, value.cohort.id, value.cohort.digest, current.revision, signal()) };
}
async function run(value: Awaited<ReturnType<typeof approved>>, index = 0) { return cohort.runCohortTicket(value.actor.tenantId, value.cohort.id, value.lines[index]!.id, signal()); }
async function view(value: Awaited<ReturnType<typeof approved>>) { return (await cohort.cohortOverview(value.actor.tenantId, await store.getShow(value.actor.tenantId)))!; }

test("a cohort draft fixes exactly80 immutable allocations without creating payments or sales", async () => {
  const value = await draft(); assert.equal(value.lines.length, 80); assert.equal(value.lines.filter(line => line.tier === "standard").length, 42); assert.equal(value.lines.filter(line => line.tier === "vip").length, 38);
  assert.equal(value.lines.reduce((sum, line) => sum + line.amountMinor, 0), 337000);
  assert.equal((await payments.listIntents(value.actor.tenantId)).length, 0); assert.equal((await store.getShow(value.actor.tenantId)).tickets.length, 0);
  const copy = await cohort.draftCohort(value.actor, "saved_wallet", value.walletId, 1, "http://localhost:4105"); assert.equal(copy.id, value.cohort.id); assert.equal(copy.ticketSetDigest, value.cohort.ticketSetDigest);
});
test("parallel approvals queue one bounded set and never buy merely by creating the draft", async () => {
  const value = await draft(); const current = await store.getShow(value.actor.tenantId), before = wire.writes("/v2/checkout/orders").length;
  const replies = await Promise.all([0, 1, 2].map(() => cohort.approveCohort(value.actor, value.cohort.id, value.cohort.digest, current.revision, signal())));
  assert.ok(replies.every(item => item.digest === replies[0]!.digest)); assert.equal(wire.writes("/v2/checkout/orders").length, before);
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_jobs WHERE tenant_id=$1 AND kind='cohort_ticket'", [value.actor.tenantId])).rows[0].count, 80);
  assert.equal(Date.parse(replies[0]!.expiresAt!) - Date.parse(replies[0]!.approvedAt!), 86400000);
});
test("one saved-wallet ticket uses exact independent consent and one stable order/capture pair", async () => {
  const value = await approved(); const before = wire.writes("/v2/checkout/orders").length;
  assert.equal((await run(value)).status, "complete"); assert.equal((await run(value)).status, "complete");
  const sent = wire.writes("/v2/checkout/orders").at(-1)!; assert.equal(wire.writes("/v2/checkout/orders").length, before + 1); assert.ok(sent.durable);
  assert.deepEqual(sent.body!.payment_source.paypal.stored_credential, { payment_initiator: "MERCHANT", usage_pattern: "IMMEDIATE", usage: "DERIVED" });
  assert.equal(sent.body!.purchase_units[0].amount.value, "35.00"); assert.equal(sent.body!.purchase_units[0].items.length, 1);
  assert.equal((await view(value)).capturedMinor, 3500); assert.equal((await view(value)).capturedCount, 1); assert.equal((await view(value)).reservedCount, 1);
  assert.equal((await payments.listIntents(value.actor.tenantId)).length, 2);
});
test("competing workers cannot dispatch the same logical ticket twice", async () => {
  const value = await approved(), before = wire.writes("/v2/checkout/orders").length;
  const results = await Promise.allSettled([0, 1, 2, 3].map(() => run(value)));
  assert.ok(results.some(result => result.status === "fulfilled")); assert.equal((await view(value)).capturedCount, 1); assert.equal(wire.writes("/v2/checkout/orders").length, before + 1);
});
test("an immediate create-order capture is imported without a second capture instruction", async () => {
  const value = await approved(); wire.immediateCapture = true; const capturesBefore = wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/capture")).length;
  try { assert.equal((await run(value)).status, "complete"); } finally { wire.immediateCapture = false; }
  assert.equal(wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/capture")).length, capturesBefore);
  assert.equal((await payments.listIntents(value.actor.tenantId)).length, 1); assert.equal((await view(value)).capturedCount, 1);
});
test("a lost order response pauses the cohort and permanently retains that ticket reservation", async () => {
  const value = await approved(); wire.failNext = "order_lost"; const before = wire.writes("/v2/checkout/orders").length;
  assert.equal((await run(value)).status, "waiting"); assert.equal((await view(value)).state, "paused");
  assert.deepEqual(await run(value, 1), { status: "waiting", code: "COHORT_PAUSED", delaySeconds: 300 });
  await run(value); assert.equal(wire.writes("/v2/checkout/orders").length, before + 1); assert.equal((await view(value)).reservedCount, 1); assert.equal((await view(value)).capturedCount, 0);
  await assert.rejects(() => cohort.resumeCohort(value.actor, value.cohort.id), code("COHORT_UNRESOLVED_TICKET"));
});
test("a lost capture response reconciles the original owned order and never repeats the capture", async () => {
  const value = await approved(); wire.failNext = "capture_lost"; const before = wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/capture")).length;
  assert.equal((await run(value)).status, "complete"); await run(value);
  assert.equal(wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/capture")).length, before + 1);
  assert.equal((await view(value)).capturedMinor, 3500);
});
test("revocation before work prevents even a new order and preserves the fixed ticket set", async () => {
  const value = await approved(), before = wire.writes("/v2/checkout/orders").length;
  await cohort.revokeCohort(value.actor, value.cohort.id); assert.equal((await run(value)).status, "needs_attention");
  assert.equal(wire.writes("/v2/checkout/orders").length, before); assert.equal((await payments.listIntents(value.actor.tenantId)).length, 0); assert.equal((await view(value)).state, "revoked");
});
test("revocation during the final token read stops a claimed operation before provider dispatch", async () => {
  const value = await approved(); let reads = 0; const before = wire.writes("/v2/checkout/orders").length;
  wire.before = async call => { if (call.method === "GET" && call.path.startsWith("/v3/vault/payment-tokens/") && ++reads === 2) await cohort.revokeCohort(value.actor, value.cohort.id); };
  try { assert.equal((await run(value)).status, "needs_attention"); } finally { wire.before = null; }
  assert.equal(wire.writes("/v2/checkout/orders").length, before); const intents = await payments.listIntents(value.actor.tenantId); assert.equal(intents.length, 1);
  const operation = await (await payments.paymentStore()).get(intents[0]!.command.scope, intents[0]!.id); assert.equal(operation?.status, "not_sent");
  assert.equal((await storage.readCohortTicket(value.actor.tenantId, value.lines[0]!.id)).dispatchAuthorizedAt, null);
});
test("an unavailable final wallet read recovers only its original expired claim before reviewed cohort continuation", async () => {
  const value = await approved(); let reads = 0; const before = wire.writes("/v2/checkout/orders").length;
  wire.immediateCapture = true;
  wire.before = async call => { if (call.method === "GET" && call.path.startsWith("/v3/vault/payment-tokens/") && ++reads === 2) wire.failNext = "token_unavailable"; };
  try { await assert.rejects(() => run(value), code("WALLET_RESPONSE_UNCERTAIN")); }
  finally { wire.before = null; }
  try {
    const line = await storage.readCohortTicket(value.actor.tenantId, value.lines[0]!.id);
    const intent = await payments.readIntent(value.actor.tenantId, line.rootIntentId!);
    const core = await payments.paymentStore(), claimed = (await core.get(intent.command.scope, intent.id))!;
    assert.equal(claimed.status, "claimed"); assert.equal(line.dispatchAuthorizedAt, null);
    assert.equal(wire.writes("/v2/checkout/orders").length, before);
    assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM paycore_attempts WHERE tenant_id=$1", [value.actor.tenantId])).rows[0].count, 0);
    assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_payment_bindings WHERE tenant_id=$1", [value.actor.tenantId])).rows[0].count, 0);
    assert.equal((await view(value)).state, "paused");
    await assert.rejects(() => cohort.resumeCohort(value.actor, value.cohort.id), code("COHORT_UNRESOLVED_TICKET"));
    assert.deepEqual(await paymentService.reconcilePaymentIntent(value.actor.tenantId, intent.id, signal(), true), { status: "waiting", code: "OPERATION_LEASE_ACTIVE", delaySeconds: 65 });
    assert.deepEqual(await run(value, 1), { status: "waiting", code: "COHORT_PAUSED", delaySeconds: 300 });
    await database.pool.query("UPDATE paycore_operations SET document=$2 WHERE tenant_id=$1 AND id=$3", [value.actor.tenantId, JSON.stringify({ ...claimed, leaseUntil: new Date(Date.now() - 1000).toISOString() }), intent.id]);
    assert.deepEqual(await paymentService.reconcilePaymentIntent(value.actor.tenantId, intent.id, signal(), false), { status: "waiting", code: "NOT_DISPATCHED", delaySeconds: 65 });
    assert.equal(wire.writes("/v2/checkout/orders").length, before);
    assert.equal((await run(value)).status, "complete");
    const recovered = (await core.get(intent.command.scope, intent.id))!;
    assert.equal(recovered.status, "succeeded"); assert.deepEqual(recovered.command, intent.command);
    assert.equal(wire.writes("/v2/checkout/orders").length, before + 1);
    assert.equal(wire.writes("/v2/checkout/orders").at(-1)!.requestId, intent.command.providerRequestId);
    assert.equal((await payments.listIntents(value.actor.tenantId)).length, 1);
    assert.equal((await view(value)).capturedCount, 1); assert.equal((await view(value)).state, "paused");
    await cohort.resumeCohort(value.actor, value.cohort.id);
    const resumed = await storage.readCohort(value.actor.tenantId, value.cohort.id);
    assert.equal(resumed.state, "approved"); assert.equal(resumed.digest, value.cohort.digest); assert.equal(resumed.expiresAt, value.cohort.expiresAt);
    assert.equal((await run(value)).status, "complete"); assert.equal(wire.writes("/v2/checkout/orders").length, before + 1);
  } finally { wire.immediateCapture = false; }
});
test("a previously authorized in-flight capture may finish after stop, while every unstarted line stays stopped", async () => {
  const value = await approved(); wire.immediateCapture = true;
  wire.before = async call => { if (call.method === "POST" && call.path === "/v2/checkout/orders") await cohort.revokeCohort(value.actor, value.cohort.id); };
  try { assert.equal((await run(value)).status, "complete"); } finally { wire.before = null; wire.immediateCapture = false; }
  assert.equal((await run(value, 1)).status, "needs_attention"); assert.equal((await view(value)).capturedCount, 1); assert.equal((await view(value)).state, "revoked");
  const line = await storage.readCohortTicket(value.actor.tenantId, value.lines[0]!.id), current = await storage.readCohort(value.actor.tenantId, value.cohort.id);
  assert.ok(line.dispatchAuthorizedAt); assert.ok(Date.parse(line.dispatchAuthorizedAt!) <= Date.parse(current.revokedAt!));
});
test("an expired cohort cannot extend its authority by restarting queued work", async () => {
  const value = await approved(); value.cohort.expiresAt = new Date(Date.now() - 1000).toISOString(); await storage.saveCohort(database.pool, value.cohort);
  const before = wire.writes("/v2/checkout/orders").length; assert.equal((await run(value)).status, "needs_attention"); assert.equal(wire.writes("/v2/checkout/orders").length, before);
  await assert.rejects(() => cohort.resumeCohort(value.actor, value.cohort.id), code("COHORT_CONSENT_EXPIRED"));
});
test("payer action pauses further tickets until the same original order settles and the operator resumes", async () => {
  const value = await approved(); wire.requirePayerApproval = true;
  try { assert.equal((await run(value)).status, "needs_attention"); } finally { wire.requirePayerApproval = false; }
  const publicView = await view(value); assert.equal(publicView.state, "paused"); assert.ok(publicView.lines[0]!.approvalUrl);
  const line = await storage.readCohortTicket(value.actor.tenantId, value.lines[0]!.id); const root = await payments.readIntent(value.actor.tenantId, line.rootIntentId!);
  const order = (await payments.ownedResources(value.actor.tenantId, "venue", root.id)).find(resource => resource.kind === "order")!; wire.orders.get(order.id)!.status = "APPROVED";
  assert.equal((await run(value)).status, "complete"); await cohort.resumeCohort(value.actor, value.cohort.id); assert.equal((await view(value)).state, "approved");
});
test("all80 verified captures sum to3370 and replay cannot create an81st logical ticket", async () => {
  const value = await approved(); wire.immediateCapture = true; const before = wire.writes("/v2/checkout/orders").length;
  try { for (let index = 0; index < 80; index++) assert.equal((await run(value, index)).status, "complete"); }
  finally { wire.immediateCapture = false; }
  const result = await view(value); assert.equal(result.state, "complete"); assert.equal(result.capturedCount, 80); assert.equal(result.capturedMinor, 337000); assert.equal(result.reservedCount, 80);
  for (let index = 0; index < 80; index++) assert.equal((await run(value, index)).status, "complete");
  assert.equal(wire.writes("/v2/checkout/orders").length, before + 80);
  const show = await store.getShow(value.actor.tenantId); assert.equal(new Set(show.tickets.map(ticket => ticket.captureId)).size, 80);
  await assert.rejects(() => cohort.runCohortTicket(value.actor.tenantId, value.cohort.id, randomUUID(), signal()), code("COHORT_TICKET_NOT_FOUND"));
});
test("the same bounded allocation supports individual buyer-present approvals without a Vault token", async () => {
  const value = await approved("buyer_present"); const beforeReads = wire.calls.filter(call => call.path.startsWith("/v3/vault/")).length;
  assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_jobs WHERE tenant_id=$1 AND kind='cohort_ticket'", [value.actor.tenantId])).rows[0].count, 0);
  await cohort.startIndividualCohortTicket(value.actor, value.cohort.id, value.lines[0]!.id);
  const sent = wire.writes("/v2/checkout/orders").at(-1)!; assert.equal(sent.body!.payment_source.paypal.vault_id, undefined); assert.equal((await view(value)).capturedCount, 0);
  const line = await storage.readCohortTicket(value.actor.tenantId, value.lines[0]!.id), root = await payments.readIntent(value.actor.tenantId, line.rootIntentId!);
  const order = (await payments.ownedResources(value.actor.tenantId, "venue", root.id)).find(resource => resource.kind === "order")!; wire.orders.get(order.id)!.status = "APPROVED";
  const result = await paymentService.handlePayment(value.actor, { type: "complete_checkout", intentId: root.id, state: paymentService.callbackState(root) }, "http://localhost:4105");
  assert.equal(result.status, "succeeded"); assert.equal((await view(value)).capturedCount, 1); assert.equal(wire.calls.filter(call => call.path.startsWith("/v3/vault/")).length, beforeReads);
});
test("a pending immediate capture pauses the run and is read back without a second capture command", async () => {
  const value = await approved(); wire.immediateCapture = true; wire.immediateCaptureStatus = "PENDING";
  const before = wire.writes("/v2/checkout/orders").length, captures = wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/capture")).length;
  try { assert.equal((await run(value)).status, "waiting"); } finally { wire.immediateCapture = false; wire.immediateCaptureStatus = "COMPLETED"; }
  assert.equal((await view(value)).capturedCount, 0); assert.equal((await view(value)).state, "paused");
  assert.equal((await run(value, 1)).status, "waiting"); assert.equal(wire.writes("/v2/checkout/orders").length, before + 1);
  const line = await storage.readCohortTicket(value.actor.tenantId, value.lines[0]!.id);
  const order = (await payments.ownedResources(value.actor.tenantId, "venue", line.rootIntentId!)).find(resource => resource.kind === "order")!;
  wire.orders.get(order.id)!.purchase_units[0].payments.captures[0].status = "COMPLETED";
  assert.equal((await run(value)).status, "complete"); assert.equal((await view(value)).capturedCount, 1);
  assert.equal(wire.calls.filter(call => call.method === "POST" && call.path.endsWith("/capture")).length, captures);
  await cohort.resumeCohort(value.actor, value.cohort.id); assert.equal((await view(value)).state, "approved");
});
test("a changed logical-ticket document cannot bypass its immutable price allocation", async () => {
  const value = await approved(), line = value.lines[0]!, before = wire.writes("/v2/checkout/orders").length;
  await database.pool.query("UPDATE on_cohort_tickets SET document=jsonb_set(document,'{amountMinor}','5000'::jsonb) WHERE tenant_id=$1 AND id=$2", [value.actor.tenantId, line.id]);
  await assert.rejects(() => run(value), code("COHORT_LINE_MISMATCH"));
  assert.equal(wire.writes("/v2/checkout/orders").length, before);
});
test("a pre-reservation origin failure resumes only after configuration is fixed and retains exact consent", async () => {
  const originalOrigin = process.env.NEXT_PUBLIC_APP_URL, origin = "https://controlled-checkout-fixture.vercel.app";
  process.env.NEXT_PUBLIC_APP_URL = origin;
  try {
    const value = await approved("saved_wallet", origin), before = wire.writes("/v2/checkout/orders").length;
    const consent = structuredClone(value.cohort), ids = value.lines.map(line => line.id);
    delete process.env.NEXT_PUBLIC_APP_URL;
    await assert.rejects(() => run(value), code("CHECKOUT_ORIGIN"));
    const paused = await storage.readCohort(value.actor.tenantId, value.cohort.id), line = await storage.readCohortTicket(value.actor.tenantId, value.lines[0]!.id);
    assert.equal(paused.state, "paused"); assert.equal(line.rootIntentId, null); assert.equal(line.captureIntentId, null);
    assert.equal(line.reservedAt, null); assert.equal(line.dispatchAuthorizedAt, null); assert.equal((await payments.listIntents(value.actor.tenantId)).length, 0);
    await database.pool.query("UPDATE on_jobs SET status='needs_attention',attempts=max_attempts,last_code='CHECKOUT_ORIGIN' WHERE tenant_id=$1 AND semantic_key=$2", [value.actor.tenantId, line.id]);
    await assert.rejects(() => cohort.resumeCohort(value.actor, value.cohort.id), code("CHECKOUT_ORIGIN"));
    process.env.NEXT_PUBLIC_APP_URL = origin;
    const resumed = await cohort.resumeCohort(value.actor, value.cohort.id);
    assert.equal(resumed.state, "approved"); assert.equal(resumed.pauseTicketId, null); assert.equal(resumed.pauseCode, null);
    for (const field of ["id", "digest", "ticketSetDigest", "reviewDigest", "approvedBy", "approvedAt", "expiresAt", "version", "origin", "terms"] as const) assert.deepEqual(resumed[field], consent[field]);
    assert.deepEqual((await database.pool.query("SELECT id FROM on_cohort_tickets WHERE tenant_id=$1 ORDER BY ordinal", [value.actor.tenantId])).rows.map(row => row.id), ids);
    assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM on_jobs WHERE tenant_id=$1 AND kind='cohort_ticket' AND status='queued'", [value.actor.tenantId])).rows[0].count, 80);
    assert.equal(wire.writes("/v2/checkout/orders").length, before); assert.equal((await payments.listIntents(value.actor.tenantId)).length, 0);
    assert.equal((await run(value)).status, "complete"); assert.equal((await run(value)).status, "complete");
    assert.equal(wire.writes("/v2/checkout/orders").length, before + 1);
  } finally { if (originalOrigin === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = originalOrigin; }
});
test("resume refuses every durable trace of an unresolved ticket, including incomplete row projections", async t => {
  for (const kind of ["reserved_at", "dispatch_authorized", "root_column", "orphan_intent", "orphan_operation"] as const) await t.test(kind, async () => {
    const value = await approved(), line = value.lines[0]!;
    const policy = await import("../src/server/commerce-policy");
    await policy.pauseCohortTicket(value.actor.tenantId, value.cohort.id, line.id, "COHORT_READBACK_REQUIRED");
    if (kind === "reserved_at" || kind === "dispatch_authorized") {
      const current = await storage.readCohortTicket(value.actor.tenantId, line.id);
      if (kind === "reserved_at") current.reservedAt = new Date().toISOString(); else current.dispatchAuthorizedAt = new Date().toISOString();
      await storage.saveCohortTicket(database.pool, current);
    } else if (kind === "root_column") await database.pool.query("UPDATE on_cohort_tickets SET root_intent_id=$3 WHERE tenant_id=$1 AND id=$2", [value.actor.tenantId, line.id, randomUUID()]);
    else if (kind === "orphan_intent") await database.pool.query("INSERT INTO on_payment_intents(id,tenant_id,seller,semantic_key,document) VALUES($1,$2,'venue',$3,$4)", [randomUUID(), value.actor.tenantId, "ticket:" + line.id + ":order", { ticketId: line.id }]);
    else await database.pool.query("INSERT INTO paycore_operations(id,tenant_id,project_id,business_key,provider_request_id,payload_hash,status,version,amount_minor,document) VALUES($1,$2,'opening-night:venue',$3,$4,$5,'not_sent',1,3500,'{}')", [randomUUID(), value.actor.tenantId, "ticket:" + line.id + ":order", randomUUID(), "a".repeat(64)]);
    const before = wire.writes("/v2/checkout/orders").length;
    await assert.rejects(() => cohort.resumeCohort(value.actor, value.cohort.id), code("COHORT_UNRESOLVED_TICKET"));
    assert.equal((await storage.readCohort(value.actor.tenantId, value.cohort.id)).state, "paused");
    assert.equal(wire.writes("/v2/checkout/orders").length, before);
  });
});
test("a reserved original ticket with no core operation resumes without changing any payment identity", async () => {
  const originalOrigin = process.env.NEXT_PUBLIC_APP_URL, origin = "https://controlled-retained-origin.vercel.app";
  process.env.NEXT_PUBLIC_APP_URL = origin;
  try {
    const value = await approved("saved_wallet", origin), before = wire.writes("/v2/checkout/orders").length;
    wire.before = async call => { if (call.method === "GET" && call.path.startsWith("/v3/vault/payment-tokens/")) delete process.env.NEXT_PUBLIC_APP_URL; };
    await assert.rejects(() => run(value), code("CHECKOUT_ORIGIN")); wire.before = null;
    const line = await storage.readCohortTicket(value.actor.tenantId, value.lines[0]!.id);
    assert.ok(line.rootIntentId); assert.ok(line.reservedAt); assert.equal(line.dispatchAuthorizedAt, null);
    const original = await payments.readIntent(value.actor.tenantId, line.rootIntentId);
    assert.equal(await (await payments.paymentStore()).get(original.command.scope, original.id), null);
    assert.equal(wire.writes("/v2/checkout/orders").length, before);
    process.env.NEXT_PUBLIC_APP_URL = origin;
    const resumed = await cohort.resumeCohort(value.actor, value.cohort.id);
    assert.equal(resumed.expiresAt, value.cohort.expiresAt); assert.equal(resumed.digest, value.cohort.digest);
    assert.deepEqual(await payments.readIntent(value.actor.tenantId, original.id), original);
    assert.deepEqual(await storage.readCohortTicket(value.actor.tenantId, line.id), line);
    assert.equal((await run(value)).status, "complete"); assert.equal((await run(value)).status, "complete");
    assert.equal(wire.writes("/v2/checkout/orders").length, before + 1);
    assert.equal(wire.writes("/v2/checkout/orders").at(-1)!.requestId, original.command.providerRequestId);
    assert.equal((await storage.readCohortTicket(value.actor.tenantId, line.id)).rootIntentId, original.id);
  } finally { wire.before = null; if (originalOrigin === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = originalOrigin; }
});
test("an unstarted ticket cannot resume after its approving actor or wallet is revoked", async t => {
  for (const revoked of ["actor", "wallet"] as const) await t.test(revoked, async () => {
    const value = await approved();
    const policy = await import("../src/server/commerce-policy");
    await policy.pauseCohortTicket(value.actor.tenantId, value.cohort.id, value.lines[0]!.id, "CHECKOUT_ORIGIN");
    if (revoked === "actor") await database.pool.query("UPDATE on_sessions SET expires_at=now()-interval '1 second' WHERE tenant_id=$1", [value.actor.tenantId]);
    else await database.pool.query("UPDATE on_saved_wallets SET document=jsonb_set(document,'{active}','false') WHERE tenant_id=$1", [value.actor.tenantId]);
    await assert.rejects(() => cohort.resumeCohort(value.actor, value.cohort.id), code(revoked === "actor" ? "COMMERCE_AUTHORITY_EXPIRED" : "WALLET_AUTHORITY_REVOKED"));
    assert.equal((await storage.readCohort(value.actor.tenantId, value.cohort.id)).state, "paused");
  });
});
