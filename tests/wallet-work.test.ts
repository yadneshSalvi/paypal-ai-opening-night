import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedDatabase } from "./isolated-database";
import { CommerceWire } from "./commerce-wire";

const database = await isolatedDatabase(); const wire = new CommerceWire(database.pool);
(globalThis as typeof globalThis & { openingNightProviders?: unknown }).openingNightProviders = { venue: wire.provider(), brightline: wire.provider() };
const store = await import("../src/server/store"); const payments = await import("../src/server/payment-store");
const wallet = await import("../src/server/wallet-service"), storage = await import("../src/server/wallet-storage"), locks = await import("../src/server/commerce-storage");
await payments.paymentStore();
after(async () => { await locks.closeCommerceLocks(); await database.close(); });
const code = (value: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === value);
async function start() {
  const session = await store.createSession(undefined, "wallet-test:" + randomUUID());
  const setup = await wallet.beginWalletSetup(session.actor, randomUUID(), session.show.revision, "http://localhost:4105");
  return { ...session, setup };
}
async function approvalRequired() {
  const value = await start();
  assert.equal((await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000))).status, "waiting");
  const current = await storage.readWalletSetup(value.actor.tenantId, value.setup.id);
  return { ...value, setup: current };
}
async function ready() {
  const value = await approvalRequired(); wire.setups.get(value.setup.setupTokenId!)!.status = "APPROVED";
  assert.equal((await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000))).status, "complete");
  const current = await storage.readWalletSetup(value.actor.tenantId, value.setup.id); return { ...value, setup: current, saved: await storage.readSavedWallet(value.actor.tenantId, current.savedWalletId!) };
}
test("wallet save commits one immutable SDK instruction and never creates a ticket charge", async () => {
  const value = await start(); const before = wire.writes("/v3/vault/setup-tokens").length;
  assert.equal((await payments.listIntents(value.actor.tenantId)).length, 0);
  await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000));
  const sent = wire.writes("/v3/vault/setup-tokens").at(-1)!;
  assert.equal(wire.writes("/v3/vault/setup-tokens").length, before + 1); assert.equal(sent.durable, true);
  assert.ok(sent.requestId); assert.ok(sent.sdkIdempotencyKey); assert.notEqual(sent.requestId, sent.sdkIdempotencyKey);
  assert.deepEqual(Object.keys(sent.body!).sort(), ["customer", "payment_source"]);
  const paypal = sent.body!.payment_source.paypal;
  assert.equal(paypal.usage_pattern, "IMMEDIATE"); assert.equal(paypal.usage_type, "MERCHANT"); assert.equal(paypal.customer_type, "CONSUMER"); assert.equal(paypal.permit_multiple_payment_tokens, false);
  assert.equal(paypal.experience_context.shipping_preference, "NO_SHIPPING"); assert.equal(paypal.experience_context.user_action, "CONTINUE");
  assert.match(paypal.description, /no charge/); assert.match(paypal.experience_context.return_url, /^http:\/\/localhost:4105\/wallet\/return\?/);
  assert.equal((await store.getShow(value.actor.tenantId)).financialEvidence.length, 0);
});
test("parallel setup and worker requests retain one save identity and one provider create", async () => {
  const value = await start();
  const copies = await Promise.all([0, 1, 2].map(() => wallet.beginWalletSetup(value.actor, randomUUID(), value.show.revision, "http://localhost:4105")));
  assert.ok(copies.every(copy => copy.id === value.setup.id)); const before = wire.writes("/v3/vault/setup-tokens").length;
  const results = await Promise.allSettled([0, 1, 2].map(() => wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000))));
  assert.ok(results.some(result => result.status === "fulfilled"));
  assert.equal(wire.writes("/v3/vault/setup-tokens").length, before + 1);
});
test("approved setup exchanges once, verifies its customer, and exposes only a local wallet identity", async () => {
  const value = await ready(); const converted = wire.writes("/v3/vault/payment-tokens").at(-1)!;
  assert.deepEqual(converted.body, { payment_source: { token: { id: value.setup.setupTokenId, type: "SETUP_TOKEN" } } }); assert.equal(converted.durable, true);
  await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000));
  const view = await wallet.walletOverview(value.actor.tenantId); assert.equal(view?.status, "ready"); assert.equal(view?.walletId, value.saved.id);
  const encoded = JSON.stringify(view); for (const secret of [value.saved.tokenId, value.saved.customerId!, value.saved.merchantCustomerId, value.saved.payerHash!]) assert.equal(encoded.includes(secret), false);
  assert.equal((await payments.listIntents(value.actor.tenantId)).length, 0);
});
test("foreign tenants and forged return states fail before exchange", async () => {
  const value = await approvalRequired(), foreign = await store.createSession(undefined, "wallet-foreign:" + randomUUID());
  await assert.rejects(() => wallet.walletReturn(foreign.actor, value.setup.id, wallet.walletCallbackState(value.setup), false), code("WALLET_SETUP_NOT_FOUND"));
  await assert.rejects(() => wallet.walletReturn(value.actor, value.setup.id, "x".repeat(43), false), code("WALLET_RETURN_INVALID"));
  await assert.rejects(() => wallet.beginWalletSetup({ ...value.actor, roles: ["crew"] }, randomUUID(), 1, "http://localhost:4105"), code("PRODUCER_REQUIRED"));
});
test("lost setup response remains uncertain and cannot create a replacement", async () => {
  const value = await start(); wire.failNext = "setup_lost"; const before = wire.writes("/v3/vault/setup-tokens").length;
  assert.equal((await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000))).status, "needs_attention");
  await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000));
  assert.equal(wire.writes("/v3/vault/setup-tokens").length, before + 1);
  await assert.rejects(() => wallet.retryWallet(value.actor, value.setup.id), code("WALLET_RETRY_NOT_SAFE"));
  assert.equal((await wallet.walletOverview(value.actor.tenantId))?.status, "pending_reconciliation");
});
test("lost conversion response reads the owned setup but never converts a second time", async () => {
  const value = await approvalRequired(); wire.setups.get(value.setup.setupTokenId!)!.status = "APPROVED"; wire.failNext = "exchange_lost";
  const before = wire.writes("/v3/vault/payment-tokens").length;
  await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000));
  await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000));
  assert.equal(wire.writes("/v3/vault/payment-tokens").length, before + 1);
  assert.equal((await storage.readWalletSetup(value.actor.tenantId, value.setup.id)).savedWalletId, null);
  await assert.rejects(() => wallet.retryWallet(value.actor, value.setup.id), code("WALLET_RETRY_NOT_SAFE"));
});
test("a verified provider refusal retries only on explicit review with the same PayPal request ID", async () => {
  const value = await start(); wire.failNext = "setup_refused";
  await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000)); const first = wire.writes("/v3/vault/setup-tokens").at(-1)!;
  assert.equal((await wallet.walletOverview(value.actor.tenantId))?.status, "refused");
  await wallet.retryWallet(value.actor, value.setup.id); await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000));
  const second = wire.writes("/v3/vault/setup-tokens").at(-1)!; assert.equal(second.requestId, first.requestId); assert.deepEqual(second.body, first.body);
});
test("expired save approval cannot exchange even after provider payer approval", async () => {
  const value = await approvalRequired(); wire.setups.get(value.setup.setupTokenId!)!.status = "APPROVED";
  value.setup.expiresAt = new Date(Date.now() - 1000).toISOString(); await storage.saveWalletSetup(database.pool, value.setup);
  const before = wire.writes("/v3/vault/payment-tokens").length;
  assert.deepEqual(await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000)), { status: "needs_attention", code: "WALLET_SAVE_EXPIRED" });
  assert.equal(wire.writes("/v3/vault/payment-tokens").length, before);
});
test("wrong customer, token identity and source are rejected on current wallet reads", async () => {
  const value = await ready();
  wire.tokenReadMutation = result => ({ ...result, customer: { id: "OTHER-CUSTOMER", merchant_customer_id: "OTHER-MERCHANT-CUSTOMER" } });
  try { await assert.rejects(() => wallet.verifySavedWallet(value.actor.tenantId, value.saved.id, value.actor.id, AbortSignal.timeout(5000)), code("WALLET_CUSTOMER_MISMATCH")); }
  finally { wire.tokenReadMutation = null; }
  wire.tokenReadMutation = result => ({ ...result, id: "OTHER-TOKEN" });
  try { await assert.rejects(() => wallet.verifySavedWallet(value.actor.tenantId, value.saved.id, value.actor.id, AbortSignal.timeout(5000)), code("WALLET_TOKEN_CONFLICT")); }
  finally { wire.tokenReadMutation = null; }
  wire.tokenReadMutation = result => ({ ...result, payment_source: {} });
  try { await assert.rejects(() => wallet.verifySavedWallet(value.actor.tenantId, value.saved.id, value.actor.id, AbortSignal.timeout(5000)), code("WALLET_TOKEN_CONFLICT")); }
  finally { wire.tokenReadMutation = null; }
});
test("an unknown provider setup status cannot substitute for approved payer consent", async () => {
  const value = await approvalRequired(); wire.setups.get(value.setup.setupTokenId!)!.status = "FUTURE_STATUS";
  const before = wire.writes("/v3/vault/payment-tokens").length;
  assert.equal((await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000))).status, "needs_attention");
  assert.equal(wire.writes("/v3/vault/payment-tokens").length, before);
});
test("canceling local save authority retains the provider token but disables future local use", async () => {
  const value = await ready();
  await wallet.walletReturn(value.actor, value.setup.id, wallet.walletCallbackState(value.setup), true);
  assert.ok(wire.tokens.has(value.saved.tokenId)); assert.equal((await wallet.walletOverview(value.actor.tenantId))?.status, "cancelled");
  await assert.rejects(() => wallet.verifySavedWallet(value.actor.tenantId, value.saved.id, value.actor.id, AbortSignal.timeout(5000)), code("WALLET_AUTHORITY_REVOKED"));
});
test("an exchange response for another customer cannot become a saved wallet or be replayed", async () => {
  const value = await approvalRequired(); wire.setups.get(value.setup.setupTokenId!)!.status = "APPROVED";
  wire.exchangeMutation = result => ({ ...result, customer: { id: "OTHER-CUSTOMER", merchant_customer_id: "OTHER-BINDING" } });
  const before = wire.writes("/v3/vault/payment-tokens").length;
  try {
    assert.equal((await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000))).status, "needs_attention");
    await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000));
    assert.equal((await storage.readWalletSetup(value.actor.tenantId, value.setup.id)).savedWalletId, null);
    assert.equal(wire.writes("/v3/vault/payment-tokens").length, before + 1);
    assert.equal((await wallet.walletOverview(value.actor.tenantId))?.lastCode, "WALLET_CUSTOMER_MISMATCH");
  } finally { wire.exchangeMutation = null; }
});
test("canceling during an in-flight approved exchange keeps its receipt but never enables the method", async () => {
  const value = await approvalRequired(); wire.setups.get(value.setup.setupTokenId!)!.status = "APPROVED";
  wire.before = async call => { if (call.method === "POST" && call.path === "/v3/vault/payment-tokens") await wallet.stopWalletSetup(value.actor, value.setup.id); };
  try {
    await wallet.runWalletSetup(value.actor.tenantId, value.setup.id, AbortSignal.timeout(5000));
    const setup = await storage.readWalletSetup(value.actor.tenantId, value.setup.id), saved = await storage.readSavedWallet(value.actor.tenantId, setup.savedWalletId!);
    assert.equal(saved.active, false); assert.ok(wire.tokens.has(saved.tokenId)); assert.equal((await wallet.walletOverview(value.actor.tenantId))?.status, "cancelled");
    assert.equal((await payments.listIntents(value.actor.tenantId)).length, 0);
  } finally { wire.before = null; }
});
