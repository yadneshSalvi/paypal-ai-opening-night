import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { base, evidence } from "./helpers";
import { digest } from "../src/domain/hash";
import { buildWrapReport, toolkitFee } from "../src/domain/wrap/report";
import { invoiceCollection, invoiceEnvelope, invoiceEnvelopeProblem } from "../src/domain/wrap/invoices";
import type { InvoiceDraft, InvoiceRead, ToolkitReceipt, WrapRecord, WrapState } from "../src/domain/wrap/contracts";
const settlement = { schemaVersion: 1 as const, revision: 0, records: [] }, payouts = { schemaVersion: 1 as const, revision: 0, records: [] }, empty: WrapState = { schemaVersion: 1, revision: 0, records: [] };
const context = () => ({ id: randomUUID(), commandId: randomUUID(), requestDigest: "a".repeat(64), actorId: "producer:test", revision: 1, productionRevision: 2, recordedAt: new Date().toISOString() });
const rawInvoice = () => ({ id: "INV2-CONTROLLED", status: "DRAFT", detail: { invoice_number: "ON-CONTROLLED", reference: "opening-night:original", currency_code: "USD", invoice_date: new Date().toISOString().slice(0, 10), payment_term: { term_type: "DUE_ON_RECEIPT" } }, invoicer: { email_address: "issuer@owned.invalid" }, primary_recipients: [{ billing_info: { email_address: "recipient@owned.invalid" } }], items: [{ name: "Owned fictional show service", quantity: "1", unit_amount: { currency_code: "USD", value: "10.00" } }], amount: { currency_code: "USD", value: "10.00" }, due_amount: { currency_code: "USD", value: "10.00" }, configuration: { allow_tip: false, partial_payment: { allow_partial_payment: false } } });
const draft = { ...context(), kind: "invoice_draft", entryId: randomUUID(), entryRecordId: randomUUID(), entryDigest: "a".repeat(64), serviceDay: "2026-11-14", detail: "Controlled original invoice.", admission: {} as InvoiceDraft["admission"], request: { invoiceNumber: "ON-CONTROLLED", reference: "opening-night:original", merchantEmail: "issuer@owned.invalid", recipientEmail: "recipient@owned.invalid", itemName: "Owned fictional show service", money: { currency: "USD", minor: 1000 } } } satisfies InvoiceDraft;

