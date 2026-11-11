// Real core HTTP encoding/decoding against an owned fake fetch. This never calls a network provider.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** @param {{ storePath?: string, beforeCall?: (call: any) => Promise<void> }} options */
export function createPayoutWireFixture(options = {}) {
  /** @type {import("@fracture/paypal-core").SandboxConfig} */
  const config = { environment: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com", isolatedProject: "opening-night:venue", clientId: "controlled-payout-wire-client", clientSecret: "controlled-payout-wire-secret" };
  const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",")}}`;
  const merchantFingerprint = createHash("sha256").update(canonical({ environment: config.environment, baseUrl: config.baseUrl, isolatedProject: config.isolatedProject, clientId: config.clientId })).digest("hex");
  const batches = new Map(options.storePath && existsSync(options.storePath) ? JSON.parse(readFileSync(options.storePath, "utf8")) : []);
  const save = () => { if (options.storePath) { const temporary = options.storePath + "." + randomUUID(); writeFileSync(temporary, JSON.stringify([...batches]), { mode: 0o600 }); renameSync(temporary, options.storePath); } };
  /** @type {{ lostCreate: boolean, duplicateCreate: boolean, lostCancel: boolean, unreadableCreate: boolean, createStatus: number, batchUnavailable: boolean, itemUnavailable: boolean, partialBatch: boolean, foreignReceiver: boolean, forceItemStatus: string | null, cancelUnavailable: boolean }} */
  const behavior = { lostCreate: false, duplicateCreate: false, lostCancel: false, unreadableCreate: false, createStatus: 201, batchUnavailable: false, itemUnavailable: false, partialBatch: false, foreignReceiver: false, forceItemStatus: null, cancelUnavailable: false };
  /** @type {{ method: string, path: string, body: any, requestId: string | null }[]} */
  const calls = [];
  const json = (value, status = 200) => Response.json(value, { status, headers: { "paypal-debug-id": "controlled-payout-wire" } });
  /** @type {typeof fetch} */
  const transport = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url), path = url.pathname;
    if (url.origin !== config.baseUrl) throw new Error("Controlled payout fixture refused a foreign host");
    if (path === "/v1/oauth2/token") return json({ access_token: "controlled-only-token", token_type: "Bearer", expires_in: 3600 });
    const body = request.method === "POST" ? JSON.parse(await request.clone().text() || "null") : null, call = { method: request.method, path, body, requestId: request.headers.get("PayPal-Request-Id") };
    calls.push(call); await options.beforeCall?.(call);
    if (path === "/v1/payments/payouts" && request.method === "POST") {
      const prior = [...batches.values()].find(batch => batch.batch_header.sender_batch_header.sender_batch_id === body.sender_batch_header.sender_batch_id);
      if (prior) return json({ name: "DUPLICATE_BATCH_ID", links: [{ rel: "duplicate_batch", href: config.baseUrl + "/v1/payments/payouts/" + prior.batch_header.payout_batch_id }] }, 400);
      if (behavior.createStatus !== 201) return json({ name: "CONTROLLED_REFUSAL" }, behavior.createStatus);
      const id = "B" + randomUUID().replaceAll("-", "").slice(0, 20);
      const items = body.items.map(item => ({ payout_item_id: "I" + randomUUID().replaceAll("-", "").slice(0, 20), payout_batch_id: id, transaction_status: behavior.forceItemStatus ?? (item.receiver.startsWith("unclaimed.") ? "UNCLAIMED" : "SUCCESS"), transaction_id: "T" + randomUUID().replaceAll("-", "").slice(0, 20), payout_item: item, payout_item_fee: { currency: "USD", value: "0.25" }, time_processed: new Date().toISOString() }));
      const total = items.reduce((sum, item) => sum + Math.round(Number(item.payout_item.amount.value) * 100), 0);
      const batch = { batch_header: { payout_batch_id: id, sender_batch_header: body.sender_batch_header, batch_status: "SUCCESS", amount: { currency: "USD", value: (total / 100).toFixed(2) }, fees: { currency: "USD", value: (items.length * .25).toFixed(2) } }, items, total_pages: 1, total_items: items.length };
      batches.set(id, batch); save();
      if (behavior.duplicateCreate) return json({ name: "DUPLICATE_BATCH_ID", links: [{ rel: "duplicate_batch", href: config.baseUrl + "/v1/payments/payouts/" + id }] }, 400);
      if (behavior.lostCreate) throw new TypeError("Controlled response loss after the original batch was retained");
      if (behavior.unreadableCreate) return new Response("{incomplete", { status: 201 });
      return json({ batch_header: { ...batch.batch_header, batch_status: "PENDING" } }, 201);
    }
    if (path.startsWith("/v1/payments/payouts/") && request.method === "GET") {
      if (behavior.batchUnavailable) return json({ name: "CONTROLLED_UNAVAILABLE" }, 503);
      const found = batches.get(path.split("/").at(-1)); if (!found) return json({ name: "NOT_FOUND" }, 404);
      const result = structuredClone(found);
      if (behavior.partialBatch) result.total_items++;
      if (behavior.foreignReceiver) result.items[0].payout_item.receiver = "other.controlled@payout.invalid";
      return json(result);
    }
    if (path.startsWith("/v1/payments/payouts-item/")) {
      const id = path.split("/")[4], item = [...batches.values()].flatMap(batch => batch.items).find(item => item.payout_item_id === id);
      if (!item) return json({ name: "NOT_FOUND" }, 404);
      if (request.method === "POST" && path.endsWith("/cancel")) {
        if (behavior.cancelUnavailable) return json({ name: "CONTROLLED_UNAVAILABLE" }, 503);
        if (item.transaction_status !== "UNCLAIMED") return json({ name: "NOT_UNCLAIMED" }, 422);
        item.transaction_status = "RETURNED"; item.time_processed = new Date().toISOString(); save();
        if (behavior.lostCancel) throw new TypeError("Controlled cancellation response loss");
        return json(item);
      }
      if (request.method === "GET") {
        if (behavior.itemUnavailable) return json({ name: "CONTROLLED_UNAVAILABLE" }, 503);
        const result = structuredClone(item); if (behavior.foreignReceiver) result.payout_item.receiver = "other.controlled@payout.invalid"; return json(result);
      }
    }
    throw new Error("Unexpected controlled payout fixture request");
  };
  const admissions = show => show.resources.filter(person => person.kind === "person").flatMap(person => [false, true].map(unclaimed => ({ id: `${show.tenantId}:${person.id}:${unclaimed ? "unclaimed" : "credited"}`, tenantId: show.tenantId, personId: person.id, label: `${unclaimed ? "Controlled unclaimed" : "Controlled credited"} account · ${person.name}`, recipientType: "EMAIL", receiver: `${unclaimed ? "unclaimed." : ""}${person.id}.${show.tenantId}@payout.invalid`, merchantFingerprint, expiresAt: new Date(Date.parse(show.createdAt) + 7 * 86400000).toISOString(), maxPayoutMinor: 50000, controlledSandbox: true })));
  return { config, transport, admissions, merchantFingerprint, batches, behavior, calls, save };
}
