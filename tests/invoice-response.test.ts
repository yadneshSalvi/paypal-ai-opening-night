import test from "node:test";
import assert from "node:assert/strict";
import { SandboxCommerceRestGateway, sandboxInvoiceIdFromHref, type DraftInvoice } from "@fracture/paypal-core";
import { invoiceEnvelope, invoiceEnvelopeProblem, invoiceObservationFromRaw, validateInvoiceObservation } from "../src/domain/wrap/invoices";
import type { InvoiceDraft } from "../src/domain/wrap/contracts";
import { documentedInvoice, responseWire } from "./invoice-response-fixture";

const request: DraftInvoice = { invoiceNumber: "ON-RESPONSE", reference: "opening-night:controlled-response", merchantEmail: "issuer@owned.invalid", recipientEmail: "recipient@owned.invalid", itemName: "Controlled invoice response service", money: { currency: "USD", minor: 100 } };
const draft = { request } as InvoiceDraft;
const original = "INV2-CONTROLLED-RESPONSE", path = "/v2/invoicing/invoices/" + original;
const unsafeHrefs: unknown[] = [
  undefined, null, {}, 42, "", path, "//api.sandbox.paypal.com" + path,
  "http://api.sandbox.paypal.com" + path, "https://api.paypal.com" + path,
  "https://api-m.paypal.com" + path, "https://api.sandbox.paypal.com.attacker.invalid" + path,
  "https://attacker.invalid@api.sandbox.paypal.com" + path,
  "https://api.sandbox.paypal.com@attacker.invalid" + path,
  "https://api.sandbox.paypal.com:443" + path,
  "https://api.sandbox.paypal.com:8443" + path,
  "https://API.SANDBOX.PAYPAL.COM" + path,
  "https://api.sandbox.paypal.com." + path,
  " https://api.sandbox.paypal.com" + path,
  "https://api.sandbox.paypal.com" + path + "\n",
  "https://api.sandbox.paypal.com" + path + "\r\n",
  "https://api.sandbox.paypal.com" + path + "?expand=all",
  "https://api.sandbox.paypal.com" + path + "#fragment",
  "https://api.sandbox.paypal.com" + path + "/",
  "https://api.sandbox.paypal.com" + path + "/send",
  "https://api.sandbox.paypal.com/v2/invoicing/invoices/",
  "https://api.sandbox.paypal.com/v2/invoicing/invoices/INV%2FOTHER",
  "https://api.sandbox.paypal.com/v2/invoicing/invoices/../INV2-OTHER",
  "https://api.sandbox.paypal.com/v2/invoicing/invoices/%49NV2-OTHER",
  "https://api.sandbox.paypal.com/v1/payments/payouts/INV2-OTHER",
  "https://api.sandbox.paypal.com\\v2\\invoicing\\invoices\\INV2-OTHER",
  "https://api.sandbox.paypal.com/v2/invoicing/invoices/" + "A".repeat(129),
];

test("invoice href ID parsing accepts only exact sandbox invoice resources", () => {
  for (const host of ["api-m.sandbox.paypal.com", "api.sandbox.paypal.com"]) assert.equal(sandboxInvoiceIdFromHref("https://" + host + path), original);
  for (const value of unsafeHrefs) assert.equal(sandboxInvoiceIdFromHref(value), null, String(value));
});

test("installed core extracts a legacy href ID and reads it through canonical outbound transport", async t => {
  for (const host of ["api-m.sandbox.paypal.com", "api.sandbox.paypal.com"]) await t.test(host, async () => {
    const wire = responseWire(id => "https://" + host + "/v2/invoicing/invoices/" + id);
    const result = await new SandboxCommerceRestGateway(wire.config, wire.transport).createInvoice(request, AbortSignal.timeout(5000));
    assert.equal(result.outcome, "succeeded"); if (result.outcome !== "succeeded") return;
    assert.equal(wire.invoices.size, 1); assert.equal(result.value.id, [...wire.invoices.keys()][0]);
    assert.equal(wire.calls.filter(call => call.path.endsWith("/search-invoices")).length, 0);
    assert.deepEqual(wire.calls.map(call => call.method + " " + call.path), ["POST /v2/invoicing/invoices", "GET /v2/invoicing/invoices/" + result.value.id]);
    assert.ok(wire.urls.every(value => new URL(value).origin === "https://api-m.sandbox.paypal.com"));
  });
});

test("unsafe create href never authorizes a GET, replacement create or external origin", async () => {
  for (const href of unsafeHrefs) {
    const wire = responseWire(() => href); wire.behavior.searchUnavailable = true;
    const result = await new SandboxCommerceRestGateway(wire.config, wire.transport).createInvoice(request, AbortSignal.timeout(5000));
    assert.equal(result.outcome, "unknown", String(href));
    assert.equal(wire.calls.filter(call => call.method === "GET").length, 0);
    assert.equal(wire.calls.filter(call => call.path === "/v2/invoicing/invoices").length, 1);
    assert.ok(wire.urls.every(value => new URL(value).origin === "https://api-m.sandbox.paypal.com"));
  }
});