test("wrap empty account asserts missing scope rather than profit or processor receipts", () => { const { show } = base(), report = buildWrapReport(show, settlement, payouts, empty, true); assert.equal(report.lines.length, 0); assert.equal(report.boundary, "controlled_fixture"); assert.equal(report.totals.currentNetMovementMinor, 0); assert.equal(report.rescueComparison, null); assert.match(report.limitations.join(" "), /No production profit/); });
test("entry revisions replace a current amount while retaining every attributed original", () => {
  const { show } = base(), entryId = randomUUID(), a = { ...context(), kind: "entry", version: 1, previousDigest: null, entry: { entryId, previousId: null, kind: "baseline_cost", category: "artist", label: "Artist agreement", amountMinor: 50000, currency: "USD", serviceDay: show.showDate, reference: "ARTIST-1", detail: "Original controlled budget estimate.", sourceIds: [], reviewedScope: true } } as const;
  const b = { ...a, ...context(), version: 2, previousDigest: digest(a), entry: { ...a.entry, previousId: a.id, amountMinor: 55000 } }, records = [a, b] as unknown as WrapRecord[], report = buildWrapReport(show, settlement, payouts, { ...empty, revision: 2, records }, false);
  assert.equal(report.totals.baselineCostMinor, 55000); assert.equal(report.lines.length, 1); assert.equal(report.lines[0]!.evidence.length, 2); assert.match(report.lines[0]!.evidence[0]!.note, /50000 USD minor/); assert.equal(report.totals.currentCashOutMinor, 0);
});
test("ticket refunds and duplicate receipt history conserve net income without becoming expense", () => {
  const { show } = base(), capture = evidence(show, { providerResourceId: "CAP-OWNED", ticketId: "ticket-owned", parentId: "ORDER-OWNED", amountMinor: 5000 }), refund = evidence(show, { providerResourceId: "REF-OWNED", parentId: capture.providerResourceId, ticketId: "ticket-owned", kind: "refund", purpose: "vip_remedy", amountMinor: 1500 });
  show.financialEvidence = [capture, { ...capture, id: randomUUID() }, refund, { ...refund, id: randomUUID() }];
  const report = buildWrapReport(show, settlement, payouts, empty, false);
  assert.equal(report.totals.ticketGrossCollectedMinor, 5000); assert.equal(report.totals.ticketRefundedMinor, 1500); assert.equal(report.totals.approvedRevenueMinor, 3500); assert.equal(report.totals.currentCashInMinor, 3500); assert.equal(report.totals.approvedCostMinor, 0); assert.equal(report.totals.unknownFeeCount, 1);
});
test("adverse current capture reads withdraw current proof while preserving historical bytes", () => { const { show } = base(), receipt = evidence(show, { providerResourceId: "CAP-ADVERSE", amountMinor: 5000 }); show.financialEvidence = [receipt]; const before = buildWrapReport(show, settlement, payouts, empty, false); show.financialObservations = [{ id: randomUUID(), seller: "venue", kind: "capture", providerResourceId: receipt.providerResourceId, status: "PENDING", amountMinor: 5000, currency: "USD", parentId: null, observedAt: new Date(Date.now() + 1000).toISOString(), transport: "paypal_https" }]; const after = buildWrapReport(show, settlement, payouts, empty, false); assert.equal(after.totals.historicalCashInMinor, 5000); assert.equal(after.totals.currentCashInMinor, 0); assert.equal(before.totals.currentCashInMinor, 5000); assert.notEqual(before.contentDigest, after.contentDigest); assert.ok(after.lines[0]!.evidence.some(item => item.kind === "financial_observation" && item.note.includes("PENDING"))); });
test("rental holds reconcile capture and release without becoming expenses", () => { const { show } = base(); show.financialEvidence = [evidence(show, { kind: "authorization", purpose: "rental", providerResourceId: "AUTH-OWNED", amountMinor: 78000 }), evidence(show, { kind: "capture", purpose: "rental", providerResourceId: "RENT-OWNED", parentId: "AUTH-OWNED", amountMinor: 48000 }), evidence(show, { kind: "void", purpose: "deposit", providerResourceId: "AUTH-OWNED", parentId: "AUTH-OWNED", amountMinor: 30000 })]; const report = buildWrapReport(show, settlement, payouts, empty, false); assert.equal(report.totals.approvedCostMinor, 48000); assert.equal(report.totals.currentCashOutMinor, 48000); assert.equal(report.totals.holdsMinor, 0); assert.equal(report.totals.releasedHoldsMinor, 30000); });
test("over-refund or over-release cannot silently produce a plausible account", () => { for (const kind of ["refund", "hold"] as const) { const { show } = base(); show.financialEvidence = kind === "refund" ? [evidence(show, { providerResourceId: "CAP", amountMinor: 100 }), evidence(show, { kind: "refund", parentId: "CAP", amountMinor: 101 })] : [evidence(show, { kind: "authorization", purpose: "rental", providerResourceId: "AUTH", amountMinor: 100 }), evidence(show, { kind: "void", purpose: "deposit", parentId: "AUTH", amountMinor: 101 })]; assert.throws(() => buildWrapReport(show, settlement, payouts, empty, false), /exceed/); } });
test("full invoice envelope rejects changed parties, amount, item, terms and future date", () => {
  const original = invoiceEnvelope(rawInvoice()); assert.equal(invoiceEnvelopeProblem(draft, original), null);
  const changes: ((raw: ReturnType<typeof rawInvoice>) => void)[] = [raw => { raw.invoicer.email_address = "other@owned.invalid"; }, raw => { raw.primary_recipients[0]!.billing_info.email_address = "other@owned.invalid"; }, raw => { raw.items[0]!.name = "Changed purpose"; }, raw => { raw.amount.value = "11.00"; }, raw => { raw.detail.invoice_date = "2099-01-01"; }, raw => { raw.detail.payment_term.term_type = "NET_30"; }, raw => { raw.configuration.allow_tip = true; }, raw => { raw.primary_recipients.push(structuredClone(raw.primary_recipients[0]!)); }];
  for (const change of changes) { const raw = rawInvoice(); change(raw); let blocked = false; try { blocked = Boolean(invoiceEnvelopeProblem(draft, invoiceEnvelope(raw), original)); } catch { blocked = true; } assert.equal(blocked, true); }
});
test("paid invoice status without identified PayPal transactions is not verified collection", () => { const read = { ...context(), kind: "invoice_read", invoiceId: draft.id, grantId: null, result: { verified: true, raw: { payments: { paid_amount: { currency_code: "USD", value: "10.00" } } }, value: { id: "INV", status: "PAID", payments: [], refunds: [], money: { currency: "USD", minor: 1000 }, due: { currency: "USD", minor: 0 } } } } as unknown as InvoiceRead; assert.equal(invoiceCollection(read).complete, false); assert.equal(invoiceCollection(read).paidMinor, 0); });
test("observed capture and refund fees require exact identity and net/gross conservation", () => {
  const { show } = base(), capture = evidence(show, { providerResourceId: "CAP", parentId: "ORDER", amountMinor: 5000 });
  const data = { id: "ORDER", purchase_units: [{ payments: { captures: [{ id: "CAP", status: "COMPLETED", amount: { currency_code: "USD", value: "50.00" }, seller_receivable_breakdown: { gross_amount: { currency_code: "USD", value: "50.00" }, paypal_fee: { currency_code: "USD", value: "1.50" }, net_amount: { currency_code: "USD", value: "48.50" } } }] } }] }, receipt = { ...context(), kind: "toolkit_read", tool: "get_order", providerId: "ORDER", outcome: "verified_read", responseDigest: digest(data), data } as unknown as ToolkitReceipt;
  assert.equal(toolkitFee(receipt, capture), 150); data.purchase_units[0]!.payments.captures[0]!.seller_receivable_breakdown.net_amount.value = "49.00"; assert.equal(toolkitFee(receipt, capture), null); assert.equal(toolkitFee({ ...receipt, outcome: "unverified" }, capture), null);
});

