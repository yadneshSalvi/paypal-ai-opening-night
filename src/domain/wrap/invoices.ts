import { z } from "zod";
import type { InvoiceObservation } from "@fracture/paypal-core";
import { DomainError, type ShowSnapshot } from "../contracts";
import { digest } from "../hash";
import type { EntryRecord, InvoiceAdmission, InvoiceDraft, InvoiceEnvelope, InvoiceOperation, InvoiceRead, InvoiceReview, InvoiceView, WrapRecord, WrapState } from "./contracts";

export const INVOICE_AUTHORITY_MS = 10 * 60_000, INVOICE_READ_FRESH_MS = 5 * 60_000;
export function wrapRecords<K extends WrapRecord["kind"]>(state: WrapState, kind: K) { return state.records.filter(record => record.kind === kind) as Extract<WrapRecord, { kind: K }>[]; }
export function currentEntries(state: WrapState): EntryRecord[] { const entries = new Map<string, EntryRecord>(); for (const record of wrapRecords(state, "entry")) entries.set(record.entry.entryId, record); return [...entries.values()]; }
export function invoiceDraft(state: WrapState, id: string) { const value = wrapRecords(state, "invoice_draft").find(record => record.id === id); if (!value) throw new DomainError("INVOICE_NOT_FOUND", "This invoice is not part of the current production.", 404); return value; }
export const latestInvoiceRead = (state: WrapState, id: string) => wrapRecords(state, "invoice_read").findLast(record => record.invoiceId === id) ?? null;
export function ownedInvoiceId(state: WrapState, invoiceId: string) { return wrapRecords(state, "invoice_read").find(record => record.invoiceId === invoiceId && record.result.verified && record.result.value)?.result.value?.id ?? null; }
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVOICE_ENVELOPE_UNKNOWN"); return value as Record<string, unknown>; };
const text = (value: unknown, max = 240): string => { if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("INVOICE_ENVELOPE_UNKNOWN"); return value; };
const optionalText = (value: unknown, max = 2400) => value === undefined || value === null || value === "" ? null : text(value, max);
const optionalBoolean = (value: unknown) => value === undefined ? null : typeof value === "boolean" ? value : (() => { throw new Error("INVOICE_ENVELOPE_UNKNOWN"); })();
const date = (value: unknown) => z.iso.date().parse(value);
export function providerMinor(value: unknown): number { const v = object(value); if (v.currency_code !== "USD" || typeof v.value !== "string" || !/^\d{1,10}(?:\.\d{1,2})?$/.test(v.value)) throw new Error("INVOICE_MONEY_UNKNOWN"); const [whole, fraction = ""] = v.value.split("."); const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0")); if (!Number.isSafeInteger(amount)) throw new Error("INVOICE_MONEY_UNKNOWN"); return amount; }
const terms = new Set(["DUE_ON_RECEIPT", "DUE_ON_DATE_SPECIFIED", "NET_10", "NET_15", "NET_30", "NET_45", "NET_60", "NET_90", "NO_DUE_DATE"]);
const invoiceStatuses = new Set(["DRAFT", "SENT", "SCHEDULED", "PAID", "MARKED_AS_PAID", "CANCELLED", "REFUNDED", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "MARKED_AS_REFUNDED", "UNPAID", "PAYMENT_PENDING", "AUTO_CANCELLED", "PAID_EXTERNAL", "REFUNDED_EXTERNAL", "SHARED"]);
function partialPaymentsDisabled(value: unknown): boolean {
  // Invoicing v2 omits this optional object when the documented false default applies.
  // A present object must explicitly disable partial payment and contain no minimum or unknown policy.
  if (value === undefined) return true;
  const partial = object(value);
  return partial.allow_partial_payment === false && Object.keys(partial).every(key => key === "allow_partial_payment");
}
function exactMoney(value: unknown): number {
  const money = object(value);
  if (Object.keys(money).some(key => key !== "currency_code" && key !== "value")) throw new Error("INVOICE_ADJUSTMENTS_CHANGED");
  return providerMinor(money);
}
function zeroDiscount(value: unknown): boolean {
  const discount = object(value);
  // Retain compatibility with an explicit flat zero; never reinterpret a mixed or partial structure.
  if ("currency_code" in discount || "value" in discount) return exactMoney(discount) === 0;
  if (Object.keys(discount).length !== 2 || !("invoice_discount" in discount) || !("item_discount" in discount)) return false;
  const invoiceDiscount = object(discount.invoice_discount);
  return Object.keys(invoiceDiscount).length === 1 && "amount" in invoiceDiscount && exactMoney(invoiceDiscount.amount) === 0 && exactMoney(discount.item_discount) === 0;
}
function noAdjustments(breakdown: Record<string, unknown>, itemMinor: number): boolean {
  const known = new Set(["item_total", "discount", "shipping", "custom", "tax_total", "tip"]);
  if (Object.keys(breakdown).some(key => !known.has(key)) || breakdown.item_total !== undefined && exactMoney(breakdown.item_total) !== itemMinor) return false;
  if (breakdown.discount !== undefined && !zeroDiscount(breakdown.discount)) return false;
  return [breakdown.shipping, breakdown.custom, breakdown.tax_total, breakdown.tip].every(value => value === undefined || exactMoney(value) === 0);
}
/** Parse only the one-item, no-tip/no-partial-payment contract this application can authorize. */
export function invoiceEnvelope(raw: unknown): InvoiceEnvelope {
  const v = object(raw), d = object(v.detail), issuer = object(v.invoicer), recipients = v.primary_recipients, items = v.items;
  if (!Array.isArray(recipients) || recipients.length !== 1 || !Array.isArray(items) || items.length !== 1 || v.additional_recipients !== undefined && (!Array.isArray(v.additional_recipients) || v.additional_recipients.length)) throw new Error("INVOICE_PARTIES_OR_ITEMS_CHANGED");
  const recipient = object(recipients[0]), billing = object(recipient.billing_info), item = object(items[0]), configuration = object(v.configuration);
  const issuerEmail = z.email().parse(issuer.email_address).toLowerCase(), recipientEmail = z.email().parse(billing.email_address).toLowerCase();
  if (configuration.allow_tip !== false || !partialPaymentsDisabled(configuration.partial_payment) || !["1", "1.0", "1.00"].includes(String(item.quantity)) || d.currency_code !== "USD") throw new Error("INVOICE_POLICY_CHANGED");
  const paymentTerm = d.payment_term === undefined ? null : object(d.payment_term), term = paymentTerm ? optionalText(paymentTerm.term_type, 40) : null;
  if (term !== null && !terms.has(term) || paymentTerm?.conditional_rules !== undefined || d.recurring_info !== undefined || d.late_fee !== undefined) throw new Error("INVOICE_TERMS_UNKNOWN");
  const amountMinor = providerMinor(v.amount), unitMinor = providerMinor(item.unit_amount), breakdown = object(v.amount).breakdown === undefined ? {} : object(object(v.amount).breakdown);
  if (amountMinor !== unitMinor || item.tax !== undefined || item.discount !== undefined || !noAdjustments(breakdown, unitMinor)) throw new Error("INVOICE_ADJUSTMENTS_CHANGED");
  return { id: text(v.id, 128), invoiceNumber: text(d.invoice_number, 25), reference: text(d.reference, 120), issuerEmail, recipientEmail, issuerIdentityDigest: digest(issuer), recipientIdentityDigest: digest(recipient), currency: "USD", amountMinor,
    item: { name: text(item.name, 200), quantity: "1", unitMinor, description: optionalText(item.description), unitOfMeasure: optionalText(item.unit_of_measure, 40), tax: item.tax ?? null, discount: item.discount ?? null },
    invoiceDate: date(d.invoice_date), dueDate: paymentTerm?.due_date === undefined ? null : date(paymentTerm.due_date), paymentTerm: term, terms: optionalText(d.terms_and_conditions, 4000), note: optionalText(d.note, 4000), memo: optionalText(d.memo, 4000),
    configuration: { allowTip: false, allowPartialPayment: false, taxCalculatedAfterDiscount: optionalBoolean(configuration.tax_calculated_after_discount), taxInclusive: optionalBoolean(configuration.tax_inclusive) },
    adjustments: { discount: breakdown.discount ?? null, shipping: breakdown.shipping ?? null, custom: breakdown.custom ?? null, tax: breakdown.tax_total ?? null, tip: breakdown.tip ?? null } };
}
export function invoiceEnvelopeProblem(draft: InvoiceDraft, envelope: InvoiceEnvelope, expected: InvoiceEnvelope | null = null, now = Date.now()): string | null {
  const wanted = draft.request;
  if (envelope.invoiceNumber !== wanted.invoiceNumber || envelope.reference !== wanted.reference || envelope.issuerEmail !== wanted.merchantEmail.toLowerCase() || envelope.recipientEmail !== wanted.recipientEmail.toLowerCase() || envelope.currency !== wanted.money.currency || envelope.amountMinor !== wanted.money.minor || envelope.item.name !== wanted.itemName || envelope.item.unitMinor !== wanted.money.minor || envelope.item.description !== null || envelope.item.tax !== null || envelope.item.discount !== null) return "INVOICE_ENVELOPE_MISMATCH";
  if (envelope.invoiceDate > new Date(now).toISOString().slice(0, 10)) return "INVOICE_FUTURE_DATE_BLOCKED";
  if (envelope.paymentTerm === null || envelope.paymentTerm === "DUE_ON_DATE_SPECIFIED" && envelope.dueDate === null || envelope.dueDate !== null && envelope.dueDate < envelope.invoiceDate) return "INVOICE_TERMS_UNKNOWN";
  if (expected && digest(envelope) !== digest(expected)) return "INVOICE_REVIEW_ENVELOPE_CHANGED";
  return null;
}
export function validateInvoiceObservation(draft: InvoiceDraft, observation: InvoiceObservation, envelope: InvoiceEnvelope, expectedId: string | null, expected: InvoiceEnvelope | null = null): string | null {
  const problem = invoiceEnvelopeProblem(draft, envelope, expected);
  if (problem) return problem;
  if (expectedId && observation.id !== expectedId || observation.id !== envelope.id || !invoiceStatuses.has(observation.status) || observation.invoiceNumber !== envelope.invoiceNumber || observation.reference !== envelope.reference || observation.money?.currency !== "USD" || observation.money.minor !== envelope.amountMinor || observation.recipientEmails.length !== 1 || observation.recipientEmails[0]?.toLowerCase() !== envelope.recipientEmail) return "INVOICE_ORIGINAL_IDENTITY_UNKNOWN";
  if (observation.due !== null && (observation.due.currency !== "USD" || !Number.isSafeInteger(observation.due.minor) || observation.due.minor < 0 || observation.due.minor > envelope.amountMinor)) return "INVOICE_DUE_UNKNOWN";
  if (["DRAFT", "SENT", "SHARED", "UNPAID"].includes(observation.status) && (observation.due?.minor !== envelope.amountMinor || observation.payments.length || observation.refunds.length)) return "INVOICE_UNPAID_BALANCE_UNKNOWN";
  return null;
}
/** Toolkit returns raw JSON; map its observed fields without inventing a payment or a default status. */
export function invoiceObservationFromRaw(raw: unknown): InvoiceObservation {
  const value = object(raw), envelope = invoiceEnvelope(raw), detail = object(value.detail), metadata = detail.metadata === undefined ? {} : object(detail.metadata);
  const money = (input: unknown) => input === undefined || input === null ? null : { currency: "USD", minor: providerMinor(input) };
  function transactions(input: unknown, refund: boolean) {
    if (input === undefined) return []; const items = object(input).transactions;
    if (!Array.isArray(items) || items.length > 100) throw new Error("INVOICE_COLLECTION_UNKNOWN");
    return items.map(item => { const entry = object(item); return { id: optionalText(entry[refund ? "refund_id" : "payment_id"], 30), type: optionalText(entry.type, 40) ?? "UNSPECIFIED", method: text(entry.method, 40), money: money(entry.amount), date: optionalText(entry.payment_date_time ?? entry.payment_date ?? entry.refund_date, 100) }; });
  }
  let payerUrl: string | null = null;
  if (metadata.recipient_view_url !== undefined) { const url = new URL(text(metadata.recipient_view_url, 2048)); if (url.origin !== "https://www.sandbox.paypal.com" || url.username || url.password) throw new Error("INVOICE_LINK_UNKNOWN"); payerUrl = url.href; }
  return { id: envelope.id, invoiceNumber: envelope.invoiceNumber, reference: envelope.reference, status: text(value.status, 50), invoiceDate: envelope.invoiceDate, money: money(value.amount), due: money(value.due_amount), recipientEmails: [envelope.recipientEmail], payerUrl, payments: transactions(value.payments, false), refunds: transactions(value.refunds, true).map(item => ({ ...item, originalPaymentId: null })) };
}
export function invoiceHistoryProblem(state: WrapState, invoiceId: string, value: InvoiceObservation): string | null {
  const prior = wrapRecords(state, "invoice_read").filter(read => read.invoiceId === invoiceId && read.result.verified && read.result.value);
  for (const read of prior) {
    if (read.result.value!.id !== value.id) return "INVOICE_ORIGINAL_IDENTITY_CHANGED";
    for (const kind of ["payments", "refunds"] as const) for (const retained of read.result.value![kind]) {
      const current = value[kind].find(item => item.id && item.id === retained.id);
      if (retained.id && !current) return "INVOICE_RECEIPT_HISTORY_INCOMPLETE";
      if (current && digest(current) !== digest(retained)) return "INVOICE_RECEIPT_IDENTITY_CHANGED";
    }
  }
  return null;
}
export function invoiceCollection(read: InvoiceRead | null) {
  const empty = { paidMinor: 0, refundedMinor: 0, complete: false, problem: "Collection needs a complete original invoice observation." as string | null };
  if (!read?.result.verified || !read.result.value || !read.result.raw) return empty;
  const value = read.result.value, p = value.payments, r = value.refunds, statuses = ["PAID", "PARTIALLY_PAID", "REFUNDED", "PARTIALLY_REFUNDED"];
  try {
    const raw = object(read.result.raw), all = [...p, ...r];
    if (all.some(item => !item.id || item.type !== "PAYPAL" || !["PAYPAL", "CREDIT_CARD", "DEBIT_CARD"].includes(item.method) || item.money?.currency !== "USD" || !Number.isSafeInteger(item.money.minor) || item.money.minor <= 0 || !item.date || !Number.isFinite(Date.parse(item.date))) || new Set(p.map(item => item.id)).size !== p.length || new Set(r.map(item => item.id)).size !== r.length) return { ...empty, problem: "External, missing, duplicated or unverified payment records cannot establish processor collection." };
    const paid = p.reduce((sum, item) => sum + item.money!.minor, 0), refunded = r.reduce((sum, item) => sum + item.money!.minor, 0), amount = value.money!.minor;
    if (paid > amount || refunded > paid || raw.payments !== undefined && providerMinor(object(raw.payments).paid_amount) !== paid || raw.refunds !== undefined && providerMinor(object(raw.refunds).refund_amount) !== refunded || paid > 0 && !statuses.includes(value.status) || refunded > 0 && !["REFUNDED", "PARTIALLY_REFUNDED"].includes(value.status)) return { ...empty, problem: "The invoice status, transaction list and aggregate amounts do not reconcile." };
    if (statuses.includes(value.status)) {
      const expectedDue = ["REFUNDED", "PARTIALLY_REFUNDED"].includes(value.status) ? 0 : amount - paid;
      if (value.due?.minor !== expectedDue || value.due.currency !== "USD" || value.status === "PAID" && paid !== amount || value.status === "PARTIALLY_PAID" && !(paid > 0 && paid < amount) || value.status === "REFUNDED" && !(paid > 0 && refunded === paid) || value.status === "PARTIALLY_REFUNDED" && !(refunded > 0 && refunded < paid)) return { ...empty, problem: "The remaining amount or collection state needs reconciliation." };
    } else if (["PAYMENT_PENDING", "MARKED_AS_PAID", "MARKED_AS_REFUNDED", "PAID_EXTERNAL", "REFUNDED_EXTERNAL", "SCHEDULED"].includes(value.status)) return { ...empty, problem: "This invoice state does not establish settled PayPal collection." };
    return { paidMinor: paid, refundedMinor: refunded, complete: true, problem: null };
  } catch { return { ...empty, problem: "The original payment/refund aggregate is missing or unreadable." }; }
}
export function invoiceView(state: WrapState, draft: InvoiceDraft, now = Date.now()): InvoiceView {
  const reads = wrapRecords(state, "invoice_read").filter(record => record.invoiceId === draft.id), last = reads.at(-1) ?? null, result = last?.result;
  const pending = state.records.some(record => record.revision > (last?.revision ?? 0) && ((record.kind === "invoice_dispatch" || record.kind === "invoice_refresh") && record.invoiceId === draft.id || record.kind === "toolkit_request" && record.tool === "get_invoice" && record.resourceKey === `invoice:${draft.id}`));
  const value = !pending && result?.verified ? result.value : null;
  const historicalPayments = new Map<string, number>(), historicalRefunds = new Map<string, number>();
  for (const read of reads) if (invoiceCollection(read).complete && read.result.value) { for (const p of read.result.value.payments) historicalPayments.set(p.id!, p.money!.minor); for (const r of read.result.value.refunds) historicalRefunds.set(r.id!, r.money!.minor); }
  const collection = invoiceCollection(pending ? null : last), grants = wrapRecords(state, "invoice_grant").filter(record => record.invoiceId === draft.id).map(grant => {
    const dispatched = wrapRecords(state, "invoice_dispatch").some(record => record.grantId === grant.id), revoked = wrapRecords(state, "invoice_revoked").some(record => record.grantId === grant.id), held = wrapRecords(state, "invoice_held").some(record => record.grantId === grant.id);
    return { id: grant.id, operation: grant.operation, expiresAt: grant.expiresAt, state: revoked ? "revoked" as const : held || !dispatched && Date.parse(grant.expiresAt) <= now ? "held" as const : dispatched ? "dispatched" as const : "queued" as const, canRevoke: !dispatched && !revoked };
  });
  const status = value?.status ?? (result ? "UNKNOWN" : grants.some(grant => grant.operation === "create" && grant.state === "dispatched") ? "UNKNOWN" : "LOCAL_DRAFT"), claimed = ["SENT", "SHARED", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING"].includes(status);
  return { id: draft.id, entryId: draft.entryId, entryRecordId: draft.entryRecordId, label: draft.request.itemName, serviceDay: draft.serviceDay, amountMinor: draft.request.money.minor, invoiceNumber: draft.request.invoiceNumber, reference: draft.request.reference, issuer: draft.request.merchantEmail, recipient: draft.request.recipientEmail, admissionLabel: draft.admission.label,
    providerId: ownedInvoiceId(state, draft.id), status, verified: Boolean(value), observedAt: result?.observedAt ?? null, payerUrl: value && claimed && result?.envelope && !invoiceEnvelopeProblem(draft, result.envelope) ? value.payerUrl : null, envelope: value ? result!.envelope : null, rawDigest: value ? result!.rawDigest : null,
    currentCollectedMinor: collection.complete ? collection.paidMinor : 0, historicalCollectedMinor: [...historicalPayments.values()].reduce((a, b) => a + b, 0), currentRefundedMinor: collection.complete ? collection.refundedMinor : 0, historicalRefundedMinor: [...historicalRefunds.values()].reduce((a, b) => a + b, 0), outstandingClaimMinor: claimed ? value?.due?.minor ?? draft.request.money.minor : 0, collectionComplete: collection.complete,
    problem: pending ? "A retained original read or operation is pending. Current collection proof awaits its observation; earlier receipts remain retained." : result?.problem ?? (result && !result.verified ? "The original invoice needs reconciliation." : collection.problem), transport: result?.transport ?? null, grants };
}
export function invoiceReview(show: ShowSnapshot, state: WrapState, draft: InvoiceDraft, operation: InvoiceOperation, admissions: InvoiceAdmission[], fingerprint: string | null, now = Date.now()): InvoiceReview {
  const view = invoiceView(state, draft, now), blockers: string[] = [], entry = currentEntries(state).find(record => record.entry.entryId === draft.entryId), admission = admissions.find(item => item.id === draft.admission.id && item.digest === draft.admission.digest);
  if (!entry || entry.id !== draft.entryRecordId || digest(entry) !== draft.entryDigest) blockers.push("The linked approved revenue entry has changed.");
  if (operation !== "cancel" && wrapRecords(state, "entry_adjustment").some(record => record.entryId === draft.entryId)) blockers.push("The linked revenue has an approved adjustment. Reconcile the original invoice rather than issuing its former face amount.");
  if (!admission || Date.parse(admission.expiresAt) <= now || admission.merchantFingerprint !== fingerprint) blockers.push("The exact owned-party admission or isolated merchant is unavailable or expired.");
  if (view.grants.some(grant => grant.operation === operation && grant.state === "queued")) blockers.push("This exact action already has a queued review.");
  if (wrapRecords(state, "invoice_dispatch").some(record => record.invoiceId === draft.id && record.operation === operation)) blockers.push("This action was already dispatched. Reconcile its original identity; it cannot be submitted again.");
  if (operation === "create" && view.providerId || operation === "create" && view.status !== "LOCAL_DRAFT") blockers.push("The draft has already reached the provider boundary.");
  if (operation !== "create") {
    if (!view.providerId || !view.verified || !view.envelope || !view.rawDigest || !view.observedAt || now - Date.parse(view.observedAt) > INVOICE_READ_FRESH_MS) blockers.push("Refresh the original invoice to review its exact current content.");
    if (operation === "send" && view.status !== "DRAFT" || operation === "cancel" && !["SENT", "SHARED", "UNPAID"].includes(view.status)) blockers.push("The current original invoice state does not allow this action.");
    if (view.envelope && invoiceEnvelopeProblem(draft, view.envelope)) blockers.push("The observed parties, item, date, amount or terms differ from this owned draft.");
  }
  const body = { invoiceId: draft.id, operation, envelope: operation === "create" ? null : view.envelope, rawDigest: operation === "create" ? null : view.rawDigest, expiresInMinutes: INVOICE_AUTHORITY_MS / 60_000, blockers, delivery: "share_link_only" as const,
    datePolicy: operation === "create" ? "PayPal assigns the invoice date. The exact observed date is reviewed again before issuance; a future date blocks sending." : view.envelope?.invoiceDate ?? "Unknown", termsPolicy: operation === "create" ? "Create one item with no tip and no partial payments. Review the provider's exact default due terms before issuance." : `${view.envelope?.paymentTerm ?? "Unknown"}${view.envelope?.dueDate ? ` · due ${view.envelope.dueDate}` : ""}` };
  return { ...body, digest: digest({ ...body, request: draft.request, admissionDigest: draft.admission.digest, entryDigest: draft.entryDigest, wrapRevision: state.revision, productionRevision: show.revision }) };
}
