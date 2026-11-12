/** Extends the controlled SDK transport with original rental authorization/void routes. */
import type { Pool } from "pg";
import { CommerceWire } from "./commerce-wire";
export class DisruptionWire extends CommerceWire {
  constructor(pool: Pool) {
    super(pool); const commerce = this.fetch;
    this.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init), path = new URL(request.url).pathname;
      const order = this.orders.get(path.split("/")[4]!);
      const authorizationOwner = [...this.orders.values()].find(value => value.purchase_units[0].payments.authorizations.some((item: { id: string }) => path === `/v2/payments/authorizations/${item.id}` || path.startsWith(`/v2/payments/authorizations/${item.id}/`)));
      if (!(order && path.endsWith("/authorize")) && !authorizationOwner) return commerce(input, init);
      const body = request.method === "GET" ? null : JSON.parse(await request.clone().text() || "null"), requestId = request.headers.get("PayPal-Request-Id");
      const operation = request.method === "GET" ? null : (await pool.query("SELECT status FROM paycore_operations WHERE provider_request_id=$1", [requestId])).rows[0];
      const call = { method: request.method, path, body, requestId, sdkIdempotencyKey: request.headers.get("Idempotency-Key"), durable: request.method === "GET" || operation?.status === "dispatching" };
      this.calls.push(call); await this.before?.(call);
      if (order && path.endsWith("/authorize") && request.method === "POST") {
        if (order.status !== "APPROVED") return this.json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] }, 422);
        order.status = "COMPLETED"; const unit = order.purchase_units[0];
        unit.payments.authorizations.push({ id: this.id("AUTH"), status: "CREATED", amount: { currency_code: unit.amount.currency_code, value: unit.amount.value } });
        return this.json(order, 201);
      }
      const unit = authorizationOwner!.purchase_units[0], auth = unit.payments.authorizations.find((item: { id: string }) => path.includes("/" + item.id));
      if (request.method === "GET") return this.json(auth);
      if (path.endsWith("/void")) { auth.status = "VOIDED"; return this.json(auth); }
      if (path.endsWith("/capture")) { const capture = { id: this.id("RENTAL-CAPTURE"), status: "COMPLETED", amount: body.amount }; unit.payments.captures.push(capture); auth.status = "PARTIALLY_CAPTURED"; return this.json(capture, 201); }
      return this.json({ name: "RESOURCE_NOT_FOUND" }, 404);
    };
  }
}
