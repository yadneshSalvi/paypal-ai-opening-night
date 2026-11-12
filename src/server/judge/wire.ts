/**
 * Replay transport for guided demonstrations.
 *
 * The installed PayPal SDK is given this in-process `fetch` instead of a
 * network transport, so the application's ordinary payment services run
 * unchanged while NO request leaves the process. Every resource it returns is
 * an application fixture whose identifier starts with `ONREPLAY-`; none is a
 * PayPal record. Resources are persisted per demonstration tenant so that a
 * later serverless invocation can read, capture, refund or void exactly what
 * an earlier one created, and repeated requests are answered idempotently by
 * their `PayPal-Request-Id`.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface WireDocument { order: Json; requests: Record<string, { kind: "capture" | "refund"; id: string }> }

export const REPLAY_ID_MARKER = "ONREPLAY-";
export const REPLAY_ORIGIN = "https://api-m.sandbox.paypal.com";
const ORDER_ID = /^ONREPLAY-O-[0-9A-F]{20}$/;
const CHILD_ID = /^ONREPLAY-([ACR])-([0-9A-F]{20})-\d{2}$/;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "paypal-debug-id": "guided-demonstration-replay" } });
const notFound = () => response({ name: "RESOURCE_NOT_FOUND", message: "This replayed demonstration resource does not exist." }, 404);

export class ReplayWire {
  /** Requests answered in process for this scope. Reported by the director; never a provider call count. */
  answered = 0;
  private readonly documents = new Map<string, WireDocument>();
  constructor(private readonly tenantId: string, private readonly database: () => Promise<Pool>) {}

  private orderIdFor(requestId: string) { return REPLAY_ID_MARKER + "O-" + createHash("sha256").update(this.tenantId + ":" + requestId).digest("hex").slice(0, 20).toUpperCase(); }
  private childId(kind: "A" | "C" | "R", orderId: string, ordinal: number) { return REPLAY_ID_MARKER + kind + "-" + orderId.slice(-20) + "-" + String(ordinal).padStart(2, "0"); }
  private async load(orderId: string) {
    if (!ORDER_ID.test(orderId)) return null;
    const cached = this.documents.get(orderId); if (cached) return cached;
    const pool = await this.database();
    const row = (await pool.query<{ document: WireDocument }>("SELECT document FROM on_judge_wire WHERE order_id=$1 AND tenant_id=$2", [orderId, this.tenantId])).rows[0];
    if (!row) return null;
    this.documents.set(orderId, row.document); return row.document;
  }
  private async save(orderId: string, document: WireDocument) {
    const pool = await this.database();
    const saved = await pool.query("INSERT INTO on_judge_wire(order_id,tenant_id,document) VALUES($1,$2,$3) ON CONFLICT(order_id) DO UPDATE SET document=EXCLUDED.document,updated_at=now() WHERE on_judge_wire.tenant_id=EXCLUDED.tenant_id", [orderId, this.tenantId, JSON.stringify(document)]);
    if (saved.rowCount !== 1) throw new Error("Replay resource ownership conflict");
    this.documents.set(orderId, document);
  }
  /** Explicit controlled payer input for a replayed order. Not an actual buyer approval. */
  async approve(orderId: string) {
    const document = await this.load(orderId); if (!document) throw new Error("Replay order not found");
    if (document.order.status === "CREATED") { document.order.status = "APPROVED"; await this.save(orderId, document); }
    return document.order.status as string;
  }

  async fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url), path = url.pathname, method = request.method.toUpperCase();
    if (url.origin !== REPLAY_ORIGIN) throw new TypeError("Replay transport refuses any address outside its fixed sandbox API shape");
    this.answered++;
    if (path === "/v1/oauth2/token") return response({ access_token: "guided-demonstration-replay", token_type: "Bearer", expires_in: 3600 });
    const body = method === "GET" ? null : JSON.parse(await request.clone().text() || "null") as Json | null;
    const requestId = request.headers.get("PayPal-Request-Id") ?? randomUUID();
    const parts = path.split("/");
    if (path === "/v2/checkout/orders" && method === "POST") {
      const id = this.orderIdFor(requestId), existing = await this.load(id); if (existing) return response(existing.order, 201);
      const unit = body!.purchase_units[0];
      const order = { id, intent: body!.intent, status: "CREATED", purchase_units: [{ amount: unit.amount, custom_id: unit.custom_id, payments: { captures: [] as Json[], authorizations: [] as Json[], refunds: [] as Json[] } }], links: [] as Json[] };
      await this.save(id, { order, requests: {} }); return response(order, 201);
    }
    if (parts[1] === "v2" && parts[2] === "checkout" && parts[3] === "orders" && parts[4]) {
      const document = await this.load(parts[4]); if (!document) return notFound();
      const order = document.order, unit = order.purchase_units[0];
      if (parts.length === 5 && method === "GET") return response(order);
      if (parts.length === 6 && method === "POST" && (parts[5] === "capture" || parts[5] === "authorize")) {
        const capture = parts[5] === "capture", list = (capture ? unit.payments.captures : unit.payments.authorizations) as Json[];
        if (order.status === "COMPLETED" && list.length === 1) return response(order, 201);
        if (order.status !== "APPROVED" || order.intent !== (capture ? "CAPTURE" : "AUTHORIZE")) return response({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] }, 422);
        order.status = "COMPLETED";
        list.push({ id: this.childId(capture ? "C" : "A", order.id, 1), status: capture ? "COMPLETED" : "CREATED", amount: { currency_code: unit.amount.currency_code, value: unit.amount.value } });
        await this.save(order.id, document); return response(order, 201);
      }
      return notFound();
    }
    const child = CHILD_ID.exec(parts[4] ?? "");
    if (parts[1] === "v2" && parts[2] === "payments" && child) {
      const document = await this.load(REPLAY_ID_MARKER + "O-" + child[2]); if (!document) return notFound();
      const payments = document.order.purchase_units[0].payments, id = parts[4]!;
      if (parts[3] === "authorizations" && child[1] === "A") {
        const authorization = (payments.authorizations as Json[]).find(item => item.id === id); if (!authorization) return notFound();
        if (parts.length === 5 && method === "GET") return response(authorization);
        if (parts.length === 6 && parts[5] === "void" && method === "POST") {
          if (authorization.status !== "VOIDED") { authorization.status = "VOIDED"; await this.save(document.order.id, document); }
          return response(authorization);
        }
        if (parts.length === 6 && parts[5] === "capture" && method === "POST") {
          const prior = document.requests[requestId];
          if (prior?.kind === "capture") return response((payments.captures as Json[]).find(item => item.id === prior.id), 201);
          if (!["CREATED", "PARTIALLY_CAPTURED"].includes(authorization.status)) return response({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_VOIDED" }] }, 422);
          const capture = { id: this.childId("C", document.order.id, payments.captures.length + 1), status: "COMPLETED", amount: body!.amount };
          payments.captures.push(capture); authorization.status = "PARTIALLY_CAPTURED"; document.requests[requestId] = { kind: "capture", id: capture.id };
          await this.save(document.order.id, document); return response(capture, 201);
        }
      }
      if (parts[3] === "captures" && child[1] === "C") {
        const capture = (payments.captures as Json[]).find(item => item.id === id); if (!capture) return notFound();
        if (parts.length === 5 && method === "GET") return response(capture);
        if (parts.length === 6 && parts[5] === "refund" && method === "POST") {
          const prior = document.requests[requestId];
          if (prior?.kind === "refund") return response((payments.refunds as Json[]).find(item => item.id === prior.id), 201);
          const refund = { id: this.childId("R", document.order.id, payments.refunds.length + 1), status: "COMPLETED", amount: body!.amount, custom_id: body!.custom_id };
          payments.refunds.push(refund); capture.status = "PARTIALLY_REFUNDED"; document.requests[requestId] = { kind: "refund", id: refund.id };
          await this.save(document.order.id, document); return response(refund, 201);
        }
      }
      if (parts[3] === "refunds" && child[1] === "R" && parts.length === 5 && method === "GET") {
        const refund = (payments.refunds as Json[]).find(item => item.id === id); return refund ? response(refund) : notFound();
      }
    }
    return notFound();
  }
}
