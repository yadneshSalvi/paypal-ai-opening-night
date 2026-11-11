import { randomUUID } from "node:crypto";
import { DomainError, type Actor } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { currentRentalExecution, supplierIds, type SupplierId, type SupplierQuote } from "@/domain/supplier-contracts";
import { enqueueJob, type JobResult } from "./jobs";
import { callSupplierService, type SupplierTransport } from "./supplier-protocol";
import { assertProducer, assertRevision, lockSupplierShow, saveSupplierSnapshot, supplierTransaction } from "./supplier-storage";
import { getShow, pool } from "./store";

interface RfqRow { id: string; tenant_id: string; actor_id: string; expected_revision: number; payload_hash: string; status: "collecting" | "applied" | "needs_review"; request_ids: Record<SupplierId, string>; quote_ids: string[]; last_code: string | null; created_at: Date }
export async function beginSupplierRfq(actor: Actor, id: string, expectedRevision: number) {
  assertProducer(actor);
  return supplierTransaction(async client => {
    const show = await lockSupplierShow(client, actor.tenantId); const payloadHash = digest({ actorId: actor.id, expectedRevision });
    const prior = await client.query<RfqRow>("SELECT * FROM on_supplier_rfqs WHERE tenant_id=$1 AND id=$2", [actor.tenantId, id]);
    if (prior.rows[0]) { if (prior.rows[0].payload_hash !== payloadHash) throw new DomainError("RFQ_IDENTITY_CONFLICT", "This quote request identity already has different instructions."); return prior.rows[0]; }
    assertRevision(show, expectedRevision);
    if (show.commercialProtocol !== 2) throw new DomainError("LEGACY_RENTAL_PRESERVED", "This rehearsal retains its original rental and payment history. Open a fresh rehearsal for the signed supplier network.");
    const execution = currentRentalExecution(show);
    if (execution && !["cancelled", "returned"].includes(execution.state)) throw new DomainError("COMMITMENT_EXISTS", "Reconcile or release the current rental commitment before replacing its approved terms.");
    const requestIds = Object.fromEntries(supplierIds.map(supplier => [supplier, randomUUID()])) as Record<SupplierId, string>;
    const result = await client.query<RfqRow>("INSERT INTO on_supplier_rfqs(id,tenant_id,actor_id,expected_revision,payload_hash,status,request_ids) VALUES($1,$2,$3,$4,$5,'collecting',$6) RETURNING *", [id, actor.tenantId, actor.id, expectedRevision, payloadHash, requestIds]);
    await enqueueJob(client, { tenantId: actor.tenantId, kind: "supplier_rfq", semanticKey: id, payload: { rfqId: id }, runAfter: new Date(Date.now() + 30000) });
    return result.rows[0]!;
  });
}

