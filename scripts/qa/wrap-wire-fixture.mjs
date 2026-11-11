// The pinned real core and official Toolkit execute against this injected local transport.
// It never contacts a provider, sends an email or moves funds.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** @param {{storePath?: string,beforeCall?: (call: any) => Promise<void>}} options */
export function createWrapWireFixture(options = {}) {
  const config = { environment: /** @type {const} */ ("sandbox"), baseUrl: /** @type {const} */ ("https://api-m.sandbox.paypal.com"), isolatedProject: "opening-night:venue", clientId: "controlled-wrap-wire-client", clientSecret: "controlled-wrap-wire-secret" };
  const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",")}}`;
  const merchantFingerprint = createHash("sha256").update(canonical({ environment: config.environment, baseUrl: config.baseUrl, isolatedProject: config.isolatedProject, clientId: config.clientId })).digest("hex");
  const saved = options.storePath && existsSync(options.storePath) ? JSON.parse(readFileSync(options.storePath, "utf8")) : {};
  const invoices = new Map(saved.invoices ?? []), orders = new Map(saved.orders ?? []), refunds = new Map(saved.refunds ?? []), expiresAt = saved.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  const save = () => { if (options.storePath) { const temporary = `${options.storePath}.${randomUUID()}`; writeFileSync(temporary, JSON.stringify({ invoices: [...invoices], orders: [...orders], refunds: [...refunds], expiresAt }), { mode: 0o600 }); renameSync(temporary, options.storePath); } };
  save();
  /** @type {{lostCreate:boolean,lostSend:boolean,lostCancel:boolean,readsUnavailable:boolean,searchUnavailable:boolean,searchDuplicate:boolean,partialSearch:boolean,createStatus:number,forceId:string|null,admissionRevoked:boolean,admissionExpiresAt:string|null,toolkitUnavailable:boolean,afterMutationReadsUnavailable:boolean}} */
  const behavior = { lostCreate: false, lostSend: false, lostCancel: false, readsUnavailable: false, searchUnavailable: false, searchDuplicate: false, partialSearch: false, createStatus: 201, forceId: null, admissionRevoked: false, admissionExpiresAt: null, toolkitUnavailable: false, afterMutationReadsUnavailable: false };
  /** @type {{method:string,path:string,query:string,body:any,toolkit:boolean}[]} */
  const calls = [];
  const json = (value, status = 200) => Response.json(value, { status, headers: { "paypal-debug-id": "controlled-wrap-wire" } });
  /** @type {typeof fetch} */
  const transport = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url), toolkit = url.origin === "https://api.sandbox.paypal.com";
    if (![config.baseUrl, "https://api.sandbox.paypal.com"].includes(url.origin)) throw new Error("Controlled wrap fixture refused a foreign host");
    if (url.pathname === "/v1/oauth2/token") { await options.beforeCall?.({ method: "POST", path: url.pathname, body: null, toolkit }); return json({ access_token: "controlled-only-token", token_type: "Bearer", expires_in: 3600 }); }
    const body = request.method === "POST" ? JSON.parse(await request.clone().text() || "null") : null, call = { method: request.method, path: url.pathname, query: url.search, body, toolkit };
    calls.push(call); await options.beforeCall?.(call);
    if (toolkit && behavior.toolkitUnavailable) return json({ name: "CONTROLLED_UNAVAILABLE" }, 503);
    if (url.pathname === "/v2/invoicing/invoices" && request.method === "POST") {
      if (toolkit) throw new Error("Toolkit fixture rejects every mutation");
      if (behavior.createStatus !== 201) return json({ name: "CONTROLLED_REFUSAL" }, behavior.createStatus);
      const existing = [...invoices.values()].find(value => value.detail.invoice_number === body.detail.invoice_number && value.detail.reference === body.detail.reference);
      if (existing) return json({ name: "DUPLICATE_INVOICE_NUMBER" }, 422);
      const id = behavior.forceId ?? "INV2-" + randomUUID().replaceAll("-", "").slice(0, 22), day = new Date().toISOString().slice(0, 10), invoice = { ...structuredClone(body), id, status: "DRAFT", detail: { ...body.detail, invoice_date: day, payment_term: { term_type: "DUE_ON_RECEIPT", due_date: day }, metadata: { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${id}` } }, amount: body.items[0].unit_amount, due_amount: body.items[0].unit_amount };
      invoices.set(id, invoice); save();
      if (behavior.lostCreate) throw new TypeError("Controlled lost response after retaining the original invoice");
      return json({ id }, 201);
    }
    if (url.pathname === "/v2/invoicing/search-invoices" && request.method === "POST") {
      if (toolkit) throw new Error("Toolkit fixture rejects broad search");
      if (behavior.searchUnavailable) return json({ name: "CONTROLLED_UNAVAILABLE" }, 503);
      const found = [...invoices.values()].filter(value => value.detail.invoice_number === body.invoice_number && value.detail.reference === body.reference);
      if (behavior.searchDuplicate && found.length) { const duplicate = structuredClone(found[0]), id = "DUP-" + duplicate.id; duplicate.id = id; invoices.set(id, duplicate); if (!found.some(item => item.id === id)) found.push(duplicate); }
      return json({ items: found.map(value => ({ id: value.id, detail: value.detail })), total_pages: found.length ? 1 : 0, total_items: found.length + (behavior.partialSearch ? 1 : 0) });
    }
    const match = /^\/v2\/invoicing\/invoices\/([A-Za-z0-9._-]+)(?:\/(send|cancel))?$/.exec(url.pathname);
    if (match) {
      const invoice = invoices.get(match[1]); if (!invoice) return json({ name: "RESOURCE_NOT_FOUND" }, 404);
      if (request.method === "GET" && !match[2]) { if (behavior.readsUnavailable) return json({ name: "CONTROLLED_UNAVAILABLE" }, 503); return json(structuredClone(invoice)); }
      if (request.method === "POST" && match[2]) {
        if (toolkit || JSON.stringify(body) !== JSON.stringify({ send_to_recipient: false, send_to_invoicer: false })) throw new Error("Controlled fixture refused notifications or Toolkit mutation");
        if (match[2] === "send" && invoice.status !== "DRAFT" || match[2] === "cancel" && !["SENT", "SHARED", "UNPAID"].includes(invoice.status)) return json({ name: "INVALID_STATE" }, 422);
        invoice.status = match[2] === "send" ? "SHARED" : "CANCELLED"; save();
        if (behavior.afterMutationReadsUnavailable) behavior.readsUnavailable = true;
        if (match[2] === "send" && behavior.lostSend || match[2] === "cancel" && behavior.lostCancel) throw new TypeError("Controlled lost response after original invoice mutation");
        return new Response(null, { status: 202 });
      }
    }
    if (request.method === "GET" && url.pathname.startsWith("/v2/checkout/orders/")) { const order = orders.get(url.pathname.split("/").at(-1)); return order ? json(structuredClone(order)) : json({ name: "RESOURCE_NOT_FOUND" }, 404); }
    if (request.method === "GET" && url.pathname.startsWith("/v2/payments/refunds/")) { const refund = refunds.get(url.pathname.split("/").at(-1)); return refund ? json(structuredClone(refund)) : json({ name: "RESOURCE_NOT_FOUND" }, 404); }
    throw new Error("Unexpected controlled wrap request");
  };
  const admissions = show => behavior.admissionRevoked ? [] : [{ id: "controlled-owned-invoice-" + show.tenantId, tenantId: show.tenantId, label: "Owned sponsor sandbox account", issuerEmail: "venue.controlled@invoice.invalid", recipientEmail: "sponsor.controlled@invoice.invalid", purposePrefix: "Controlled show service", currency: "USD", maxInvoiceMinor: 100_000, merchantFingerprint, expiresAt: behavior.admissionExpiresAt ?? expiresAt, controlledSandbox: true }];
  const collect = (id, paidMinor, refundedMinor = 0) => {
    const invoice = invoices.get(id); if (!invoice) throw new Error("Unknown original controlled invoice"); const amount = Math.round(Number(invoice.amount.value) * 100), money = value => ({ currency_code: "USD", value: (value / 100).toFixed(2) });
    invoice.status = refundedMinor ? refundedMinor === paidMinor ? "REFUNDED" : "PARTIALLY_REFUNDED" : paidMinor === amount ? "PAID" : "PARTIALLY_PAID";
    invoice.payments = { paid_amount: money(paidMinor), transactions: [{ payment_id: "PAY-" + id.slice(-16), type: "PAYPAL", method: "PAYPAL", amount: money(paidMinor), payment_date: new Date().toISOString().slice(0, 10) }] };
    if (refundedMinor) invoice.refunds = { refund_amount: money(refundedMinor), transactions: [{ refund_id: "REF-" + id.slice(-16), type: "PAYPAL", method: "PAYPAL", amount: money(refundedMinor), refund_date: new Date().toISOString().slice(0, 10) }] };
    invoice.due_amount = money(refundedMinor ? 0 : amount - paidMinor); save();
  };
  return { config, transport, toolkitTransport: transport, admissions, merchantFingerprint, behavior, calls, invoices, orders, refunds, collect, save };
}
