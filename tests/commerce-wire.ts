/** Controlled generated-SDK transport. Never used as live provider qualification. */
import { SandboxPayPalProvider } from "@fracture/paypal-core";
import type { Pool } from "pg";

type Json = Record<string, any>;
export interface WireCall { method: string; path: string; body: Json | null; requestId: string | null; sdkIdempotencyKey: string | null; durable: boolean }
export class CommerceWire {
  calls: WireCall[] = []; setups = new Map<string, Json>(); tokens = new Map<string, Json>(); orders = new Map<string, Json>();
  sequence = 0; failNext: "setup_lost" | "exchange_lost" | "setup_refused" | "token_unavailable" | "order_lost" | "order_refused" | "capture_lost" | "refund_lost" | "refund_pending" | null = null;
  immediateCapture = false; immediateCaptureStatus = "COMPLETED"; requirePayerApproval = false; tokenReadMutation: ((value: Json) => Json) | null = null;
  setupReadMutation: ((value: Json) => Json) | null = null; exchangeMutation: ((value: Json) => Json) | null = null;
  before: ((call: WireCall) => Promise<void>) | null = null;
  constructor(private readonly pool: Pool) {}
  id(prefix: string) { return prefix + "-" + String(++this.sequence).padStart(5, "0"); }
  json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "paypal-debug-id": "controlled-commerce-wire" } }); }
  fetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init); const path = new URL(request.url).pathname;
    if (path === "/v1/oauth2/token") return this.json({ access_token: "controlled-commerce-access", token_type: "Bearer", expires_in: 3600 });
    const body = request.method === "GET" ? null : JSON.parse(await request.clone().text() || "null") as Json | null;
    const requestId = request.headers.get("PayPal-Request-Id");
    const committed = request.method !== "GET" ? path.startsWith("/v3/vault/")
      ? (await this.pool.query("SELECT document->>'status' AS status FROM on_wallet_operations WHERE request_id=$1", [requestId])).rows
      : (await this.pool.query("SELECT status FROM paycore_operations WHERE provider_request_id=$1", [requestId])).rows : [];
    const call = { method: request.method, path, body, requestId, sdkIdempotencyKey: request.headers.get("Idempotency-Key"), durable: request.method === "GET" || committed[0]?.status === "dispatching" };
    this.calls.push(call); await this.before?.(call);
    if (path === "/v3/vault/setup-tokens" && request.method === "POST") {
      if (this.failNext === "setup_refused") { this.failNext = null; return this.json({ name: "NOT_AUTHORIZED", message: "Controlled fixture capability refusal" }, 403); }
      const id = this.id("SETUP"); const result = { id, status: "PAYER_ACTION_REQUIRED", customer: { id: this.id("CUSTOMER"), merchant_customer_id: body!.customer.merchant_customer_id }, payment_source: { paypal: { usage_type: "MERCHANT", usage_pattern: "IMMEDIATE" } }, links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/agreements/approve?approval_token_id=" + id, method: "GET" }] };
      this.setups.set(id, result);
      if (this.failNext === "setup_lost") { this.failNext = null; throw new TypeError("Controlled lost setup response after commit"); }
      return this.json(result, 201);
    }
    if (path.startsWith("/v3/vault/setup-tokens/") && request.method === "GET") {
      const result = this.setups.get(path.split("/").at(-1)!); if (result) return this.json(this.setupReadMutation ? this.setupReadMutation(structuredClone(result)) : result);
    }
    if (path === "/v3/vault/payment-tokens" && request.method === "POST") {
      const setup = this.setups.get(body!.payment_source.token.id);
      if (!setup || setup.status !== "APPROVED") return this.json({ name: "UNPROCESSABLE_ENTITY", message: "Controlled approval required" }, 422);
      const id = this.id("WALLET"); const result = { id, customer: setup.customer, payment_source: { paypal: { payer_id: this.id("PAYER"), usage_type: "MERCHANT", usage_pattern: "IMMEDIATE" } }, links: [] };
      setup.status = "VAULTED"; this.tokens.set(id, result);
      if (this.failNext === "exchange_lost") { this.failNext = null; throw new TypeError("Controlled lost exchange response after commit"); }
      return this.json(this.exchangeMutation ? this.exchangeMutation(structuredClone(result)) : result, 201);
    }
    if (path.startsWith("/v3/vault/payment-tokens/") && request.method === "GET") {
      if (this.failNext === "token_unavailable") { this.failNext = null; return this.json({ name: "INTERNAL_SERVER_ERROR", message: "Controlled token read unavailable" }, 503); }
      const result = this.tokens.get(path.split("/").at(-1)!); if (result) return this.json(this.tokenReadMutation ? this.tokenReadMutation(structuredClone(result)) : result);
    }
    if (path === "/v2/checkout/orders" && request.method === "POST") {
      if (this.failNext === "order_refused") { this.failNext = null; return this.json({ name: "UNPROCESSABLE_ENTITY", message: "Controlled refusal", details: [{ issue: "INSTRUMENT_DECLINED" }] }, 422); }
      const id = this.id("ORDER"), unit = body!.purchase_units[0]; const saved = Boolean(body!.payment_source?.paypal?.vault_id);
      const result = { id, intent: body!.intent, status: saved && !this.requirePayerApproval ? "APPROVED" : "CREATED", purchase_units: [{ amount: unit.amount, custom_id: unit.custom_id, payments: { captures: [] as Json[], authorizations: [], refunds: [] as Json[] } }], links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=" + id, method: "GET" }] };
      if (saved && this.immediateCapture) { result.status = "COMPLETED"; result.purchase_units[0]!.payments.captures.push({ id: this.id("CAPTURE"), status: this.immediateCaptureStatus, amount: { currency_code: unit.amount.currency_code, value: unit.amount.value } }); }
      this.orders.set(id, result);
      if (this.failNext === "order_lost") { this.failNext = null; throw new TypeError("Controlled lost order response after commit"); }
      return this.json(result, 201);
    }
    const orderId = path.split("/")[4]; const order = this.orders.get(orderId!);
    if (order && path === "/v2/checkout/orders/" + orderId && request.method === "GET") return this.json(order);
    if (order && path.endsWith("/capture") && request.method === "POST") {
      if (order.status !== "APPROVED") return this.json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] }, 422);
      order.status = "COMPLETED"; order.purchase_units[0].payments.captures.push({ id: this.id("CAPTURE"), status: "COMPLETED", amount: { currency_code: order.purchase_units[0].amount.currency_code, value: order.purchase_units[0].amount.value } });
      if (this.failNext === "capture_lost") { this.failNext = null; throw new TypeError("Controlled lost capture response after commit"); }
      return this.json(order, 201);
    }
    for (const order of this.orders.values()) {
      const payments = order.purchase_units[0].payments;
      const capture = (payments.captures as Json[]).find(value => path === "/v2/payments/captures/" + value.id || path === "/v2/payments/captures/" + value.id + "/refund");
      if (capture) {
        if (request.method === "GET") return this.json(capture);
        if (path.endsWith("/refund")) {
          const refund = { id: this.id("REFUND"), status: this.failNext === "refund_pending" ? "PENDING" : "COMPLETED", amount: body!.amount, custom_id: body!.custom_id };
          payments.refunds.push(refund); capture.status = "PARTIALLY_REFUNDED";
          if (this.failNext === "refund_lost") { this.failNext = null; throw new TypeError("Controlled lost refund response after commit"); }
          this.failNext = null; return this.json(refund, 201);
        }
      }
      const refund = (payments.refunds as Json[]).find(value => path === "/v2/payments/refunds/" + value.id); if (refund) return this.json(refund);
    }
    return this.json({ name: "RESOURCE_NOT_FOUND", message: "Controlled fixture resource not found" }, 404);
  };
  provider() { return new SandboxPayPalProvider({ environment: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com", isolatedProject: "controlled-commerce-fixture", clientId: "controlled-commerce-client", clientSecret: "controlled-commerce-secret" }, this.fetch); }
  writes(path: string) { return this.calls.filter(call => call.method === "POST" && call.path === path); }
}