test("documented absent partial-payment object and complete zero discounts preserve exact reviewed evidence", () => {
  const raw = documentedInvoice(), envelope = invoiceEnvelope(raw), observation = invoiceObservationFromRaw(raw);
  assert.equal(invoiceEnvelopeProblem(draft, envelope), null);
  assert.equal(validateInvoiceObservation(draft, observation, envelope, original), null);
  assert.equal(envelope.configuration.allowPartialPayment, false);
  assert.equal(envelope.configuration.allowTip, false);
  assert.equal(envelope.paymentTerm, "NO_DUE_DATE");
  assert.deepEqual(envelope.adjustments.discount, raw.amount.breakdown.discount);
  assert.deepEqual(observation.payments, []); assert.deepEqual(observation.refunds, []);
  const explicit = structuredClone(raw); explicit.configuration.partial_payment = { allow_partial_payment: false };
  assert.deepEqual(invoiceEnvelope(explicit), envelope);
  const flat = structuredClone(raw); flat.amount.breakdown.discount = { currency_code: "USD", value: "0.00" };
  assert.doesNotThrow(() => invoiceEnvelope(flat));
  assert.equal(invoiceEnvelopeProblem(draft, invoiceEnvelope(flat), envelope), "INVOICE_REVIEW_ENVELOPE_CHANGED");
});

test("absent defaults do not accept null, true, malformed or unknown policy fields", () => {
  const variants: unknown[] = [null, false, true, "", [], {}, { allow_partial_payment: null }, { allow_partial_payment: "false" }, { allow_partial_payment: true }, { allow_partial_payment: false, minimum_amount: null }, { allow_partial_payment: false, minimum_amount_due: { currency_code: "USD", value: "0.00" } }, { allow_partial_payment: false, future_policy: false }];
  for (const value of variants) { const raw = documentedInvoice(); raw.configuration.partial_payment = value; assert.throws(() => invoiceEnvelope(raw)); }
  for (const key of ["allow_tip", "tax_calculated_after_discount", "tax_inclusive"]) for (const value of [null, "false", 0, {}, []]) { const raw = documentedInvoice(); raw.configuration[key] = value; assert.throws(() => invoiceEnvelope(raw)); }
  for (const value of [undefined, true]) { const raw = documentedInvoice(); raw.configuration.allow_tip = value; assert.throws(() => invoiceEnvelope(raw)); }
});

test("complete zero discount support rejects nonzero, mixed, incomplete and unknown adjustments", () => {
  const zero = { currency_code: "USD", value: "0.00" };
  const variants: unknown[] = [
    null, [], {}, false,
    { invoice_discount: { amount: zero } }, { item_discount: zero },
    { invoice_discount: null, item_discount: zero },
    { invoice_discount: {}, item_discount: zero },
    { invoice_discount: { amount: zero }, item_discount: null },
    { invoice_discount: { amount: { ...zero, value: "0.01" } }, item_discount: zero },
    { invoice_discount: { amount: zero }, item_discount: { ...zero, value: "-0.01" } },
    { invoice_discount: { amount: zero }, item_discount: { ...zero, currency_code: "EUR" } },
    { invoice_discount: { amount: zero, percent: "0" }, item_discount: zero },
    { invoice_discount: { amount: zero, percent: "5" }, item_discount: zero },
    { invoice_discount: { amount: zero }, item_discount: zero, future_discount: zero },
    { invoice_discount: { amount: zero }, item_discount: { ...zero, unverified: 0 } },
    { ...zero, invoice_discount: { amount: zero }, item_discount: zero },
    { ...zero, value: "0.01" }, { ...zero, value: "0.000" },
  ];
  for (const value of variants) { const raw = documentedInvoice(); raw.amount.breakdown.discount = value; assert.throws(() => invoiceEnvelope(raw)); }
  for (const key of ["shipping", "custom", "tax_total", "tip"]) for (const value of [null, { ...zero, value: "0.01" }, { ...zero, future: false }]) { const raw = documentedInvoice(); raw.amount.breakdown[key] = value; assert.throws(() => invoiceEnvelope(raw)); }
  for (const change of [(raw: any) => { raw.amount.breakdown.item_total.value = "0.99"; }, (raw: any) => { raw.amount.breakdown.future_adjustment = zero; }]) { const raw = documentedInvoice(); change(raw); assert.throws(() => invoiceEnvelope(raw)); }
});

test("response compatibility preserves changed original identity, date, terms and balance rejection", () => {
  const initial = invoiceEnvelope(documentedInvoice());
  const changes: ((raw: any) => void)[] = [
    raw => { raw.invoicer.email_address = "other@owned.invalid"; },
    raw => { raw.primary_recipients[0].billing_info.email_address = "other@owned.invalid"; },
    raw => { raw.items[0].name = "Changed purpose"; },
    raw => { raw.detail.reference = "changed"; },
    raw => { raw.detail.invoice_date = "2099-01-01"; },
    raw => { raw.detail.payment_term.term_type = "NET_30"; },
    raw => { raw.configuration.tax_inclusive = true; },
  ];
  for (const change of changes) { const raw = documentedInvoice(); change(raw); assert.ok(invoiceEnvelopeProblem(draft, invoiceEnvelope(raw), initial)); }
  const raw = documentedInvoice(); raw.due_amount.value = "0.99";
  assert.equal(validateInvoiceObservation(draft, invoiceObservationFromRaw(raw), invoiceEnvelope(raw), original), "INVOICE_UNPAID_BALANCE_UNKNOWN");
  for (const key of ["payments", "refunds"]) { const value = documentedInvoice(); value[key] = null; assert.throws(() => invoiceObservationFromRaw(value)); }
});
