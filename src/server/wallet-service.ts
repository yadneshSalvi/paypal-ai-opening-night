import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { ExperienceContextShippingPreference, PayPalPaymentTokenCustomerType, PayPalPaymentTokenUsageType, UsagePattern, VaultTokenRequestType, type PaymentTokenResponse, type SetupTokenResponse } from "paypal";
import { DomainError, type Actor } from "@/domain/contracts";
import type { PublicWallet } from "@/domain/commerce-contracts";
import { digest } from "@/domain/hash";
import { env } from "./env";
import { pool } from "./store";
import { paymentStore, paymentTransaction } from "./payment-store";
import { assertProducer, assertRevision, lockSupplierShow, saveSupplierSnapshot } from "./supplier-storage";
import { activeCommerceActor, withCommerceLock } from "./commerce-storage";
import { enqueueJob, type JobResult } from "./jobs";
import { checkoutOrigin } from "./payment-service";
import { walletProvider, WalletProviderError } from "./wallet-provider";
import { readSavedWallet, readWalletOperation, readWalletSetup, saveWalletOperation, saveWalletSetup, type SavedWallet, type WalletOperation, type WalletResult, type WalletSetup } from "./wallet-storage";

const tokenId = (value: string | undefined): value is string => Boolean(value && /^[a-zA-Z0-9_-]{3,128}$/.test(value));
function approveUrl(value: SetupTokenResponse) {
  const link = value.links?.find(item => ["approve", "payer-action"].includes(item.rel) && (!item.method || item.method === "GET"));
  if (!link) return null;
  try { const url = new URL(link.href); return url.protocol === "https:" && url.hostname === "www.sandbox.paypal.com" && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function normalize(value: SetupTokenResponse | PaymentTokenResponse): WalletResult {
  if (!tokenId(value.id)) throw new WalletProviderError("WALLET_RESPONSE_INCOMPLETE", "unknown", 502);
  const source = value.paymentSource?.paypal; const identity = source?.payerId ?? source?.accountId;
  return { id: value.id, status: "status" in value && typeof value.status === "string" ? value.status : null,
    customerId: value.customer?.id ?? null, merchantCustomerId: value.customer?.merchantCustomerId ?? null,
    paypal: Boolean(source), usageType: source?.usageType ?? null, usagePattern: source?.usagePattern ?? null,
    payerHash: identity ? createHmac("sha256", env.sessionSecret).update("wallet-payer:" + identity).digest("hex") : null,
    approvalUrl: approveUrl(value),
  };
}
function assertCustomer(setup: Pick<WalletSetup, "customerId" | "merchantCustomerId">, result: WalletResult, required: boolean) {
  if (result.merchantCustomerId && result.merchantCustomerId !== setup.merchantCustomerId || setup.customerId && result.customerId && setup.customerId !== result.customerId) throw new DomainError("WALLET_CUSTOMER_MISMATCH", "The provider wallet belongs to a different customer binding.", 403);
  if (required && !(result.merchantCustomerId === setup.merchantCustomerId || setup.customerId && result.customerId === setup.customerId)) throw new DomainError("WALLET_CUSTOMER_UNPROVEN", "The saved wallet's customer association could not be verified.", 403);
  if (result.usageType && result.usageType !== "MERCHANT" || result.usagePattern && result.usagePattern !== "IMMEDIATE") throw new DomainError("WALLET_TERMS_MISMATCH", "The saved method does not match this venue's approved on-demand use.", 403);
}
export function walletCallbackState(setup: Pick<WalletSetup, "id" | "tenantId">) { return createHmac("sha256", env.sessionSecret).update("wallet-return:" + setup.tenantId + ":" + setup.id).digest("base64url"); }
function assertCallback(setup: WalletSetup, state: string) { const expected = Buffer.from(walletCallbackState(setup)), actual = Buffer.from(state); if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new DomainError("WALLET_RETURN_INVALID", "This wallet return cannot be verified.", 403); }
function currentSaveAuthority(setup: WalletSetup) {
  if (setup.cancelledAt) throw new DomainError("WALLET_SAVE_CANCELLED", "Wallet saving was canceled. No ticket charge is authorized.", 403);
  if (Date.parse(setup.expiresAt) <= Date.now()) throw new DomainError("WALLET_SAVE_EXPIRED", "This wallet-saving request expired. No ticket charge is authorized.", 403);
}
function operationFor(setup: WalletSetup, request: WalletOperation["request"]): WalletOperation {
  return { id: randomUUID(), tenantId: setup.tenantId, setupId: setup.id, providerRequestId: randomUUID(), request,
    payloadHash: digest(request), status: "prepared", result: null, attempts: 0, startedAt: null, observedAt: null,
    lastCode: null, httpStatus: null, debugId: null, responseHash: null, transport: "apimatic_sdk" };
}
async function insertOperation(client: import("pg").PoolClient, operation: WalletOperation) {
  await client.query("INSERT INTO on_wallet_operations(id,tenant_id,setup_id,phase,request_id,document) VALUES($1,$2,$3,$4,$5,$6)", [operation.id, operation.tenantId, operation.setupId, operation.request.phase, operation.providerRequestId, operation]);
}
export async function beginWalletSetup(actor: Actor, requestId: string, expectedRevision: number, rawOrigin: string) {
  assertProducer(actor); await paymentStore(); const origin = checkoutOrigin(rawOrigin);
  return paymentTransaction(async client => {
    const show = await lockSupplierShow(client, actor.tenantId);
    const prior = await client.query<{ document: WalletSetup }>("SELECT document FROM on_wallet_setups WHERE tenant_id=$1 AND semantic_key='ticket-wallet-v1'", [actor.tenantId]);
    if (prior.rows[0]) return prior.rows[0].document;
    assertRevision(show, expectedRevision);
    const setup: WalletSetup = { id: requestId, tenantId: actor.tenantId, actorId: actor.id, origin,
      merchantCustomerId: "on_" + digest({ tenant: actor.tenantId, setup: requestId }).slice(0, 40),
      saveConsentDigest: digest({ tenant: actor.tenantId, actor: actor.id, purpose: "save-only-no-charge", requestId, seller: "venue" }),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      cancelledAt: null, setupTokenId: null, customerId: null, savedWalletId: null, checkedAt: null };
    const callback = origin + "/wallet/return?setup=" + setup.id + "&state=" + walletCallbackState(setup);
    const operation = operationFor(setup, { phase: "setup", body: { customer: { merchantCustomerId: setup.merchantCustomerId }, paymentSource: { paypal: {
      description: "Opening Night sandbox: save this wallet for a separately reviewed ticket cohort. Saving alone authorizes no charge.",
      usagePattern: UsagePattern.Immediate, usageType: PayPalPaymentTokenUsageType.Merchant, customerType: PayPalPaymentTokenCustomerType.Consumer,
      experienceContext: { returnUrl: callback, cancelUrl: callback + "&cancel=1", shippingPreference: ExperienceContextShippingPreference.NoShipping },
    } } } });
    await client.query("INSERT INTO on_wallet_setups(id,tenant_id,semantic_key,document) VALUES($1,$2,'ticket-wallet-v1',$3)", [setup.id, setup.tenantId, setup]);
    await insertOperation(client, operation);
    await enqueueJob(client, { tenantId: actor.tenantId, kind: "wallet_setup", semanticKey: setup.id, payload: { setupId: setup.id }, maxAttempts: 30 });
    await saveSupplierSnapshot(client, show, actor.id, "wallet.save_requested", "Requested saving one controlled sandbox wallet. Saving alone authorizes no purchase and reserves no funds.");
    return setup;
  });
}
async function rememberSetup(setup: WalletSetup, result: WalletResult) {
  assertCustomer(setup, result, false);
  if (setup.setupTokenId && setup.setupTokenId !== result.id) throw new DomainError("WALLET_SETUP_ID_MISMATCH", "The setup response has a different owned identity.", 403);
  return paymentTransaction(async client => {
    const current = await readWalletSetup(setup.tenantId, setup.id, client, true);
    assertCustomer(current, result, false);
    current.setupTokenId = result.id; current.customerId ??= result.customerId; current.checkedAt = new Date().toISOString();
    await saveWalletSetup(client, current); return current;
  });
}
async function rememberToken(setup: WalletSetup, result: WalletResult) {
  assertCustomer(setup, result, true);
  if (!result.paypal) throw new DomainError("WALLET_SOURCE_MISMATCH", "The saved method is not the approved PayPal wallet.", 403);
  return paymentTransaction(async client => {
    const current = await readWalletSetup(setup.tenantId, setup.id, client, true); assertCustomer(current, result, true);
    if (current.savedWalletId) { const existing = await readSavedWallet(current.tenantId, current.savedWalletId, client); if (existing.tokenId !== result.id) throw new DomainError("WALLET_TOKEN_CONFLICT", "The saved method identity changed.", 409); return existing; }
    const now = new Date().toISOString();
    const wallet: SavedWallet = { id: randomUUID(), tenantId: current.tenantId, setupId: current.id, actorId: current.actorId, seller: "venue", tokenId: result.id,
      customerId: result.customerId ?? current.customerId, merchantCustomerId: current.merchantCustomerId, payerHash: result.payerHash, savedAt: now, checkedAt: now, active: !current.cancelledAt };
    const inserted = await client.query("INSERT INTO on_saved_wallets(id,tenant_id,setup_id,seller,provider_token_id,document) VALUES($1,$2,$3,'venue',$4,$5) ON CONFLICT(seller,provider_token_id) DO NOTHING RETURNING id", [wallet.id, wallet.tenantId, wallet.setupId, wallet.tokenId, wallet]);
    if (!inserted.rowCount) throw new DomainError("WALLET_OWNERSHIP_CONFLICT", "This saved token already belongs to another recorded wallet request.", 409);
    current.savedWalletId = wallet.id; current.customerId ??= wallet.customerId; current.checkedAt = now;
    await saveWalletSetup(client, current); return wallet;
  });
}
async function dispatchWalletOperation(setup: WalletSetup, operation: WalletOperation, signal: AbortSignal) {
  setup = await readWalletSetup(setup.tenantId, setup.id); currentSaveAuthority(setup); await activeCommerceActor(setup.tenantId, setup.actorId);
  if (operation.status !== "prepared" || operation.payloadHash !== digest(operation.request)) throw new DomainError("WALLET_OPERATION_CHANGED", "This wallet instruction cannot be dispatched under different terms.", 403);
  operation.status = "dispatching"; operation.startedAt = new Date().toISOString(); operation.attempts++;
  await saveWalletOperation(pool, operation); // Commit the exact immutable request before transport.
  try {
    const response = operation.request.phase === "setup"
      ? await walletProvider.createSetup(operation.request.body, operation.providerRequestId, signal)
      : await walletProvider.exchange(operation.request.body, operation.providerRequestId, signal);
    const result = normalize(response.value); assertCustomer(setup, result, operation.request.phase === "exchange");
    operation.status = "succeeded"; operation.result = result; operation.observedAt = new Date().toISOString(); operation.httpStatus = response.status; operation.debugId = response.debugId;
    operation.responseHash = digest(result); operation.lastCode = null; await saveWalletOperation(pool, operation); return result;
  } catch (error) {
    const provider = error instanceof WalletProviderError ? error : null;
    operation.status = provider?.outcome === "refused" ? "refused" : provider?.outcome === "not_sent" ? "not_sent" : "pending_reconciliation";
    operation.lastCode = provider?.code ?? (error instanceof DomainError ? error.code : "WALLET_WORK_INTERRUPTED"); operation.httpStatus = provider?.status ?? null;
    await saveWalletOperation(pool, operation); return null;
  }
}
function unresolved(operation: WalletOperation): JobResult { return { status: "needs_attention", code: operation.lastCode ?? (["refused", "not_sent"].includes(operation.status) ? "WALLET_EXPLICIT_RETRY_REQUIRED" : "WALLET_OUTCOME_UNKNOWN") }; }
async function readAndRememberToken(setup: WalletSetup, result: WalletResult, signal: AbortSignal) {
  const verified = normalize((await walletProvider.readToken(result.id, signal)).value);
  if (verified.id !== result.id) throw new DomainError("WALLET_TOKEN_CONFLICT", "The token read returned a different saved method.", 403);
  return rememberToken(setup, verified);
}
export async function runWalletSetup(tenantId: string, setupId: string, signal: AbortSignal): Promise<JobResult> {
  return withCommerceLock("wallet:" + tenantId + ":" + setupId, async () => {
    let setup = await readWalletSetup(tenantId, setupId);
    if (setup.savedWalletId || setup.cancelledAt) return { status: "complete" };
    if (Date.parse(setup.expiresAt) <= Date.now()) return { status: "needs_attention", code: "WALLET_SAVE_EXPIRED" };
    let create = await readWalletOperation(tenantId, setupId, "setup");
    if (!create) throw new DomainError("WALLET_OPERATION_MISSING", "The original wallet instruction is missing.");
    if (create.status === "prepared") await dispatchWalletOperation(setup, create, signal);
    create = (await readWalletOperation(tenantId, setupId, "setup"))!;
    if (create.status !== "succeeded" || !create.result) return unresolved(create);
    setup = await rememberSetup(setup, create.result);
    const current = normalize((await walletProvider.readSetup(create.result.id, signal)).value);
    if (current.id !== setup.setupTokenId) throw new DomainError("WALLET_SETUP_ID_MISMATCH", "The provider returned a different setup identity.", 403);
    setup = await rememberSetup(setup, current);
    const exchange = await readWalletOperation(tenantId, setupId, "exchange");
    if (exchange?.status === "succeeded" && exchange.result) { await readAndRememberToken(setup, exchange.result, signal); return { status: "complete" }; }
    if (exchange && exchange.status !== "prepared") return unresolved(exchange); // No second conversion after a lost response.
    if (["CREATED", "PAYER_ACTION_REQUIRED"].includes(current.status ?? "")) return { status: "waiting", code: "WALLET_BUYER_APPROVAL_REQUIRED", delaySeconds: 60 };
    if (current.status !== "APPROVED") return { status: "needs_attention", code: "WALLET_APPROVED_SETUP_REQUIRED" };
    currentSaveAuthority(setup);
    let conversion = exchange;
    if (!conversion) {
      conversion = operationFor(setup, { phase: "exchange", body: { paymentSource: { token: { id: current.id, type: VaultTokenRequestType.SetupToken } } } });
      await paymentTransaction(client => insertOperation(client, conversion!));
    }
    const result = await dispatchWalletOperation(setup, conversion, signal);
    if (!result) return unresolved(conversion);
    await readAndRememberToken(setup, result, signal); return { status: "complete" };
  });
}
export async function verifySavedWallet(tenantId: string, walletId: string, actorId: string, signal: AbortSignal): Promise<SavedWallet> {
  const wallet = await readSavedWallet(tenantId, walletId);
  if (!wallet.active || wallet.actorId !== actorId) throw new DomainError("WALLET_AUTHORITY_REVOKED", "This saved wallet is no longer available to this production operator.", 403);
  const result = normalize((await walletProvider.readToken(wallet.tokenId, signal)).value);
  if (result.id !== wallet.tokenId || !result.paypal) throw new DomainError("WALLET_TOKEN_CONFLICT", "The exact saved PayPal method could not be verified.", 403);
  assertCustomer(wallet, result, true);
  if (wallet.payerHash && result.payerHash && wallet.payerHash !== result.payerHash) throw new DomainError("WALLET_PAYER_CHANGED", "The saved method's payer identity changed.", 403);
  wallet.checkedAt = new Date().toISOString();
  await pool.query("UPDATE on_saved_wallets SET document=jsonb_set(document,'{checkedAt}',to_jsonb($3::text)) WHERE tenant_id=$1 AND id=$2", [tenantId, wallet.id, wallet.checkedAt]);
  return wallet;
}
export async function walletReturn(actor: Actor, setupId: string, state: string, cancel: boolean) {
  assertProducer(actor); const setup = await readWalletSetup(actor.tenantId, setupId); assertCallback(setup, state);
  if (setup.actorId !== actor.id) throw new DomainError("WALLET_ACTOR_MISMATCH", "This wallet request belongs to another operator.", 403);
  if (cancel) await stopWalletSetup(actor, setupId);
  else await pool.query("UPDATE on_jobs SET status='queued',run_after=now(),attempts=0,last_code=NULL WHERE tenant_id=$1 AND kind='wallet_setup' AND semantic_key=$2 AND status<>'running'", [actor.tenantId, setupId]);
}
export async function stopWalletSetup(actor: Actor, setupId: string) {
  assertProducer(actor);
  await paymentTransaction(async client => {
    const current = await readWalletSetup(actor.tenantId, setupId, client, true);
    if (current.actorId !== actor.id) throw new DomainError("WALLET_ACTOR_MISMATCH", "This wallet request belongs to another operator.", 403);
    current.cancelledAt ??= new Date().toISOString(); await saveWalletSetup(client, current);
    if (current.savedWalletId) await client.query("UPDATE on_saved_wallets SET document=jsonb_set(document,'{active}','false'::jsonb) WHERE tenant_id=$1 AND id=$2", [actor.tenantId, current.savedWalletId]);
  });
}
export async function retryWallet(actor: Actor, setupId: string) {
  assertProducer(actor);
  await withCommerceLock("wallet:" + actor.tenantId + ":" + setupId, async () => {
    const setup = await readWalletSetup(actor.tenantId, setupId); currentSaveAuthority(setup);
    if (setup.actorId !== actor.id) throw new DomainError("WALLET_ACTOR_MISMATCH", "This wallet request belongs to another operator.", 403);
    const operation = await readWalletOperation(actor.tenantId, setupId, "exchange") ?? await readWalletOperation(actor.tenantId, setupId, "setup");
    if (!operation || !["refused", "not_sent"].includes(operation.status)) throw new DomainError("WALLET_RETRY_NOT_SAFE", "Only a verified refusal or a request proved not sent can be retried. Unknown writes retain their original identity.");
    operation.status = "prepared"; operation.lastCode = null; await saveWalletOperation(pool, operation);
    await pool.query("UPDATE on_jobs SET status='queued',run_after=now(),attempts=0,last_code=NULL WHERE tenant_id=$1 AND kind='wallet_setup' AND semantic_key=$2 AND status<>'running'", [actor.tenantId, setupId]);
  });
}
export async function walletOverview(tenantId: string): Promise<PublicWallet | null> {
  const record = await pool.query<{ document: WalletSetup }>("SELECT document FROM on_wallet_setups WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1", [tenantId]);
  const setup = record.rows[0]?.document; if (!setup) return null;
  const create = await readWalletOperation(tenantId, setup.id, "setup"), exchange = await readWalletOperation(tenantId, setup.id, "exchange");
  const operation = exchange ?? create; const wallet = setup.savedWalletId ? await readSavedWallet(tenantId, setup.savedWalletId) : null;
  const job = (await pool.query<{ status: string; last_code: string | null }>("SELECT status,last_code FROM on_jobs WHERE tenant_id=$1 AND kind='wallet_setup' AND semantic_key=$2", [tenantId, setup.id])).rows[0];
  const status: PublicWallet["status"] = setup.cancelledAt ? "cancelled" : wallet?.active ? "ready" : Date.parse(setup.expiresAt) <= Date.now() ? "expired" : operation?.status === "pending_reconciliation" || operation?.status === "dispatching" ? "pending_reconciliation" : operation && ["refused", "not_sent"].includes(operation.status) ? "refused" : job?.status === "needs_attention" ? "needs_attention" : exchange ? "saving" : create?.status === "succeeded" ? "approval_required" : "preparing";
  return { id: setup.id, status, approvalUrl: status === "approval_required" ? create?.result?.approvalUrl ?? null : null, walletId: wallet?.id ?? null,
    reference: wallet ? "••••" + wallet.tokenId.slice(-6) : null, createdAt: setup.createdAt, expiresAt: setup.expiresAt, checkedAt: wallet?.checkedAt ?? setup.checkedAt,
    lastCode: operation?.lastCode ?? job?.last_code ?? null, canRetry: status === "refused" };
}
