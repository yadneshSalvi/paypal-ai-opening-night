import { randomUUID } from "node:crypto";
import { DomainError, type Actor } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { currentRentalExecution, supplierIds, type SupplierId, type SupplierQuote } from "@/domain/supplier-contracts";
import { createFixture } from "@/domain/fixture";
import type { SupplierRfqOutcome } from "@/domain/supplier-recovery";
import { enqueueJob, type JobResult } from "./jobs";
import { callSupplierService, type SupplierTransport } from "./supplier-protocol";
import { assertProducer, assertRevision, lockSupplierShow, saveSupplierSnapshot, supplierTransaction } from "./supplier-storage";
import { getShow, pool } from "./store";
import { readRecoveryRfq, readSupplierTerms, requireRecoveryRfq, supplierTermsBlocker } from "./supplier-recovery/store";

interface RfqRow { id: string; tenant_id: string; actor_id: string; expected_revision: number; payload_hash: string; status: "collecting" | "applied" | "needs_review"; request_ids: Record<SupplierId, string>; quote_ids: string[]; outcomes: SupplierRfqOutcome[]; last_code: string | null; created_at: Date }
export async function beginSupplierRfq(actor: Actor, id: string, expectedRevision: number) {
  assertProducer(actor);
  return supplierTransaction(async client => {
    const show = await lockSupplierShow(client, actor.tenantId); const payloadHash = digest({ actorId: actor.id, expectedRevision });
    const prior = await client.query<RfqRow>("SELECT * FROM on_supplier_rfqs WHERE tenant_id=$1 AND id=$2", [actor.tenantId, id]);
    if (prior.rows[0]) { if (prior.rows[0].payload_hash !== payloadHash) throw new DomainError("RFQ_IDENTITY_CONFLICT", "This quote request identity already has different instructions."); return prior.rows[0]; }
    assertRevision(show, expectedRevision);
    if (show.commercialProtocol !== 2) throw new DomainError("LEGACY_RENTAL_PRESERVED", "This rehearsal retains its original rental and payment history. Open a fresh rehearsal for the signed supplier network.");
    if (show.cancellationDecision?.mode === "cancel_show") throw new DomainError("PROGRAM_CANCELLED", "The cancelled program cannot be reopened by supplier quotes.");
    if (show.supplierTermRevisions?.length) throw new DomainError("SUPPLIER_RECOVERY_REVIEW_REQUIRED", "Review current supplier editions and retained original obligations in the replacement quote desk.");
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
  const reviewed = await readRecoveryRfq(pool, tenantId, id);
  if (reviewed) {
    try { await supplierTransaction(async client => { const show = await lockSupplierShow(client, tenantId); await requireRecoveryRfq(client, show, reviewed); }); }
    catch (error) {
      if (!(error instanceof DomainError) || error.status >= 500) throw error;
      await pool.query("UPDATE on_supplier_rfqs SET status='needs_review',last_code=$3 WHERE tenant_id=$1 AND id=$2 AND status='collecting'", [tenantId, id, error.code]);
      return { status: "needs_attention", code: error.code };
    }
  }
  const results = await Promise.allSettled(supplierIds.map(supplier => callSupplierService(supplier, { version: 1, requestId: request.request_ids[supplier], tenantId, actorId: request.actor_id, action: { type: "quote", ...(reviewed ? { recoveryRfqId: id } : {}) } }, signal, transport)));
  const quotes: SupplierQuote[] = [];
  const outcomes: SupplierRfqOutcome[] = [];
  let failure: Exclude<JobResult, { status: "complete" }> | null = null;
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.kind === "quote") { quotes.push(result.value.quote); outcomes.push({ supplierId: result.value.quote.supplierId, kind: "quote", quoteId: result.value.quote.id }); }
    else if (result.status === "fulfilled" && result.value.kind === "declined") outcomes.push({ supplierId: result.value.decline.supplierId, kind: "declined", decline: result.value.decline });
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
    if (reviewed) {
      try { await requireRecoveryRfq(client, show, reviewed); }
      catch (error) { if (!(error instanceof DomainError) || error.status >= 500) throw error; failure = { status: "needs_attention", code: error.code }; }
    }
    for (const quote of quotes) if (quote.termsSource) {
      const source = await readSupplierTerms(client, tenantId, quote.termsSource.id);
      const blocker = await supplierTermsBlocker(client, show, source.record, source.digest);
      if (source.digest !== quote.termsSource.digest || blocker) failure = { status: "needs_attention", code: blocker?.code ?? "SUPPLIER_TERMS_CHANGED" };
    }
    if (failure) {
      await client.query("UPDATE on_supplier_rfqs SET quote_ids=$3,last_code=$4,status=$5,outcomes=$6 WHERE tenant_id=$1 AND id=$2", [tenantId, id, JSON.stringify(quotes.map(quote => quote.id)), failure.code, failure.status === "needs_attention" ? "needs_review" : "collecting", JSON.stringify(outcomes)]);
      return failure;
    }
    const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    const stale = show.revision !== request.expected_revision ? "RFQ_PLAN_CHANGED" : outcomes.length !== supplierIds.length || new Set(outcomes.map(item => item.supplierId)).size !== supplierIds.length || quotes.some(quote => Date.parse(quote.validUntil) <= now.getTime() || Date.parse(quote.offer.expiresAt) <= Date.parse(show.clock)) ? "RFQ_EXPIRED" : null;
    if (stale) { await client.query("UPDATE on_supplier_rfqs SET status='needs_review',quote_ids=$3,last_code=$4,outcomes=$5 WHERE tenant_id=$1 AND id=$2", [tenantId, id, JSON.stringify(quotes.map(quote => quote.id)), stale, JSON.stringify(outcomes)]); return { status: "needs_attention", code: stale }; }
    const managed = show.offers.filter(offer => offer.serviceQuote?.adminSource);
    show.offers = [...supplierIds.map(supplier => {
      const quote = quotes.find(item => item.supplierId === supplier);
      // Keep the enrolled identity and prior source visible after a signed decline.
      // Its expired status prevents an old quote from becoming an available option.
      if (!quote) return { ...(show.offers.find(item => item.supplierId === supplier) ?? createFixture(show.tenantId).offers.find(item => item.supplierId === supplier)!), status: "expired" as const };
      return { ...quote.offer, serviceQuote: { id: quote.id, termsDigest: quote.termsDigest, issuedAt: quote.issuedAt, validUntil: quote.validUntil, serviceId: "enrolled-fixture:" + supplier, source: "authenticated_fixture_service" as const, ...(quote.termsSource ? { termsSource: quote.termsSource } : {}) } };
    }), ...managed.map(offer => ({ ...offer, serviceQuote: { ...offer.serviceQuote!, reviewRequired: { code: "MANAGED_RFQ_SOURCE_CHANGED" as const, detail: "The original supplier-network RFQ changed the reviewed production source. Review a distinct bounded managed negotiation. This earlier signed quote and its original expiry remain retained." } } }))];
    if (show.approvedPlan) { show.approvedPlan = null; show.planVersion++; show.state = "standby"; show.goReportId = null; }
    for (const quote of quotes) show.sources.push({ id: quote.id, title: `${quote.offer.supplier} authenticated fixture quote · revision ${quote.revision}`, source: "sample", recordedAt: quote.issuedAt, detail: `${quote.equipment.model}. ${quote.equipment.capabilityEvidence} ${quote.cancellation} Terms digest ${quote.termsDigest}. ${quote.termsSource ? `Supplier-owned edition ${quote.termsSource.revision}, source ${quote.termsSource.id}.` : "Initial controlled fixture terms."} Missing driver or condition evidence remains unresolved.` });
    for (const outcome of outcomes) if (outcome.kind === "declined") show.sources.push({ id: outcome.decline.id, title: `${outcome.supplierId} authenticated quote refusal`, source: "sample", recordedAt: outcome.decline.recordedAt, detail: `${outcome.decline.message} Original request ${id}. This refusal is a known response, not a transport failure or a new commitment.` });
    await client.query("UPDATE on_supplier_rfqs SET status='applied',quote_ids=$3,last_code=NULL,applied_at=now(),outcomes=$4 WHERE tenant_id=$1 AND id=$2", [tenantId, id, JSON.stringify(quotes.map(quote => quote.id)), JSON.stringify(outcomes)]);
    // A synchronous collection can finish before a worker claims its wakeup.
    // Leave an already-running lease to its fenced owner to finish normally.
    await client.query("UPDATE on_jobs SET status='complete',last_code=NULL,updated_at=now() WHERE tenant_id=$1 AND kind='supplier_rfq' AND semantic_key=$2 AND status IN ('queued','waiting')", [tenantId, id]);
    await saveSupplierSnapshot(client, show, request.actor_id, "supplier.quotes_received", `Received three authenticated fixture-service outcomes: ${quotes.length} quote${quotes.length === 1 ? "" : "s"} and ${outcomes.length - quotes.length} refusal${outcomes.length - quotes.length === 1 ? "" : "s"}. Recompute and review a separate recovery plan. All original rentals, fees and holds remain accounted for.`);
    return { status: "complete" };
  });
}
export async function supplierOverview(actor: Actor) {
  assertProducer(actor); const show = await getShow(actor.tenantId);
  const requests = await pool.query<RfqRow>("SELECT * FROM on_supplier_rfqs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 8", [actor.tenantId]);
  const quoteIds = show.offers.flatMap(offer => offer.serviceQuote ? [offer.serviceQuote.id] : []);
  const quotes = await pool.query<{ document: SupplierQuote }>("SELECT document FROM on_supplier_quotes WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [actor.tenantId, quoteIds]);
  return { protocol: show.commercialProtocol ?? 1, serverAt: new Date().toISOString(), quotes: quotes.rows.map(row => row.document), executions: show.rentalExecutions ?? [], requests: requests.rows.map(row => ({ id: row.id, status: row.status, received: row.quote_ids.length, outcomes: row.outcomes, lastCode: row.last_code, createdAt: row.created_at.toISOString() })) };
}
