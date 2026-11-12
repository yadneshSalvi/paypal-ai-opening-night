import assert from "node:assert/strict";
import { createWrapWireFixture } from "../scripts/qa/wrap-wire-fixture.mjs";

/** Synthetic parties/IDs only. This models documented response shapes, never provider qualification. */
export function documentedInvoiceResponse(input: Record<string, any>) {
  const raw = structuredClone(input);
  delete raw.configuration.partial_payment;
  raw.configuration.tax_calculated_after_discount = false;
  raw.configuration.tax_inclusive = false;
  raw.detail.payment_term = { term_type: "NO_DUE_DATE" };
  raw.amount = { ...raw.amount, breakdown: {
    item_total: structuredClone(raw.items[0].unit_amount),
    discount: { invoice_discount: { amount: { currency_code: "USD", value: "0.00" } }, item_discount: { currency_code: "USD", value: "0.00" } },
    tax_total: { currency_code: "USD", value: "0.00" },
  } };
  return raw;
}

export function responseWire(href: (id: string) => unknown = id => "https://api.sandbox.paypal.com/v2/invoicing/invoices/" + id) {
  const wire = createWrapWireFixture(), original = wire.transport, urls: string[] = [];
  wire.transport = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url);
    assert.equal(url.origin, "https://api-m.sandbox.paypal.com", "A returned href must never choose an outbound origin");
    urls.push(request.url);
    const response = await original(input, init);
    if (request.method === "POST" && url.pathname === "/v2/invoicing/invoices" && response.ok) {
      const body = await response.json(), saved = wire.invoices.get(body.id);
      assert.ok(saved, "Controlled original must exist before a create response");
      wire.invoices.set(body.id, documentedInvoiceResponse(saved));
      return Response.json({ href: href(body.id), rel: "self", method: "GET" }, { status: 201, headers: { "paypal-debug-id": "controlled-legacy-invoice-response" } });
    }
    return response;
  };
  return { ...wire, urls };
}

export function documentedInvoice() {
  return documentedInvoiceResponse({
    id: "INV2-CONTROLLED-RESPONSE", status: "DRAFT",
    detail: { invoice_number: "ON-RESPONSE", reference: "opening-night:controlled-response", currency_code: "USD", invoice_date: "2026-11-11", payment_term: { term_type: "DUE_ON_RECEIPT" } },
    invoicer: { email_address: "issuer@owned.invalid" },
    primary_recipients: [{ billing_info: { email_address: "recipient@owned.invalid" } }],
    items: [{ name: "Controlled invoice response service", quantity: "1", unit_amount: { currency_code: "USD", value: "1.00" } }],
    amount: { currency_code: "USD", value: "1.00" }, due_amount: { currency_code: "USD", value: "1.00" },
    configuration: { allow_tip: false, partial_payment: { allow_partial_payment: false } },
  });
}