test("conflicting original receipt identities hold the account instead of selecting one", () => {
  const { show } = base(), a = evidence(show, { providerResourceId: "CAP-CONFLICT", amountMinor: 1000 });
  show.financialEvidence = [a, { ...a, id: randomUUID(), amountMinor: 1001 }];
  assert.throws(() => buildWrapReport(show, settlement, payouts, empty, true), /disagree about one original/);
});
test("legacy payouts and unmatched refunds retain original cash without invented obligations", () => {
  const { show } = base(); show.financialEvidence = [evidence(show, { kind: "payout", purpose: "crew", providerResourceId: "LEGACY-ITEM", amountMinor: 1000 }), evidence(show, { kind: "refund", purpose: "vip_remedy", providerResourceId: "ORPHAN-REF", parentId: "ABSENT-CAP", amountMinor: 250 })];
  const report = buildWrapReport(show, settlement, payouts, empty, false);
  assert.equal(report.lines.length, 2); assert.equal(report.totals.currentCashOutMinor, 1000); assert.equal(report.totals.currentCashInMinor, -250); assert.equal(report.totals.approvedCostMinor, 0); assert.equal(report.totals.approvedRevenueMinor, 0); assert.equal(report.totals.currentNetMovementMinor, -1250); assert.equal(report.totals.unknownFeeCount, 2);
});
test("pending original Toolkit requests withdraw current cash but preserve receipts and complete evidence", () => {
  const { show } = base(), capture = evidence(show, { providerResourceId: "CAP-PENDING", parentId: "ORDER-PENDING", amountMinor: 1000 }); show.financialEvidence = [capture];
  const record = { ...context(), kind: "toolkit_request", tool: "get_order", providerId: "ORDER-PENDING", resourceKey: "order:ORDER-PENDING", merchantFingerprint: "a".repeat(64), inputDigest: "b".repeat(64), reportDigest: "c".repeat(64), authority: {} } as unknown as WrapRecord;
  const report = buildWrapReport(show, settlement, payouts, { ...empty, revision: 1, records: [record] }, true);
  assert.equal(report.totals.currentCashInMinor, 0); assert.equal(report.totals.historicalCashInMinor, 1000); assert.ok(report.lines[0]!.evidence.some(item => item.id === record.id));
});
test("a later adverse release observation restores hold uncertainty without counting a deposit as expense", () => {
  const { show } = base(); show.financialEvidence = [evidence(show, { kind: "authorization", purpose: "rental", providerResourceId: "AUTH-ADVERSE", amountMinor: 78000 }), evidence(show, { kind: "capture", purpose: "rental", providerResourceId: "RENT-ADVERSE", parentId: "AUTH-ADVERSE", amountMinor: 48000 }), evidence(show, { kind: "void", purpose: "deposit", providerResourceId: "AUTH-ADVERSE", parentId: "AUTH-ADVERSE", amountMinor: 30000 })];
  show.financialObservations = [{ id: randomUUID(), seller: "brightline", kind: "authorization", providerResourceId: "AUTH-ADVERSE", status: "UNKNOWN", amountMinor: 30000, currency: "USD", parentId: "AUTH-ADVERSE", observedAt: new Date(Date.now()+1000).toISOString(), transport: "paypal_https" }];
  const report = buildWrapReport(show, settlement, payouts, empty, false); assert.equal(report.totals.holdsMinor, 30000); assert.equal(report.totals.releasedHoldsMinor, 0); assert.equal(report.totals.currentCashOutMinor, 48000); assert.equal(report.totals.approvedCostMinor, 48000);
});
import { payoutWrapFixture } from "./payout-wrap-fixture";
test("normalized SUCCESS then RETURNED then adverse reads conserve original principal and known fees", () => {
  const f = payoutWrapFixture(true); f.readBatch(); f.readItem(); const report = () => buildWrapReport(f.show, f.work.state, f.state, empty, false);
  assert.equal(report().totals.currentCashOutMinor, 3500); assert.equal(report().totals.historicalCashOutMinor, 3500); assert.equal(report().lines.filter(line => line.origin === "crew").length, 1);
  f.readItem("RETURNED"); assert.equal(report().totals.currentCashOutMinor, 0); assert.equal(report().totals.historicalCashOutMinor, 0); assert.equal(report().totals.currentFeeMinor, 25); assert.equal(report().totals.outstandingCostMinor, 3500);
  f.readItem("PENDING", false); assert.equal(report().totals.historicalCashOutMinor, 0); assert.equal(report().totals.historicalFeeMinor, 25); assert.ok(report().lines[0]!.evidence.some(item => item.kind === "item_read"));
});
import { parseWrapAmount, wrapCostBridge, wrapMoney, wrapComparisons } from "../src/domain/wrap/presentation";
test("display keeps cents exact and cost waterfall covers negative and crossing fee segments", () => {
  assert.equal(wrapMoney(25), "$0.25"); assert.equal(parseWrapAmount("100.01"), 10001); assert.equal(parseWrapAmount("0.001"), null); assert.equal(parseWrapAmount("1e3"), null); assert.equal(parseWrapAmount("-1.25", true), -125);
  const { show } = base(), line = buildWrapReport(show, settlement, payouts, empty, false); const entry = { id: "line", category: "artist", direction: "expense", baselineMinor: 100, approvedMinor: 50, currentFeeMinor: -75, currentCashMinor: 25, reportedCashMinor: 10, outstandingMinor: 15 } as typeof line.lines[number];
  const bridge = wrapCostBridge([entry]), fee = bridge[3]!; assert.equal(fee.from, 50); assert.equal(fee.to, -25); assert.equal(fee.positiveOffset, 0); assert.equal(fee.positiveValue, 50); assert.equal(fee.negativeOffset, 0); assert.equal(fee.negativeValue, -25); assert.equal(bridge[4]!.amount, -25); assert.deepEqual(wrapComparisons([entry])[0]!.lineIds, ["line"]);
});

import { settlementFixture } from "./settlement-fixtures";
test("unapproved personal hours remain a source and unresolved review without becoming an obligation", () => {
  const f=settlementFixture();const rate=f.apply(f.rate()),report=f.apply(f.report());
  const before=buildWrapReport(f.show,f.state,payouts,empty,true);assert.equal(before.totals.approvedCostMinor,0);assert.equal(before.lines[0]!.approvedMinor,null);assert.equal(before.lines[0]!.evidence.length,2);assert.equal(before.totals.unresolvedCount,1);assert.match(before.lines[0]!.issues.join(" "),/No liability is inferred/);
  f.apply(f.approve(report.id));const after=buildWrapReport(f.show,f.state,payouts,empty,true);assert.equal(after.totals.approvedCostMinor,3500);assert.ok(after.lines[0]!.evidence.some(e=>e.id===rate.id));assert.ok(after.lines[0]!.evidence.some(e=>e.id===report.id&&e.note.includes("60 worked minutes")));
});