/** Each scope signs its own request and response. A partial collection never replaces the active offers. */
export async function collectSupplierRfq(tenantId: string, id: string, signal: AbortSignal, transport?: SupplierTransport): Promise<JobResult> {
  const stored = await pool.query<RfqRow>("SELECT * FROM on_supplier_rfqs WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
  const request = stored.rows[0]; if (!request) return { status: "needs_attention", code: "RFQ_NOT_FOUND" };
  if (request.status === "applied") return { status: "complete" };
  if (request.status === "needs_review") return { status: "needs_attention", code: request.last_code ?? "RFQ_REVIEW_REQUIRED" };
  const results = await Promise.allSettled(supplierIds.map(supplier => callSupplierService(supplier, { version: 1, requestId: request.request_ids[supplier], tenantId, actorId: request.actor_id, action: { type: "quote" } }, signal, transport)));
  const quotes: SupplierQuote[] = [];
  let failure: Exclude<JobResult, { status: "complete" }> | null = null;
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.kind === "quote") quotes.push(result.value.quote);
    else {
      const error = result.status === "rejected" ? result.reason : null;
      const code = error instanceof DomainError ? error.code : "SUPPLIER_UNAVAILABLE";
      const next: Exclude<JobResult, { status: "complete" }> = { status: error instanceof DomainError && error.status < 500 ? "needs_attention" : "waiting", code };
      if (!failure || next.status === "needs_attention") failure = next;
    }
  }
  return supplierTransaction(async client => {
    const show = await lockSupplierShow(client, tenantId);
    const current = (await client.query<RfqRow>("SELECT * FROM on_supplier_rfqs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, id])).rows[0]!;
    if (current.status === "applied") return { status: "complete" };
    if (current.status !== "collecting") return { status: "needs_attention", code: current.last_code ?? "RFQ_REVIEW_REQUIRED" };
    if (failure) {
      await client.query("UPDATE on_supplier_rfqs SET quote_ids=$3,last_code=$4,status=$5 WHERE tenant_id=$1 AND id=$2", [tenantId, id, JSON.stringify(quotes.map(quote => quote.id)), failure.code, failure.status === "needs_attention" ? "needs_review" : "collecting"]);
      return failure;
    }
    const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    const stale = show.revision !== request.expected_revision ? "RFQ_PLAN_CHANGED" : quotes.length !== supplierIds.length || quotes.some(quote => Date.parse(quote.validUntil) <= now.getTime()) ? "RFQ_EXPIRED" : null;
    if (stale) { await client.query("UPDATE on_supplier_rfqs SET status='needs_review',quote_ids=$3,last_code=$4 WHERE tenant_id=$1 AND id=$2", [tenantId, id, JSON.stringify(quotes.map(quote => quote.id)), stale]); return { status: "needs_attention", code: stale }; }
    show.offers = supplierIds.map(supplier => {
      const quote = quotes.find(item => item.supplierId === supplier)!;
      return { ...quote.offer, serviceQuote: { id: quote.id, termsDigest: quote.termsDigest, issuedAt: quote.issuedAt, validUntil: quote.validUntil, serviceId: "enrolled-fixture:" + supplier, source: "authenticated_fixture_service" as const } };
    });
    if (show.approvedPlan) { show.approvedPlan = null; show.planVersion++; show.state = "standby"; show.goReportId = null; }
    for (const quote of quotes) show.sources.push({ id: quote.id, title: `${quote.offer.supplier} authenticated fixture quote · revision ${quote.revision}`, source: "sample", recordedAt: quote.issuedAt, detail: `${quote.equipment.model}. ${quote.equipment.capabilityEvidence} ${quote.cancellation} Terms digest ${quote.termsDigest}. Driver/condition evidence remains explicitly unresolved for the sister-venue loan.` });
    await client.query("UPDATE on_supplier_rfqs SET status='applied',quote_ids=$3,last_code=NULL,applied_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, id, JSON.stringify(quotes.map(quote => quote.id))]);
    // A synchronous collection can finish before a worker claims its wakeup.
    // Leave an already-running lease to its fenced owner to finish normally.
    await client.query("UPDATE on_jobs SET status='complete',last_code=NULL,updated_at=now() WHERE tenant_id=$1 AND kind='supplier_rfq' AND semantic_key=$2 AND status IN ('queued','waiting')", [tenantId, id]);
    await saveSupplierSnapshot(client, show, request.actor_id, "supplier.quotes_received", "Received and authenticated three separately scoped fixture-service quotes. New offer revisions require a fresh recovery comparison; no physical capacity or payment is implied.");
    return { status: "complete" };
  });
}
export async function supplierOverview(actor: Actor) {
  assertProducer(actor); const show = await getShow(actor.tenantId);
  const requests = await pool.query<RfqRow>("SELECT * FROM on_supplier_rfqs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 8", [actor.tenantId]);
  const quoteIds = show.offers.flatMap(offer => offer.serviceQuote ? [offer.serviceQuote.id] : []);
  const quotes = await pool.query<{ document: SupplierQuote }>("SELECT document FROM on_supplier_quotes WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [actor.tenantId, quoteIds]);
  return { protocol: show.commercialProtocol ?? 1, serverAt: new Date().toISOString(), quotes: quotes.rows.map(row => row.document), executions: show.rentalExecutions ?? [], requests: requests.rows.map(row => ({ id: row.id, status: row.status, received: row.quote_ids.length, lastCode: row.last_code, createdAt: row.created_at.toISOString() })) };
}
