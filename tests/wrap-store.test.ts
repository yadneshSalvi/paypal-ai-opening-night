/** Restricted real PostgreSQL, real core + official Toolkit with injected transports; no actual provider qualification. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isolatedDatabase } from "./isolated-database";
import { createWrapWireFixture } from "../scripts/qa/wrap-wire-fixture.mjs";
import { digest } from "../src/domain/hash";
import { evidence } from "./helpers";
import type { WrapCommand, WrapEnvelope } from "../src/domain/wrap/contracts";
const database = await isolatedDatabase(), store = await import("../src/server/store"), service = await import("../src/server/wrap/service"), storage = await import("../src/server/wrap/store"), provider = await import("../src/server/wrap/provider"), worker = await import("../src/server/wrap/worker"), toolkit = await import("../src/server/wrap/toolkit"), reports = await import("../src/server/wrap/reports"), locks = await import("../src/server/commerce-locks");
const { sessionTokenHash } = await import("../src/server/session-records"), route = await import("../src/app/api/wrap/route"), reviewRoute = await import("../src/app/api/wrap/invoice-review/route"), workRoute = await import("../src/app/api/wrap/work/route"), reportRoute = await import("../src/app/api/wrap/reports/[id]/route");
after(async () => { await locks.closeCommerceLocks(); await database.close(); });
const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === wanted), signal = () => AbortSignal.timeout(10_000);
async function fresh(wire = createWrapWireFixture()) { provider.installWrapFixture(wire as unknown as import("../src/server/wrap/provider").WrapFixtureRuntime); const session = await store.createSession(undefined, "wrap:" + randomUUID()); return { wire, session, authority: { actor: session.actor, sessionHash: sessionTokenHash(session.token), scope: "production" as const } }; }
type Workspace = Awaited<ReturnType<typeof fresh>>;
async function envelope(w: Workspace, command: WrapCommand): Promise<WrapEnvelope> { const data = await service.readWrap(w.authority); return { idempotencyKey: randomUUID(), expectedRevision: data.revision, expectedShowRevision: data.productionRevision, command }; }
async function execute(w: Workspace, command: WrapCommand) { return service.executeWrap(w.authority, await envelope(w, command)); }
async function entry(w: Workspace, kind: "revenue" | "expense" | "baseline_cost" = "revenue", amountMinor = 1000) { return execute(w, { type: "save_entry", entry: { entryId: randomUUID(), previousId: null, kind, category: kind === "revenue" ? "sponsorship" : "artist", label: "Owned fictional show service", amountMinor, currency: "USD", serviceDay: w.session.show.showDate, reference: "CONTROLLED-" + randomUUID(), detail: "Producer reviewed this fictional additional account entry and its source scope.", sourceIds: [], reviewedScope: true } }); }
async function draft(w: Workspace) { const saved = await entry(w), value = saved.data.entries.find(item => item.id === saved.receipt.id)!, admission = saved.data.admissions[0]!; const next = await execute(w, { type: "prepare_invoice", entryId: value.entry.entryId, entryRecordId: value.id, admissionId: admission.id, admissionDigest: admission.digest, detail: "Prepare this exact owned-party invoice with separately reviewed issuance." }); return next.receipt.id; }
async function grant(w: Workspace, invoiceId: string, operation: "create" | "send" | "cancel") { const review = await service.readInvoiceReview(w.authority, invoiceId, operation); assert.deepEqual(review.review.blockers, []); const result = await execute(w, { type: "approve_invoice", invoiceId, operation, reviewDigest: review.review.digest, detail: "Reviewed parties, exact USD amount, purpose, dates, terms and no-notification delivery.", reviewedParties: true, reviewedAmount: true, reviewedTerms: true, reviewedDelivery: true }); return result.receipt.id; }
async function run(w: Workspace, invoiceId: string, grantId: string) { return worker.runInvoiceJob(w.authority.actor.tenantId, { invoiceId, grantId, refreshId: null }, signal()); }
async function refresh(w: Workspace, invoiceId: string) { const result = await execute(w, { type: "refresh_invoice", invoiceId }); return worker.runInvoiceJob(w.authority.actor.tenantId, { invoiceId, grantId: null, refreshId: result.receipt.id }, signal()); }
async function created(w: Workspace) { const id = await draft(w), grantId = await grant(w, id, "create"), result = await run(w, id, grantId); const data = await service.readWrap(w.authority); assert.equal(data.invoices[0]!.status, "DRAFT", JSON.stringify({ result, problem: data.invoices[0]!.problem, paths: w.wire.calls.map(call => call.path) })); return { id, providerId: data.invoices[0]!.providerId!, grantId }; }
const mutations = (w: Workspace) => w.wire.calls.filter(call => call.method === "POST" && !call.path.endsWith("search-invoices"));
function request(token: string, body?: unknown, origin = "http://localhost:4538") { return new Request("http://localhost:4538/api/wrap", { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + token, origin, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }

test("account commands bind exact normalized source versions and concurrent replay once", async () => {
  const w = await fresh(), saved = await entry(w, "baseline_cost", 50000), previous = saved.data.entries[0]!;
  const command = await envelope(w, { type: "save_entry", entry: { ...previous.entry, previousId: previous.id, amountMinor: 55000, detail: "  Revised fictional baseline with attributed source review.  " } });
  const [a, b] = await Promise.all([service.executeWrap(w.authority, command), service.executeWrap(w.authority, command)]); assert.equal(a.receipt.id, b.receipt.id); assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]); assert.equal(a.data.report.totals.baselineCostMinor, 55000); assert.equal(a.data.report.lines[0]!.evidence.length, 2);
  await assert.rejects(service.executeWrap(w.authority, { ...command, command: { type: "save_entry", entry: { ...previous.entry, amountMinor: 56000 } } }), code("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(execute(w, { type: "save_entry", entry: { ...previous.entry, previousId: previous.id, amountMinor: 56000 } }), code("WRAP_ENTRY_CHANGED"));
  await assert.rejects(database.pool.query("UPDATE on_wrap_records SET record_digest='changed' WHERE id=$1", [a.receipt.id]), /Immutable wrap history/);
});
test("producer scope, exact current session, tenant and stale revisions are enforced", async () => {
  const w = await fresh(), other = await fresh(); await assert.rejects(service.readWrap({ ...w.authority, actor: { ...w.authority.actor, tenantId: other.authority.actor.tenantId } }), /session has ended/);
  for (const actor of [{ ...w.authority.actor, roles: ["stage_manager" as const] }, { ...w.authority.actor, personId: "priya", roles: ["crew" as const] }]) await assert.rejects(service.readWrap({ ...w.authority, actor }), /producer/);
  const old = await envelope(w, { type: "save_proposal", title: "Controlled review", detail: "Review the retained additional source entry.", lineIds: ["foreign"], reportDigest: "a".repeat(64) }); await entry(w); await assert.rejects(service.executeWrap(w.authority, old), code("WRAP_REVIEW_STALE"));
  await database.pool.query("DELETE FROM on_sessions WHERE token_hash=$1", [w.authority.sessionHash]); await assert.rejects(service.readWrap(w.authority), /session has ended/);
});
test("reported external cash is attributed, corrected append-only and cannot impersonate provider receipts", async () => {
  const w = await fresh(), first = await entry(w, "expense", 1000), item = first.data.entries[0]!, cashId = randomUUID();
  const result = await execute(w, { type: "report_cash", cashId, previousId: null, entryId: item.entry.entryId, entryRecordId: item.id, amountMinor: 800, occurredOn: "2026-11-11", reference: "CONTROLLED-CASH-1", detail: "Reported external cash for this fictional expense; no processor receipt claimed.", reportedOnly: true });
  assert.equal(result.data.report.totals.reportedCashOutMinor, 800); assert.equal(result.data.report.totals.currentCashOutMinor, 0); assert.equal(result.data.report.totals.outstandingCostMinor, 200);
  const corrected = await execute(w, { type: "report_cash", cashId, previousId: result.receipt.id, entryId: item.entry.entryId, entryRecordId: item.id, amountMinor: 700, occurredOn: "2026-11-11", reference: "CONTROLLED-CASH-1-CORRECTED", detail: "Corrected producer report retaining the original attributed amount.", reportedOnly: true }); assert.equal(corrected.data.report.totals.reportedCashOutMinor, 700); assert.equal(corrected.data.cashReports.length, 2);
  await assert.rejects(execute(w, { type: "report_cash", cashId: randomUUID(), previousId: null, entryId: item.entry.entryId, entryRecordId: item.id, amountMinor: -701, occurredOn: "2026-11-11", reference: "EXCESS-RETURN", detail: "An excessive return must fail conservation.", reportedOnly: true }), code("WRAP_CASH_CONSERVATION"));
});
test("draft, separate issue and cancel preserve exact identity and both notification flags false", async () => {
  let durable = false;
  const wire = createWrapWireFixture({ beforeCall: async call => { if (call.method === "POST" && call.path !== "/v1/oauth2/token" && !call.path.endsWith("search-invoices")) durable = Boolean((await database.pool.query("SELECT id FROM on_wrap_records WHERE kind='invoice_preflight' ORDER BY recorded_at DESC LIMIT 1")).rowCount); } }), w = await fresh(wire), original = await created(w);
  assert.equal(durable, true); const send = await grant(w, original.id, "send"); await run(w, original.id, send); const issued = await service.readWrap(w.authority);
  assert.equal(issued.invoices[0]!.status, "SHARED"); assert.equal(issued.invoices[0]!.providerId, original.providerId); assert.match(issued.invoices[0]!.payerUrl!, /^https:\/\/www.sandbox.paypal.com/); assert.equal(issued.report.totals.currentCashInMinor, 0); assert.equal(issued.report.totals.approvedRevenueMinor, 1000); assert.equal(issued.report.totals.invoiceClaimsMinor, 1000);
  const cancel = await grant(w, original.id, "cancel"); await run(w, original.id, cancel); assert.equal((await service.readWrap(w.authority)).invoices[0]!.status, "CANCELLED");
  for (const call of mutations(w).filter(call => /\/(send|cancel)$/.test(call.path))) assert.deepEqual(call.body, { send_to_recipient: false, send_to_invoicer: false });
  assert.equal(mutations(w).length, 3); await run(w, original.id, send); await run(w, original.id, cancel); assert.equal(mutations(w).length, 3);
});
test("lost original creation is reconciled only by its saved number/reference and never recreated", async () => {
  const w = await fresh(); w.wire.behavior.lostCreate = true; w.wire.behavior.searchUnavailable = true; const id = await draft(w), grantId = await grant(w, id, "create"); await run(w, id, grantId); let data = await service.readWrap(w.authority);
  assert.equal(data.invoices[0]!.status, "UNKNOWN"); assert.equal(data.invoices[0]!.providerId, null); assert.equal(mutations(w).length, 1);
  w.wire.behavior.searchUnavailable = false; await run(w, id, grantId); data = await service.readWrap(w.authority); assert.equal(data.invoices[0]!.status, "DRAFT"); assert.equal(mutations(w).length, 1); assert.equal(w.wire.invoices.size, 1);
  const original = data.entries[0]!; await assert.rejects(execute(w, { type: "prepare_invoice", entryId: original.entry.entryId, entryRecordId: original.id, admissionId: data.admissions[0]!.id, admissionDigest: data.admissions[0]!.digest, detail: "A replacement must not be created." }), code("INVOICE_ORIGINAL_EXISTS"));
});
test("incomplete or duplicate exact searches retain uncertainty rather than substitute an identity", async t => { for (const mode of ["partialSearch", "searchDuplicate"] as const) await t.test(mode, async () => { const w = await fresh(); w.wire.behavior.lostCreate = true; w.wire.behavior[mode] = true; const id = await draft(w), grantId = await grant(w, id, "create"); await run(w, id, grantId); const data = await service.readWrap(w.authority); assert.equal(data.invoices[0]!.verified, false); assert.equal(data.invoices[0]!.providerId, null); await run(w, id, grantId); assert.equal(mutations(w).length, 1); }); });
test("every changed reviewed envelope field prevents send at the actual core transport boundary", async t => {
  const changes: Record<string, (raw: any) => void> = { issuer: raw => { raw.invoicer.email_address = "other@invoice.invalid"; }, recipient: raw => { raw.primary_recipients[0].billing_info.email_address = "other@invoice.invalid"; }, amount: raw => { raw.amount = { currency_code: "USD", value: "10.01" }; raw.items[0].unit_amount = raw.amount; }, purpose: raw => { raw.items[0].name = "Changed item purpose"; }, date: raw => { raw.detail.invoice_date = "2099-01-01"; }, terms: raw => { raw.detail.payment_term.term_type = "NET_30"; }, extra_recipient: raw => { raw.primary_recipients.push(structuredClone(raw.primary_recipients[0])); }, policy: raw => { raw.configuration.allow_tip = true; } };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => { const w = await fresh(), value = await created(w), send = await grant(w, value.id, "send"); change(w.wire.invoices.get(value.providerId)); await run(w, value.id, send); assert.equal(mutations(w).filter(call => call.path.endsWith("/send")).length, 0); assert.equal((await service.readWrap(w.authority)).invoices[0]!.status, "UNKNOWN"); });
});
test("revocation, expired review, removed admission and revoked session stop queued creation", async t => {
  for (const mode of ["revoke", "expiry", "admission", "session"] as const) await t.test(mode, async () => { const w = await fresh(), id = await draft(w), grantId = await grant(w, id, "create"), now = Date.now;
    if (mode === "revoke") await execute(w, { type: "revoke_invoice", grantId, detail: "Revoked before final provider dispatch.", confirmed: true });
    if (mode === "admission") w.wire.behavior.admissionRevoked = true;
    if (mode === "session") await database.pool.query("DELETE FROM on_sessions WHERE token_hash=$1", [w.authority.sessionHash]);
    try { if (mode === "expiry") Date.now = () => now() + 11 * 60_000; await run(w, id, grantId); } finally { Date.now = now; }
    assert.equal(mutations(w).length, 0);
  });
});
test("revocation between original GET and send prevents the mutation", async () => {
  let revoke = false, sessionHash = ""; const wire = createWrapWireFixture({ beforeCall: async call => { if (revoke && call.method === "GET") { revoke = false; await database.pool.query("DELETE FROM on_sessions WHERE token_hash=$1", [sessionHash]); } } }), w = await fresh(wire); sessionHash = w.authority.sessionHash; const value = await created(w), send = await grant(w, value.id, "send"); revoke = true; await run(w, value.id, send); assert.equal(mutations(w).filter(call => call.path.endsWith("/send")).length, 0);
});
test("unknown send continues with GET only and retains the original approval", async () => { const w = await fresh(), value = await created(w), send = await grant(w, value.id, "send"); w.wire.behavior.lostSend = true; w.wire.behavior.afterMutationReadsUnavailable = true; await run(w, value.id, send); assert.equal((await service.readWrap(w.authority)).invoices[0]!.status, "UNKNOWN"); w.wire.behavior.readsUnavailable = false; await run(w, value.id, send); const data = await service.readWrap(w.authority); assert.equal(data.invoices[0]!.status, "SHARED"); assert.equal(data.invoices[0]!.grants.find(item => item.id === send)?.id, send); assert.equal(mutations(w).filter(call => call.path.endsWith("/send")).length, 1); });
test("concurrent workers fence the one original provider dispatch", async () => { const w = await fresh(), id = await draft(w), grantId = await grant(w, id, "create"), results = await Promise.allSettled([run(w, id, grantId), run(w, id, grantId)]); assert.ok(results.some(result => result.status === "fulfilled")); assert.equal(mutations(w).length, 1); assert.equal((await service.readWrap(w.authority)).invoices[0]!.status, "DRAFT"); });
test("exact collection and refund lists reconcile; adverse reads preserve historical collection", async () => {
  const w = await fresh(), value = await created(w); const send = await grant(w, value.id, "send"); await run(w, value.id, send); w.wire.collect(value.providerId, 1000); await refresh(w, value.id); let data = await service.readWrap(w.authority); assert.equal(data.report.totals.currentCashInMinor, 1000); assert.equal(data.report.totals.approvedRevenueMinor, 1000); assert.equal(data.report.totals.invoiceClaimsMinor, 0);
  w.wire.collect(value.providerId, 1000, 200); await refresh(w, value.id); data = await service.readWrap(w.authority); assert.equal(data.report.totals.currentCashInMinor, 800); assert.equal(data.invoices[0]!.currentRefundedMinor, 200);
  w.wire.behavior.readsUnavailable = true; await refresh(w, value.id); data = await service.readWrap(w.authority); assert.equal(data.report.totals.currentCashInMinor, 0); assert.equal(data.report.totals.historicalCashInMinor, 800); assert.equal(data.invoices[0]!.historicalCollectedMinor, 1000); assert.equal(data.invoices[0]!.historicalRefundedMinor, 200);
});
test("Toolkit construction requires blank credentials, every egress guard and the exact installed interceptor", async t => {
  for (const mode of ["paypal_credential", "model_credential", "fetch_guard", "https_guard", "exact_interceptor"] as const) await t.test(mode, async () => {
    const w = await fresh(), value = await created(w), data = await service.readWrap(w.authority), resource = data.toolkit.find(item => item.key === "invoice:" + value.id)!;
    const require = createRequire(import.meta.url), toolkitRequire = createRequire(require.resolve("@paypal/agent-toolkit/openai")), axios = toolkitRequire("axios"), handlers = axios.interceptors.request.handlers;
    const guard = Reflect.get(globalThis, "openingNightProviderEgressGuard"), paypalCredential = process.env.PAYPAL_CLIENT_ID, modelCredential = process.env.OPENAI_API_KEY, before = w.wire.calls.length;
    try {
      if (mode === "paypal_credential") process.env.PAYPAL_CLIENT_ID = "deliberate-non-secret-test-value";
      if (mode === "model_credential") process.env.OPENAI_API_KEY = "deliberate-non-secret-test-value";
      if (mode === "fetch_guard") Reflect.set(globalThis, "openingNightProviderEgressGuard", { ...guard, fetch: false });
      if (mode === "https_guard") Reflect.set(globalThis, "openingNightProviderEgressGuard", { ...guard, nodeHttps: false });
      if (mode === "exact_interceptor") axios.interceptors.request.handlers = [];
      const call = () => toolkit.executeToolkit(w.authority, { idempotencyKey: randomUUID(), expectedRevision: data.revision, expectedShowRevision: data.productionRevision, resourceKey: resource.key, tool: resource.tool, reportDigest: data.report.contentDigest });
      if (mode === "paypal_credential" || mode === "model_credential") await assert.rejects(call, code("WRAP_QA_DISABLED"));
      else {
        const result = await call(); assert.equal(result.receipt?.outcome, "unverified");
        assert.match(result.receipt!.summary, mode === "exact_interceptor" ? /TOOLKIT_GUARD_MISSING/ : /TOOLKIT_FIXTURE_BOUNDARY/);
      }
      assert.equal(w.wire.calls.length, before, "Boundary rejection must precede even fixture OAuth or resource transport");
    } finally {
      if (paypalCredential === undefined) delete process.env.PAYPAL_CLIENT_ID; else process.env.PAYPAL_CLIENT_ID = paypalCredential;
      if (modelCredential === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = modelCredential;
      Reflect.set(globalThis, "openingNightProviderEgressGuard", guard); axios.interceptors.request.handlers = handlers;
    }
  });
});
test("official installed Toolkit reads only an exact owned invoice and exact replay does not re-call it", async () => {
  const w = await fresh(), value = await created(w), data = await service.readWrap(w.authority), resource = data.toolkit.find(item => item.key === "invoice:" + value.id)!;
  const input = { idempotencyKey: randomUUID(), expectedRevision: data.revision, expectedShowRevision: data.productionRevision, resourceKey: resource.key, tool: resource.tool, reportDigest: data.report.contentDigest }, result = await toolkit.executeToolkit(w.authority, input);
  assert.equal(result.receipt?.outcome, "verified_read"); assert.match(result.receipt!.summary, /Official PayPal Agent Toolkit 1.11.0/); const count = w.wire.calls.filter(call => call.toolkit).length; assert.equal(count, 1); await toolkit.executeToolkit(w.authority, input); assert.equal(w.wire.calls.filter(call => call.toolkit).length, count); assert.equal(mutations(w).length, 1);
  const freshData = await service.readWrap(w.authority); await assert.rejects(toolkit.executeToolkit(w.authority, { ...input, idempotencyKey: randomUUID(), expectedRevision: freshData.revision, expectedShowRevision: freshData.productionRevision, reportDigest: freshData.report.contentDigest, resourceKey: "invoice:" + randomUUID() }), code("TOOLKIT_RESOURCE_DENIED"));
});
test("Toolkit observed capture fees reconcile exact original order and preserve current/historical distinction", async () => {
  const w = await fresh(), show = structuredClone(w.session.show), capture = evidence(show, { providerResourceId: "CAP-FEE", parentId: "ORDER-FEE", ticketId: "ticket-fee", amountMinor: 5000 }); show.financialEvidence.push(capture); await database.pool.query("UPDATE on_shows SET snapshot=$2 WHERE tenant_id=$1", [show.tenantId, show]);
  w.wire.orders.set("ORDER-FEE", { id: "ORDER-FEE", purchase_units: [{ payments: { captures: [{ id: "CAP-FEE", status: "COMPLETED", amount: { currency_code: "USD", value: "50.00" }, seller_receivable_breakdown: { gross_amount: { currency_code: "USD", value: "50.00" }, paypal_fee: { currency_code: "USD", value: "1.50" }, net_amount: { currency_code: "USD", value: "48.50" } } }] } }] });
  const read = async () => { const data = await service.readWrap(w.authority), resource = data.toolkit.find(item => item.tool === "get_order")!; return toolkit.executeToolkit(w.authority, { idempotencyKey: randomUUID(), expectedRevision: data.revision, expectedShowRevision: data.productionRevision, reportDigest: data.report.contentDigest, resourceKey: resource.key, tool: resource.tool }); };
  const result = await read(); assert.equal(result.receipt?.outcome, "verified_read"); assert.equal(result.data.report.totals.currentFeeMinor, 150); assert.equal(result.data.report.totals.currentNetMovementMinor, 4850); assert.equal(result.data.report.totals.unknownFeeCount, 0);
  w.wire.behavior.toolkitUnavailable = true; const adverse = await read(); assert.equal(adverse.data.report.totals.currentFeeMinor, 0); assert.equal(adverse.data.report.totals.historicalFeeMinor, 150); assert.equal(adverse.data.report.totals.unknownFeeCount, 1);
});
test("sealed PDF and JSON are complete immutable bytes after new entries and adverse observations", async () => {
  const w = await fresh(); await entry(w, "baseline_cost", 50000); await entry(w, "expense", 48000); const data = await service.readWrap(w.authority), input = { idempotencyKey: randomUUID(), expectedRevision: data.revision, expectedShowRevision: data.productionRevision, title: "Controlled complete production account", reportDigest: data.report.contentDigest }, result = await reports.sealWrapReport(w.authority, input);
  const pdf = await reports.readSealedReport(w.authority, result.edition.id, "pdf"), json = await reports.readSealedReport(w.authority, result.edition.id, "json"); assert.ok(pdf.pages >= 5); assert.equal(pdf.bytes!.subarray(0, 5).toString(), "%PDF-"); assert.equal(JSON.parse(json.bytes!.toString()).lines.length, 2); assert.equal(result.edition.pdfHash, reports.byteHash(pdf.bytes!));
  await entry(w, "revenue", 2000); const laterPdf = await reports.readSealedReport(w.authority, result.edition.id, "pdf"), laterJson = await reports.readSealedReport(w.authority, result.edition.id, "json"); assert.deepEqual(laterPdf.bytes, pdf.bytes); assert.deepEqual(laterJson.bytes, json.bytes); assert.equal((await reports.sealWrapReport(w.authority, input)).replayed, true);
  await assert.rejects(database.pool.query("UPDATE on_wrap_reports SET title='rewritten' WHERE id=$1", [result.edition.id]), /Immutable wrap history/);
  const other = await fresh(); await assert.rejects(reports.readSealedReport(other.authority, result.edition.id, "pdf"), code("WRAP_REPORT_NOT_FOUND"));
});
test("route contracts refuse foreign origins, personal capabilities, arbitrary mutation names and filtered exports", async () => {
  const w = await fresh(), token = await store.createCrewCapability(w.session.actor, "priya"), denied = await route.GET(request(token)); assert.equal(denied.status, 403); assert.equal(denied.headers.get("cache-control"), "private, no-store");
  assert.equal((await route.POST(request(w.session.token, {}, "http://foreign.invalid"))).status, 403); assert.equal((await route.POST(request(w.session.token, { type: "send_invoice", recipient: "other@owned.invalid" }))).status, 400);
  assert.equal((await reviewRoute.POST(request(w.session.token, { invoiceId: randomUUID(), operation: "send" }))).status, 404); assert.equal((await workRoute.POST(request(w.session.token, { grantId: randomUUID() }))).status, 400);
  const response = await reportRoute.GET(new Request("http://localhost:4538/api/wrap/reports/" + randomUUID() + "?format=pdf&line=foreign", { headers: { authorization: "Bearer " + w.session.token } }), { params: Promise.resolve({ id: randomUUID() }) }); assert.equal(response.status, 400);
});

test("signed adjustments preserve an invoiced original face and reconcile an overpayment as credit", async () => {
  const w = await fresh(), value = await created(w); await run(w, value.id, await grant(w, value.id, "send")); w.wire.collect(value.providerId, 1000); await refresh(w, value.id); const data = await service.readWrap(w.authority), original = data.entries[0]!;
  const adjusted = await execute(w, { type: "adjust_entry", entryId: original.entry.entryId, entryRecordId: original.id, previousAdjustmentId: null, deltaMinor: -200, reference: "SIGNED-CREDIT-1", detail: "Reviewed original agreement credit; original invoice and payment stay unchanged.", reviewedOriginal: true });
  assert.equal(adjusted.data.report.totals.approvedRevenueMinor, 800); assert.equal(adjusted.data.report.totals.currentCashInMinor, 1000); assert.equal(adjusted.data.report.totals.creditMinor, 200); assert.equal(adjusted.data.invoices[0]!.amountMinor, 1000);
  await assert.rejects(execute(w, { type: "adjust_entry", entryId: original.entry.entryId, entryRecordId: original.id, previousAdjustmentId: adjusted.receipt.id, deltaMinor: -801, reference: "EXCESS-CREDIT", detail: "Cannot reduce the approved balance below zero.", reviewedOriginal: true }), code("WRAP_ADJUSTMENT_CONSERVATION"));
  await assert.rejects(execute(w, { type: "save_entry", entry: { ...original.entry, previousId: original.id, amountMinor: 800 } }), code("WRAP_INVOICED_ENTRY_LOCKED"));
});
test("changed or disappeared original invoice payment identities withdraw current collection", async t => {
  for (const mode of ["amount", "disappeared"] as const) await t.test(mode, async () => {
    const w = await fresh(), value = await created(w); await run(w, value.id, await grant(w, value.id, "send")); w.wire.collect(value.providerId, 1000); await refresh(w, value.id);
    const raw = w.wire.invoices.get(value.providerId); if (mode === "amount") { raw.payments.transactions[0].amount.value = "9.00"; raw.payments.paid_amount.value = "9.00"; raw.status = "PARTIALLY_PAID"; raw.due_amount.value = "1.00"; } else { raw.status = "SHARED"; raw.payments = undefined; raw.due_amount.value = "10.00"; }
    await refresh(w, value.id); const data = await service.readWrap(w.authority); assert.equal(data.invoices[0]!.verified, false); assert.equal(data.report.totals.currentCashInMinor, 0); assert.equal(data.report.totals.historicalCashInMinor, 1000); assert.ok(data.report.lines[0]!.evidence.some(item => item.kind === "invoice_payment"));
  });
});
test("pending original invoice refresh immediately withdraws proof; adverse Toolkit cannot restore it", async () => {
  const w = await fresh(), value = await created(w); await run(w, value.id, await grant(w, value.id, "send")); w.wire.collect(value.providerId, 1000); await refresh(w, value.id);
  const pending = await execute(w, { type: "refresh_invoice", invoiceId: value.id }); assert.equal(pending.data.report.totals.currentCashInMinor, 0); assert.equal(pending.data.report.totals.historicalCashInMinor, 1000);
  w.wire.behavior.toolkitUnavailable = true; const data = await service.readWrap(w.authority), resource = data.toolkit.find(item => item.key === "invoice:" + value.id)!;
  const result = await toolkit.executeToolkit(w.authority, { idempotencyKey: randomUUID(), expectedRevision: data.revision, expectedShowRevision: data.productionRevision, reportDigest: data.report.contentDigest, resourceKey: resource.key, tool: resource.tool }); assert.equal(result.data.report.totals.currentCashInMinor, 0); assert.equal(result.data.report.totals.historicalCashInMinor, 1000);
});
test("one provider payment cannot be counted across two original invoices", async () => {
  const w = await fresh(), first = await created(w); await run(w, first.id, await grant(w, first.id, "send")); w.wire.collect(first.providerId, 1000); await refresh(w, first.id);
  const secondId = await draft(w); await run(w, secondId, await grant(w, secondId, "create")); const second = (await service.readWrap(w.authority)).invoices.find(item => item.id === secondId)!; await run(w, second.id, await grant(w, second.id, "send")); w.wire.collect(second.providerId!, 1000); w.wire.invoices.get(second.providerId!).payments.transactions[0].payment_id = w.wire.invoices.get(first.providerId).payments.transactions[0].payment_id;
  await refresh(w, second.id); const data = await service.readWrap(w.authority); assert.equal(data.invoices.find(item => item.id === second.id)!.verified, false); assert.equal(data.report.totals.currentCashInMinor, 1000);
});
