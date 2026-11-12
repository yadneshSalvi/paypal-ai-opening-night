/** Controlled SDK transport and real isolated PostgreSQL; no actual provider requests. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedDatabase } from "./isolated-database";
import { responseWire } from "./invoice-response-fixture";
import { digest } from "../src/domain/hash";
import type { WrapCommand } from "../src/domain/wrap/contracts";

const database = await isolatedDatabase();
assert.equal((await database.pool.query("SELECT current_schema() AS schema")).rows[0]?.schema, database.schema);
const store = await import("../src/server/store"), service = await import("../src/server/wrap/service"), provider = await import("../src/server/wrap/provider"), worker = await import("../src/server/wrap/worker"), toolkit = await import("../src/server/wrap/toolkit"), locks = await import("../src/server/commerce-locks");
const { sessionTokenHash } = await import("../src/server/session-records");
after(async () => { await locks.closeCommerceLocks(); await database.close(); });
async function fresh(wire = responseWire()) {
  provider.installWrapFixture(wire as unknown as import("../src/server/wrap/provider").WrapFixtureRuntime);
  const session = await store.createSession(undefined, "invoice-response:" + randomUUID());
  return { wire, session, authority: { actor: session.actor, sessionHash: sessionTokenHash(session.token), scope: "production" as const } };
}
type Workspace = Awaited<ReturnType<typeof fresh>>;
async function execute(w: Workspace, command: WrapCommand) { const data = await service.readWrap(w.authority); return service.executeWrap(w.authority, { idempotencyKey: randomUUID(), expectedRevision: data.revision, expectedShowRevision: data.productionRevision, command }); }
async function prepare(w: Workspace) {
  const saved = await execute(w, { type: "save_entry", entry: { entryId: randomUUID(), previousId: null, kind: "revenue", category: "sponsorship", label: "Controlled original one-dollar service", amountMinor: 100, currency: "USD", serviceDay: w.session.show.showDate, reference: "CONTROLLED-" + randomUUID(), detail: "Synthetic owned parties and a controlled original response compatibility test.", sourceIds: [], reviewedScope: true } });
  const entry = saved.data.entries.find(item => item.id === saved.receipt.id)!, admission = saved.data.admissions[0]!;
  return (await execute(w, { type: "prepare_invoice", entryId: entry.entry.entryId, entryRecordId: entry.id, admissionId: admission.id, admissionDigest: admission.digest, detail: "Prepare the original controlled invoice; approval remains separate." })).receipt.id;
}
async function grant(w: Workspace, invoiceId: string, operation: "create" | "send" | "cancel") {
  const review = await service.readInvoiceReview(w.authority, invoiceId, operation); assert.deepEqual(review.review.blockers, []);
  return (await execute(w, { type: "approve_invoice", invoiceId, operation, reviewDigest: review.review.digest, detail: "Reviewed exact original parties, one dollar, date, due terms, and both disabled email flags.", reviewedParties: true, reviewedAmount: true, reviewedTerms: true, reviewedDelivery: true })).receipt.id;
}
const run = (w: Workspace, invoiceId: string, grantId: string) => worker.runInvoiceJob(w.authority.actor.tenantId, { invoiceId, grantId, refreshId: null }, AbortSignal.timeout(10_000));
const mutations = (w: Workspace) => w.wire.calls.filter(call => call.method === "POST" && !call.path.endsWith("/search-invoices"));
const retained = async (w: Workspace) => (await database.pool.query("SELECT id,to_jsonb(on_wrap_records) AS record FROM on_wrap_records WHERE tenant_id=$1 ORDER BY revision", [w.session.actor.tenantId])).rows;

test("legacy response completes exact create, separate no-email issuance/cancellation and owned Toolkit read", async () => {
  const w = await fresh(), invoiceId = await prepare(w), create = await grant(w, invoiceId, "create");
  await run(w, invoiceId, create);
  let data = await service.readWrap(w.authority), view = data.invoices[0]!;
  assert.equal(view.status, "DRAFT", view.problem ?? "No problem"); assert.equal(view.verified, true);
  const providerId = view.providerId!;
  assert.ok(w.wire.invoices.has(providerId)); assert.equal(view.envelope?.paymentTerm, "NO_DUE_DATE");
  assert.equal(view.envelope?.amountMinor, 100); assert.equal(view.currentCollectedMinor, 0);
  const send = await grant(w, invoiceId, "send"); await run(w, invoiceId, send);
  data = await service.readWrap(w.authority); assert.equal(data.invoices[0]!.status, "SHARED"); assert.equal(data.invoices[0]!.providerId, providerId);
  const cancel = await grant(w, invoiceId, "cancel"); await run(w, invoiceId, cancel);
  data = await service.readWrap(w.authority); assert.equal(data.invoices[0]!.status, "CANCELLED"); assert.equal(data.report.totals.currentCashInMinor, 0);
  const resource = data.toolkit.find(item => item.key === "invoice:" + invoiceId)!;
  const read = await toolkit.executeToolkit(w.authority, { idempotencyKey: randomUUID(), expectedRevision: data.revision, expectedShowRevision: data.productionRevision, resourceKey: resource.key, tool: resource.tool, reportDigest: data.report.contentDigest });
  assert.equal(read.receipt?.outcome, "verified_read"); assert.equal(read.data.invoices[0]!.providerId, providerId);
  assert.equal(w.wire.invoices.size, 1); assert.equal(mutations(w).length, 3);
  for (const call of mutations(w).filter(call => /\/(send|cancel)$/.test(call.path))) assert.deepEqual(call.body, { send_to_recipient: false, send_to_invoicer: false });
  assert.ok(w.wire.calls.filter(call => call.method === "GET").every(call => call.path === "/v2/invoicing/invoices/" + providerId));
  assert.ok(w.wire.urls.every(value => new URL(value).origin === "https://api-m.sandbox.paypal.com"));
});

test("an unverified original create recovers through exact refresh without renewing or replacing its consumed grant", async () => {
  const wire = responseWire(), actual = wire.transport; let malformed = true;
  wire.transport = async (input, init) => {
    const response = await actual(input, init), request = input instanceof Request ? input : new Request(input, init);
    if (malformed && request.method === "GET" && new URL(request.url).pathname.startsWith("/v2/invoicing/invoices/") && response.ok) {
      const raw = await response.json(); raw.configuration.partial_payment = null;
      return Response.json(raw, { status: 200 });
    }
    return response;
  };
  const w = await fresh(wire), invoiceId = await prepare(w), create = await grant(w, invoiceId, "create");
  await run(w, invoiceId, create);
  let data = await service.readWrap(w.authority);
  assert.equal(data.invoices[0]!.status, "UNKNOWN"); assert.equal(data.invoices[0]!.verified, false);
  assert.equal(data.invoices[0]!.grants[0]!.state, "dispatched");
  const before = await retained(w), hashes = new Map(before.map(row => [row.id, digest(row.record)])), originalId = [...wire.invoices.keys()][0];
  assert.equal(mutations(w).length, 1); assert.equal(wire.invoices.size, 1);
  malformed = false;
  const refreshed = await execute(w, { type: "refresh_invoice", invoiceId });
  await worker.runInvoiceJob(w.authority.actor.tenantId, { invoiceId, grantId: null, refreshId: refreshed.receipt.id }, AbortSignal.timeout(10_000));
  data = await service.readWrap(w.authority);
  assert.equal(data.invoices[0]!.status, "DRAFT", data.invoices[0]!.problem ?? "No problem");
  assert.equal(data.invoices[0]!.providerId, originalId); assert.equal(data.invoices[0]!.grants.length, 1);
  assert.equal(data.invoices[0]!.grants[0]!.id, create); assert.equal(data.invoices[0]!.grants[0]!.state, "dispatched");
  assert.equal(mutations(w).length, 1); assert.equal(wire.invoices.size, 1);
  for (const row of await retained(w)) if (hashes.has(row.id)) assert.equal(digest(row.record), hashes.get(row.id), "Prior failed evidence remains immutable");
  const review = await service.readInvoiceReview(w.authority, invoiceId, "create"); assert.ok(review.review.blockers.length);
  assert.ok(wire.calls.some(call => call.path.endsWith("/search-invoices")));
});

test("a fresh policy or discount change after exact issuance review blocks the provider write", async t => {
  const changes: Record<string, (raw: any) => void> = {
    partial_null: raw => { raw.configuration.partial_payment = null; },
    partial_true: raw => { raw.configuration.partial_payment = { allow_partial_payment: true }; },
    partial_minimum: raw => { raw.configuration.partial_payment = { allow_partial_payment: false, minimum_amount_due: { currency_code: "USD", value: "0.00" } }; },
    nonzero_discount: raw => { raw.amount.breakdown.discount.invoice_discount.amount.value = "0.01"; },
    incomplete_discount: raw => { delete raw.amount.breakdown.discount.item_discount; },
    unknown_discount: raw => { raw.amount.breakdown.discount.invoice_discount.percent = "0"; },
    null_tax_policy: raw => { raw.configuration.tax_inclusive = null; },
    changed_due_terms: raw => { raw.detail.payment_term.term_type = "NET_30"; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const w = await fresh(), invoiceId = await prepare(w), create = await grant(w, invoiceId, "create"); await run(w, invoiceId, create);
    const data = await service.readWrap(w.authority), providerId = data.invoices[0]!.providerId!, send = await grant(w, invoiceId, "send");
    change(w.wire.invoices.get(providerId)); await run(w, invoiceId, send);
    assert.equal(mutations(w).filter(call => call.path.endsWith("/send")).length, 0);
    assert.equal((await service.readWrap(w.authority)).invoices[0]!.status, "UNKNOWN");
  });
});

test("app guard holds a foreign create href without allowing any unbound invoice GET", async () => {
  const wire = responseWire(id => "https://attacker.invalid/v2/invoicing/invoices/" + id); wire.behavior.searchUnavailable = true;
  const w = await fresh(wire), invoiceId = await prepare(w), create = await grant(w, invoiceId, "create"); await run(w, invoiceId, create);
  assert.equal((await service.readWrap(w.authority)).invoices[0]!.status, "UNKNOWN");
  assert.equal(wire.calls.filter(call => call.method === "GET").length, 0);
  assert.equal(mutations(w).length, 1);
});
