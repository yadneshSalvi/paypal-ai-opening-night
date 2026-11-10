import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { PaymentCore, SandboxPayPalProvider, PaymentError, payloadHash, type AuthorizationDecision, type PaymentAction, type PaymentCommand, type PaymentOperation, type ProviderResource, type ResourceReservation } from "@fracture/paypal-core";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import { approvedRental, assertPaymentAuthority, safeApprovalUrl, type PaymentIntent, type PaymentPurpose, type PaymentSeller, type PublicPayment } from "@/domain/payment-authority";
import { digest } from "@/domain/hash";
import { getShow, pool } from "./store";
import { env } from "./env";
import { importPaymentOperation, listIntents, ownedResources, paymentStore, paymentTransaction, readIntent } from "./payment-store";

function required(key: string) { const value = process.env[key]; if (!value) throw new Error("Missing payment configuration: " + key); return value; }
if (required("PAYPAL_ENVIRONMENT") !== "sandbox" || required("PAYPAL_API_BASE_URL") !== "https://api-m.sandbox.paypal.com" || !required("PAYPAL_PROJECT_ISOLATED")) throw new Error("Opening Night requires isolated PayPal sandbox configuration.");
if (required("PAYPAL_CLIENT_ID") === required("OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID")) throw new Error("Opening Night and Brightline must use different merchant apps.");
const shared = globalThis as typeof globalThis & { openingNightProviders?: Record<PaymentSeller, SandboxPayPalProvider> };
export const providers = shared.openingNightProviders ??= {
  venue: new SandboxPayPalProvider({ environment: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com", isolatedProject: "opening-night:venue", clientId: required("PAYPAL_CLIENT_ID"), clientSecret: required("PAYPAL_CLIENT_SECRET") }),
  brightline: new SandboxPayPalProvider({ environment: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com", isolatedProject: "opening-night:brightline", clientId: required("OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID"), clientSecret: required("OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET") }),
};
const identifier = z.string().uuid();
export const paymentRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rental_checkout"), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("ticket_checkout"), expectedRevision: z.number().int().positive(), ticketId: identifier, tier: z.enum(["standard", "vip"]) }).strict(),
  z.object({ type: z.literal("complete_checkout"), intentId: identifier, state: z.string().min(40).max(100) }).strict(),
  z.object({ type: z.literal("capture_rental_fee"), intentId: identifier, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("release_rental_hold"), intentId: identifier, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("refund_perk"), ticketId: identifier, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("reconcile"), intentId: identifier }).strict(),
  z.object({ type: z.literal("retry_refused"), intentId: identifier }).strict(),
]);
export type PaymentRequest = z.infer<typeof paymentRequest>;
export function callbackState(intent: Pick<PaymentIntent, "id" | "tenantId">) { return createHmac("sha256", env.sessionSecret).update("checkout:" + intent.tenantId + ":" + intent.id).digest("base64url"); }
function assertCallback(intent: PaymentIntent, state: string) { const expected = Buffer.from(callbackState(intent)); const actual = Buffer.from(state); if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new DomainError("CHECKOUT_STATE", "This checkout return cannot be verified.", 403); }
export function checkoutOrigin(input: string) {
  const configured = ["http://localhost:4105", "http://127.0.0.1:4105", process.env.APP_BASE_URL, process.env.NEXT_PUBLIC_APP_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : null, process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : null].filter((value): value is string => Boolean(value)).map(value => new URL(value).origin);
  const url = new URL(input);
  if (!configured.includes(url.origin) || (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))) throw new DomainError("CHECKOUT_ORIGIN", "This host is not configured for the payment return route.", 403);
  return url.origin;
}
function producer(actor: Actor) { if (!actor.roles.includes("producer")) throw new DomainError("PRODUCER_REQUIRED", "Only the production operator can approve this sandbox payment.", 403); }
function currentRole(actor: Actor, purpose: PaymentPurpose) {
  if (purpose === "rental_fee" && !actor.roles.some(r => ["producer", "supplier"].includes(r))) throw new DomainError("COMMERCIAL_ROLE_REQUIRED", "The producer or supplier must execute the accepted rental fee.", 403);
  else if (purpose === "rental_release" && !actor.roles.some(r => ["producer", "supplier"].includes(r))) throw new DomainError("COMMERCIAL_ROLE_REQUIRED", "The producer or supplier must close the accepted return.", 403);
  else if (!["rental_fee", "rental_release"].includes(purpose)) producer(actor);
}

async function resourceBudget(intent: PaymentIntent, signal: AbortSignal): Promise<ResourceReservation | undefined> {
  const action = intent.command.action;
  if (action.kind !== "refund_capture" && action.kind !== "capture_authorization") return undefined;
  if (!action.orderId) throw new DomainError("ORDER_BINDING_REQUIRED", "The original order is required to reconcile this payment.");
  const provider = providers[intent.seller];
  const [order, direct] = await Promise.all([provider.read("order", action.orderId, signal), provider.read(action.kind === "refund_capture" ? "capture" : "authorization", action.kind === "refund_capture" ? action.captureId : action.authorizationId, signal)]);
  const resource = direct[0];
  const wantedKind = action.kind === "refund_capture" ? "capture" : "authorization";
  const orderParent = order.filter(r => r.kind === wantedKind);
  if (!resource?.money || resource.money.currency !== "USD" || orderParent.length !== 1 || orderParent[0]?.id !== resource.id || orderParent[0]?.money?.minor !== resource.money.minor) throw new DomainError("PROVIDER_BUDGET_AMBIGUOUS", "The exact original resource and current order history could not be verified.");
  const children = order.filter(r => r.kind === (action.kind === "refund_capture" ? "refund" : "capture") && !["FAILED", "CANCELLED", "DECLINED", "DENIED"].includes(r.status));
  if (children.some(r => !r.money || r.money.currency !== "USD" || r.money.minor <= 0)) throw new DomainError("PROVIDER_BUDGET_AMBIGUOUS", "The provider history contains an incomplete amount.");
  const consumed = children.reduce((sum, r) => sum + r.money!.minor, 0);
  if (action.kind === "refund_capture") {
    if (!["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(resource.status) || resource.status === "PARTIALLY_REFUNDED" && consumed === 0 || resource.status === "REFUNDED" && consumed !== resource.money.minor) throw new DomainError("PROVIDER_BUDGET_AMBIGUOUS", "The capture refund state requires reconciliation before another remedy.");
    const show = await getShow(intent.tenantId); const ticket = show.tickets.find(t => t.id === intent.ticketId);
    if (!ticket || consumed > 0 || ticket.refundedMinor > 0) throw new DomainError("PERK_ALREADY_CONSUMED", "This capture already has a refund. Reconcile its allocation before another remedy.");
  } else if (!["CREATED", "PARTIALLY_CAPTURED"].includes(resource.status) || resource.status === "PARTIALLY_CAPTURED" && consumed === 0) throw new DomainError("PROVIDER_BUDGET_AMBIGUOUS", "The authorization is not available for this fee capture.");
  return { resourceKey: wantedKind + ":" + resource.id, currency: "USD", totalMinor: resource.money.minor, externallyConsumedMinor: consumed, observedProviderIds: children.map(r => r.id), observedAt: new Date().toISOString() };
}
async function authorizePayment(command: PaymentCommand, signal: AbortSignal): Promise<AuthorizationDecision> {
  try {
  const intent = await readIntent(command.scope.tenantId, command.intentId);
  const show = await getShow(intent.tenantId);
  assertPaymentAuthority(show, intent, command);
  const active = await pool.query("SELECT 1 FROM on_sessions WHERE tenant_id=$1 AND actor->>'id'=$2 AND expires_at>now() LIMIT 1", [intent.tenantId, intent.approvedBy]);
  if (!active.rowCount) throw new PaymentError("AUTHORITY_REVOKED", "The approving session is no longer active.", 403);
  if (intent.parentId && intent.purpose.startsWith("rental_")) { const parent = await readIntent(intent.tenantId, intent.parentId); if (parent.planVersion !== intent.planVersion || parent.planDigest !== intent.planDigest) throw new DomainError("STALE_RENTAL", "The rental checkout belongs to an earlier recovery approval.", 403); }
  const owned = await ownedResources(intent.tenantId, intent.seller, intent.parentId ?? intent.id);
  if (intent.resourceIds.some(id => !owned.some(resource => resource.id === id))) throw new PaymentError("RESOURCE_NOT_GRANTED", "The payment resource is not owned by this approved execution.", 403);
  let reservation: ResourceReservation | undefined;
  try { reservation = await resourceBudget(intent, signal); } catch (error) { if (error instanceof DomainError) throw error; throw new PaymentError("BUDGET_READ_REQUIRED", "The current provider budget could not be verified. No payment was sent.", 503); }
  if (command.action.kind === "void_authorization") { const action = command.action; const current = await providers[intent.seller].read("order", action.orderId!, signal); const auth = current.find(r => r.kind === "authorization" && r.id === action.authorizationId); const captures = current.filter(r => r.kind === "capture" && ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(r.status)); if (!auth?.money || auth.status !== "PARTIALLY_CAPTURED" || captures.length !== 1 || captures[0]?.money?.minor !== intent.feeMinor || auth.money.minor - intent.feeMinor !== intent.depositMinor) throw new DomainError("HOLD_CLOSURE_PENDING", "The remaining damage hold could not be verified. Closure stays pending."); }
  const action = command.action;
  return { allowed: true, reason: "Current production approval and owned resource verified.", resourceIds: intent.resourceIds, currency: "USD", maximumMinor: action.money.minor, approvalId: command.approval.id, approvalVersion: command.approval.version, approvalDigest: command.approval.digest, ...(reservation ? { reservation } : {}), ...(action.kind === "create_order" && action.experience ? { checkoutOrigins: [checkoutOrigin(action.experience.returnUrl)] } : {}) };
  } catch (error) { if (error instanceof DomainError) throw new PaymentError(error.code, error.message, error.status); throw error; }
}
async function coreFor(intent: PaymentIntent, signal: AbortSignal) { return new PaymentCore({ store: await paymentStore(), provider: providers[intent.seller], policy: { authorize: command => authorizePayment(command, signal) } }); }
async function executeIntent(intent: PaymentIntent, retry = false) {
  const signal = AbortSignal.timeout(55000); const store = await paymentStore();
  const previous = await store.get(intent.command.scope, intent.command.operationId);
  if (previous && !retry) { await importPaymentOperation(intent, previous); return previous; }
  const core = await coreFor(intent, signal);
  const operation = retry ? await core.retry(intent.command.scope, intent.command.operationId, signal) : await core.execute(intent.command, signal);
  await importPaymentOperation(intent, operation); return operation;
}
interface IntentSpec { purpose: PaymentPurpose; semanticKey: string; seller: PaymentSeller; parentId?: string; ticketId?: string; tier?: "standard" | "vip"; resourceIds?: string[]; expectedRevision?: number; build: (id: string, show: ShowSnapshot) => PaymentAction }
async function prepare(actor: Actor, spec: IntentSpec): Promise<PaymentIntent> {
  currentRole(actor, spec.purpose); await paymentStore();
  return paymentTransaction(async client => {
    const locked = await client.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR UPDATE", [actor.tenantId]);
    const show = locked.rows[0]?.snapshot; if (!show) throw new DomainError("SHOW_NOT_FOUND", "This production no longer exists.", 404);
    const existing = await client.query<{ document: PaymentIntent }>("SELECT document FROM on_payment_intents WHERE tenant_id=$1 AND semantic_key=$2", [actor.tenantId, spec.semanticKey]);
    if (existing.rows[0]) { const intent = existing.rows[0].document; if (intent.purpose !== spec.purpose || intent.seller !== spec.seller || intent.ticketId !== (spec.ticketId ?? null) || intent.tier !== (spec.tier ?? null)) throw new DomainError("PAYMENT_IDENTITY_CONFLICT", "This payment identity already has different approved terms."); return intent; }
    if (spec.expectedRevision !== undefined && show.revision !== spec.expectedRevision) throw new DomainError("STALE_REVISION", "The production changed. Refresh before reviewing this commitment.");
    const id = randomUUID(); const now = new Date().toISOString(); const action = spec.build(id, show);
    const rental = spec.purpose.startsWith("rental_") ? approvedRental(show) : null;
    const intent: PaymentIntent = { id, tenantId: actor.tenantId, seller: spec.seller, purpose: spec.purpose, semanticKey: spec.semanticKey, planVersion: show.planVersion, planDigest: show.approvedPlan?.digest ?? null, parentId: spec.parentId ?? null, ticketId: spec.ticketId ?? null, resourceIds: spec.resourceIds ?? [], approvedBy: actor.id, createdAt: now, feeMinor: rental?.offer.feeMinor ?? 0, depositMinor: rental?.offer.depositMinor ?? 0, tier: spec.tier ?? null, command: { scope: { tenantId: actor.tenantId, projectId: "opening-night:" + spec.seller }, operationId: id, businessKey: spec.semanticKey, intentId: id, providerRequestId: randomUUID(), payloadHash: payloadHash(action), action, approval: { id: "approval:" + id, version: show.planVersion, digest: digest({ actorId: actor.id, action, planDigest: show.approvedPlan?.digest ?? null }), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() } } };
    assertPaymentAuthority(show, intent);
    if (spec.parentId && spec.purpose.startsWith("rental_")) { const parent = await readIntent(actor.tenantId, spec.parentId, client); if (parent.planVersion !== show.planVersion || parent.planDigest !== show.approvedPlan?.digest) throw new DomainError("STALE_RENTAL", "The rental belongs to an earlier recovery approval.", 403); }
    if (spec.parentId) { const owned = await ownedResources(actor.tenantId, spec.seller, spec.parentId, client); if (intent.resourceIds.some(resource => !owned.some(item => item.id === resource))) throw new DomainError("PAYMENT_RESOURCE", "The referenced payment is not in this production’s owned set.", 403); }
    await client.query("INSERT INTO on_payment_intents(id,tenant_id,seller,semantic_key,document) VALUES($1,$2,$3,$4,$5)", [id, actor.tenantId, spec.seller, spec.semanticKey, intent]);
    return intent;
  });
}
function returnExperience(id: string, tenantId: string, origin: string, authorization: boolean) {
  const route = origin + "/payments/return?intent=" + id + "&state=" + callbackState({ id, tenantId });
  return { returnUrl: route, cancelUrl: route + "&cancel=1", userAction: authorization ? "CONTINUE" as const : "PAY_NOW" as const, shippingPreference: "NO_SHIPPING" as const };
}
async function rootAndResources(actor: Actor, id: string) {
  await paymentStore(); const intent = await readIntent(actor.tenantId, id);
  if (intent.parentId) throw new DomainError("ROOT_INTENT_REQUIRED", "Select the original rental or ticket checkout.");
  return { intent, resources: await ownedResources(actor.tenantId, intent.seller, intent.id) };
}
export async function handlePayment(actor: Actor, request: PaymentRequest, rawOrigin: string) {
  const origin = checkoutOrigin(rawOrigin); await paymentStore();
  let intent: PaymentIntent;
  if (request.type === "rental_checkout") {
    producer(actor); const show = await getShow(actor.tenantId);
    intent = await prepare(actor, { purpose: "rental_order", semanticKey: "rental:" + show.planVersion + ":order", seller: "brightline", expectedRevision: request.expectedRevision, build: (id, current) => { const { offer } = approvedRental(current); return { kind: "create_order", money: { currency: "USD", minor: offer.feeMinor + offer.depositMinor }, intent: "AUTHORIZE", customId: "on:" + id, items: [{ name: "Alder Hall console rental fee", unitAmount: { currency: "USD", minor: offer.feeMinor }, quantity: 1 }, { name: "Refundable damage authorization hold", unitAmount: { currency: "USD", minor: offer.depositMinor }, quantity: 1 }], experience: returnExperience(id, actor.tenantId, origin, true) }; } });
  } else if (request.type === "ticket_checkout") {
    intent = await prepare(actor, { purpose: "ticket_order", semanticKey: "ticket:" + request.ticketId + ":order", seller: "venue", ticketId: request.ticketId, tier: request.tier, expectedRevision: request.expectedRevision, build: id => ({ kind: "create_order", money: { currency: "USD", minor: request.tier === "vip" ? 5000 : 3500 }, intent: "CAPTURE", customId: "on:" + id, items: [{ name: "Night Ferries — Alder Hall admission", unitAmount: { currency: "USD", minor: 3500 }, quantity: 1 }, ...(request.tier === "vip" ? [{ name: "VIP soundcheck visit perk", unitAmount: { currency: "USD", minor: 1500 }, quantity: 1 }] : [])], experience: returnExperience(id, actor.tenantId, origin, false) }) });
  } else if (request.type === "complete_checkout") {
    producer(actor); const root = await rootAndResources(actor, request.intentId); assertCallback(root.intent, request.state);
    const order = root.resources.find(r => r.kind === "order"); if (!order) throw new DomainError("ORDER_NOT_VERIFIED", "The original order is still awaiting provider reconciliation.");
    const authorize = root.intent.purpose === "rental_order";
    if (!authorize && root.intent.purpose !== "ticket_order") throw new DomainError("CHECKOUT_NOT_EXPECTED", "This operation is not a checkout.");
    const existing = await (await paymentStore()).get(root.intent.command.scope, root.intent.command.operationId);
    if (existing?.receipt?.resources.some(r => r.kind === "capture" && r.status === "COMPLETED")) { await importPaymentOperation(root.intent, existing); return existing; }
    intent = await prepare(actor, { purpose: authorize ? "rental_authorize" : "ticket_capture", semanticKey: root.intent.id + (authorize ? ":authorize" : ":capture"), seller: root.intent.seller, parentId: root.intent.id, resourceIds: [order.id], ...(root.intent.ticketId ? { ticketId: root.intent.ticketId } : {}), ...(root.intent.tier ? { tier: root.intent.tier } : {}), build: () => ({ kind: authorize ? "authorize_order" : "capture_order", orderId: order.id, money: root.intent.command.action.money }) });
  } else if (request.type === "capture_rental_fee" || request.type === "release_rental_hold") {
    const root = await rootAndResources(actor, request.intentId); if (root.intent.purpose !== "rental_order") throw new DomainError("RENTAL_REQUIRED", "Select the original rental checkout.");
    const authorization = root.resources.find(r => r.kind === "authorization"), order = root.resources.find(r => r.kind === "order");
    if (!authorization || !order) throw new DomainError("AUTHORIZATION_REQUIRED", "A verified original rental authorization is required.");
    const capture = request.type === "capture_rental_fee";
    intent = await prepare(actor, { purpose: capture ? "rental_fee" : "rental_release", semanticKey: root.intent.id + (capture ? ":fee" : ":release"), seller: "brightline", parentId: root.intent.id, resourceIds: [authorization.id, order.id], expectedRevision: request.expectedRevision, build: () => capture ? { kind: "capture_authorization", money: { currency: "USD", minor: root.intent.feeMinor }, authorizationId: authorization.id, orderId: order.id, finalCapture: false } : { kind: "void_authorization", money: root.intent.command.action.money, authorizationId: authorization.id, orderId: order.id } });
  } else if (request.type === "refund_perk") {
    producer(actor); const roots = (await listIntents(actor.tenantId)).filter(i => i.ticketId === request.ticketId && i.purpose === "ticket_order");
    const root = roots[0]; if (!root) throw new DomainError("TICKET_NOT_FOUND", "This ticket has no owned original checkout.");
    const resources = await ownedResources(actor.tenantId, "venue", root.id); const capture = resources.find(r => r.kind === "capture"), order = resources.find(r => r.kind === "order");
    if (!capture || !order) throw new DomainError("CAPTURE_REQUIRED", "A verified original ticket capture is required.");
    intent = await prepare(actor, { purpose: "vip_refund", semanticKey: "ticket:" + request.ticketId + ":vip-remedy", seller: "venue", parentId: root.id, ticketId: request.ticketId, tier: "vip", resourceIds: [capture.id, order.id], expectedRevision: request.expectedRevision, build: () => ({ kind: "refund_capture", money: { currency: "USD", minor: 1500 }, captureId: capture.id, orderId: order.id }) });
  } else {
    intent = await readIntent(actor.tenantId, request.intentId); currentRole(actor, intent.purpose);
    if (request.type === "reconcile") { const core = await coreFor(intent, AbortSignal.timeout(55000)); const operation = await core.reconcile(intent.command.scope, intent.command.operationId); await importPaymentOperation(intent, operation); return operation; }
    return executeIntent(intent, true);
  }
  return executeIntent(intent);
}
export async function paymentOverview(actor: Actor): Promise<PublicPayment[]> {
  if (!actor.roles.some(r => ["producer", "supplier"].includes(r))) throw new DomainError("COMMERCIAL_ROLE_REQUIRED", "This client does not have access to financial operations.", 403);
  const intents = await listIntents(actor.tenantId); const store = await paymentStore();
  const results: PublicPayment[] = [];
  for (const intent of intents) {
    if (actor.roles.includes("supplier") && !actor.roles.includes("producer") && intent.seller !== "brightline") continue;
    const operation = await store.get(intent.command.scope, intent.command.operationId);
    results.push({ id: intent.id, purpose: intent.purpose, seller: intent.seller, amountMinor: intent.command.action.money.minor, planVersion: intent.planVersion, status: operation?.status ?? "prepared", approvalUrl: operation?.status === "succeeded" && intent.command.action.kind === "create_order" ? safeApprovalUrl(operation.receipt?.resources ?? []) : null, error: operation?.error?.message ?? null, resources: (operation?.receipt?.resources ?? []).map(r => ({ kind: r.kind, reference: "••••" + r.id.slice(-6), status: r.status, amountMinor: r.money?.minor ?? null })), updatedAt: operation?.updatedAt ?? intent.createdAt, ticketId: intent.ticketId });
  }
  return results;
}
