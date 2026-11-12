import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError, type Actor, type ShowSnapshot, type SupplierOffer } from "@/domain/contracts";
import { createFixture } from "@/domain/fixture";
import { digest } from "@/domain/hash";
import { approvedRental } from "@/domain/payment-authority";
import { currentActual } from "@/domain/finance";
import type { DeliveryReceipt, RentalExecution, SupplierId, SupplierQuote } from "@/domain/supplier-contracts";
import { atVenue, compareInstants } from "@/domain/time";
import { hasCurrentSupportOnlyPlan, latestSupplierDisruption, supplierInterruption } from "@/domain/disruptions";
import { enqueueJob, type JobResult } from "./jobs";
import { signSupplierQuote, signSupplierResponse, verifySupplierQuote, type SupplierRequest, type SupplierResponse, type SupplierResult } from "./supplier-protocol";
import { appendSupplierFact, assertProducer, assertRevision, assertSupplier, lockSupplierShow, readRentalExecution, saveRentalExecution, saveSupplierSnapshot, supplierActor, supplierTransaction } from "./supplier-storage";

const HOLD_MS = 10 * 60 * 1000;
const QUOTE_MS = 15 * 60 * 1000;
async function databaseTime(client: PoolClient) { return (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now; }
async function assertInventoryAvailable(client: PoolClient, show: ShowSnapshot, execution: Pick<RentalExecution, "id" | "supplierId" | "unitId" | "deliveryAt" | "windowEnd">) {
  // Each isolated rehearsal owns a fictional supplier network. A unit is exclusive inside that network.
  // Every caller locks its show before this inventory lock; payment imports use the same order.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,4105004))", [show.tenantId + ":" + execution.supplierId + ":" + execution.unitId]);
  const conflict = await client.query(`SELECT id FROM on_resource_holds WHERE tenant_id=$1 AND supplier_id=$2 AND unit_id=$3 AND id<>$4
    AND window_start<$6::timestamptz AND window_end>$5::timestamptz
    AND (status='confirmed' OR (status='provisional' AND expires_at>clock_timestamp())) LIMIT 1`, [show.tenantId, execution.supplierId, execution.unitId, execution.id, execution.deliveryAt, execution.windowEnd]);
  if (conflict.rowCount) throw new DomainError("UNIT_ALREADY_HELD", "This exact console is already reserved for an overlapping production window.");
}
export function currentSupplierPlan(show: ShowSnapshot, execution: RentalExecution, allowReturnAfterDisruption = false) {
  const { plan, offer } = approvedRental(show);
  if (execution.planVersion !== show.planVersion || execution.planDigest !== plan.digest || execution.offerId !== offer.id || execution.offerRevision !== offer.revision || execution.quoteId !== offer.serviceQuote?.id || execution.quoteDigest !== offer.serviceQuote.termsDigest) throw new DomainError("STALE_EXECUTION", "The supplier commitment belongs to an earlier approved plan. Review its retained history before replanning.");
  if (!allowReturnAfterDisruption && (supplierInterruption(show, offer) || show.cancellationDecision && !hasCurrentSupportOnlyPlan(show))) throw new DomainError("SUPPLIER_DISRUPTION_REVIEW", "The supplier or program changed after these terms. Review the original commitment and obtain fresh terms before another fulfillment step.");
  return offer;
}
async function issueQuote(client: PoolClient, show: ShowSnapshot, supplierId: SupplierId): Promise<SupplierQuote> {
  const base = createFixture(show.tenantId).offers.find(offer => offer.supplierId === supplierId)!;
  const disruption = latestSupplierDisruption(show, base);
  if (disruption?.availability === "unavailable") throw new DomainError("SUPPLIER_UNAVAILABLE", "The current attributed report withdraws this unit. Its supplier must record new availability before issuing another quote.");
  const previous = await client.query<{ revision: number }>("SELECT coalesce(max(revision),1)+1 AS revision FROM on_supplier_quotes WHERE tenant_id=$1 AND supplier_id=$2", [show.tenantId, supplierId]);
  const revision = previous.rows[0]!.revision; const issuedAt = (await databaseTime(client)).toISOString();
  const offer: SupplierOffer = { ...base, revision, ...(disruption?.earliestAt && compareInstants(disruption.earliestAt, base.deliveryAt) > 0 ? { deliveryAt: disruption.earliestAt } : {}) };
  const equipment = { model: "Touring LX control desk · controlled fixture unit", capabilityEvidence: "Fixture capability sheet: compatible cue-file import, touring data output and safe power configuration. Acceptance still requires the department lead's inspection.", driverEvidence: base.qualifiedDriver ? `${base.supplier} controlled qualified-driver roster` : null, conditionEvidence: base.conditionVerified ? `${base.unitId} controlled pre-dispatch condition checklist` : null };
  const cancellation = "A provisional reservation lasts ten real minutes. Authorization alone does not confirm capacity. An expired hold needs reconfirmation. An uncaptured authorization may be voided only after explicit producer approval; accepted rental fees require separate review.";
  const content = { schemaVersion: 1 as const, id: randomUUID(), tenantId: show.tenantId, supplierId, revision, issuedAt, validUntil: new Date(Date.parse(issuedAt) + QUOTE_MS).toISOString(), offer, equipment, cancellation, source: "controlled_fixture" as const };
  const quote = signSupplierQuote({ ...content, termsDigest: digest(content) });
  await client.query("INSERT INTO on_supplier_quotes(id,tenant_id,supplier_id,revision,valid_until,document) VALUES($1,$2,$3,$4,$5,$6)", [quote.id, show.tenantId, supplierId, revision, quote.validUntil, quote]);
  return quote;
}
async function hold(client: PoolClient, show: ShowSnapshot, actor: Actor, supplierId: SupplierId, action: Extract<SupplierRequest["action"], { type: "hold" }>) {
  assertProducer(actor); assertRevision(show, action.expectedRevision);
  if (show.commercialProtocol !== 2) throw new DomainError("LEGACY_RENTAL_PRESERVED", "This rehearsal retains its original rental workflow. Start a new rehearsal to exercise signed supplier holds.");
  const { plan, offer } = approvedRental(show);
  if (action.planDigest !== plan.digest || offer.supplierId !== supplierId || offer.serviceQuote?.id !== action.quoteId) throw new DomainError("QUOTE_NOT_APPROVED", "Select the exact authenticated quote reviewed in this recovery plan.");
  const stored = await client.query<{ document: SupplierQuote }>("SELECT document FROM on_supplier_quotes WHERE tenant_id=$1 AND supplier_id=$2 AND id=$3", [show.tenantId, supplierId, action.quoteId]);
  const quote = stored.rows[0]?.document; const now = await databaseTime(client);
  if (!quote || !verifySupplierQuote(quote) || quote.termsDigest !== offer.serviceQuote.termsDigest || quote.revision !== offer.revision) throw new DomainError("QUOTE_NOT_AUTHENTICATED", "The selected supplier terms cannot be authenticated.");
  const { serviceQuote: _reference, ...approvedOffer } = offer;
  if (digest(approvedOffer) !== digest(quote.offer)) throw new DomainError("QUOTE_CHANGED", "The current offer differs from the supplier's signed terms.");
  if (Date.parse(quote.validUntil) <= now.getTime() || compareInstants(show.clock, offer.expiresAt) >= 0) throw new DomainError("QUOTE_EXPIRED", "These supplier terms expired. Request new quotes and review a fresh plan.");
  if (!offer.compatible || offer.qualifiedDriver !== true || offer.conditionVerified !== true) throw new DomainError("SUPPLIER_EVIDENCE_MISSING", "Compatible equipment, a qualified driver and a condition report are all required before a hold.");
  if ((await client.query("SELECT id FROM on_rental_executions WHERE tenant_id=$1 AND plan_version=$2", [show.tenantId, show.planVersion])).rowCount) throw new DomainError("EXECUTION_ALREADY_EXISTS", "This plan already has a rental execution. Resume or reconcile its original commitment.");
  const execution: RentalExecution = { schemaVersion: 1, id: randomUUID(), planVersion: show.planVersion, planDigest: plan.digest, quoteId: quote.id, quoteDigest: quote.termsDigest, offerId: offer.id, offerRevision: offer.revision, supplierId, unitId: offer.unitId, feeMinor: offer.feeMinor, depositMinor: offer.depositMinor, deliveryAt: offer.deliveryAt, windowEnd: show.accessUntil, createdAt: now.toISOString(), updatedAt: now.toISOString(), holdExpiresAt: new Date(Math.min(now.getTime() + HOLD_MS, Date.parse(quote.validUntil))).toISOString(), state: "held", producerId: actor.id, captureConsentAt: now.toISOString(), paymentRootId: null, authorizationId: null, captureIntentId: null, compensationIntentId: null, cancellationApprovedAt: null, deliveryId: null, deliveryVersion: 0, acceptedAt: null, lastCode: null, source: "controlled_fixture" };
  await assertInventoryAvailable(client, show, execution);
  await client.query("INSERT INTO on_rental_executions(id,tenant_id,plan_version,plan_digest,quote_id,document) VALUES($1,$2,$3,$4,$5,$6)", [execution.id, show.tenantId, execution.planVersion, execution.planDigest, quote.id, execution]);
  await client.query("INSERT INTO on_resource_holds(id,tenant_id,supplier_id,unit_id,window_start,window_end,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,'provisional',$7)", [execution.id, show.tenantId, supplierId, execution.unitId, execution.deliveryAt, execution.windowEnd, execution.holdExpiresAt]);
  await saveRentalExecution(client, show, execution);
  await enqueueJob(client, { tenantId: show.tenantId, kind: "supplier_expire", semanticKey: execution.id, payload: { executionId: execution.id }, runAfter: new Date(execution.holdExpiresAt) });
  await saveSupplierSnapshot(client, show, actor.id, "supplier.hold_created", `${offer.supplier} authenticated fixture service held ${offer.unitId} for this exact plan. Buyer approval and supplier confirmation remain separate.`);
  return execution;
}
async function changeReservation(client: PoolClient, show: ShowSnapshot, actor: Actor, supplierId: SupplierId, action: Exclude<SupplierRequest["action"], { type: "quote" | "hold" }>) {
  assertRevision(show, action.expectedRevision);
  const execution = await readRentalExecution(client, show.tenantId, action.executionId);
  if (execution.supplierId !== supplierId) throw new DomainError("SUPPLIER_SCOPE_REQUIRED", "This rental belongs to another supplier.", 403);
  if (action.type === "return" || action.type === "return_rejected") assertSupplier(actor, supplierId);
  else if (!actor.roles.includes("producer")) assertSupplier(actor, supplierId);
  const disruptedReturn = action.type === "return" && execution.state === "needs_attention" && execution.lastCode === "SUPPLIER_DISRUPTION" && Boolean(execution.acceptedAt);
  if (["cancelled", "compensation_pending", "returned_unaccepted"].includes(execution.state) || execution.state === "needs_attention" && action.type !== "return_rejected" && !disruptedReturn) throw new DomainError("EXECUTION_NEEDS_REVIEW", "This rental must be reconciled before another supplier transition.");
  if (action.type === "release") {
    assertProducer(actor);
    if (execution.paymentRootId || execution.authorizationId || ["confirmed", "delivered", "accepted", "returned"].includes(execution.state)) throw new DomainError("PAYMENT_RECONCILIATION_REQUIRED", "This rental has a payment or fulfillment history. Review cancellation against its exact original authorization.");
    execution.state = "cancelled"; execution.lastCode = null;
    await client.query("UPDATE on_resource_holds SET status='released',updated_at=now() WHERE id=$1", [execution.id]);
  } else if (action.type === "return_rejected") {
    // A failed inspection never becomes an ordinary accepted return or permission to capture.
    const stored = await client.query<{ document: DeliveryReceipt }>("SELECT document FROM on_delivery_receipts WHERE tenant_id=$1 AND execution_id=$2 AND id=$3", [show.tenantId, execution.id, execution.deliveryId]);
    const rejected = stored.rows[0]?.document;
    if (execution.state !== "needs_attention" || execution.lastCode !== "DELIVERY_REJECTED" || execution.acceptedAt || execution.captureIntentId || !rejected || rejected.state !== "rejected" || rejected.version !== execution.deliveryVersion || rejected.planVersion !== execution.planVersion || rejected.planDigest !== execution.planDigest || rejected.unitId !== execution.unitId || rejected.supplierId !== supplierId) throw new DomainError("REJECTED_RETURN_REQUIRED", "Only the exact rejected, unaccepted handoff can use this return record.");
    execution.rejectedReturn = { deliveryId: rejected.id, deliveryVersion: rejected.version, recordedAt: (await databaseTime(client)).toISOString(), actorId: actor.id, detail: action.detail };
    execution.state = "returned_unaccepted"; execution.lastCode = null;
    await client.query("UPDATE on_resource_holds SET status='returned',updated_at=now() WHERE id=$1", [execution.id]);
  } else if (action.type === "return") {
    currentSupplierPlan(show, execution, true);
    if (execution.state !== "accepted" && !disruptedReturn || !execution.acceptedAt || !show.cancellationDecision && compareInstants(show.clock, atVenue("23:30")) < 0) throw new DomainError("RETURN_NOT_READY", "An accepted delivery and the scheduled return step, or an approved program cancellation, are required for this attributed inspection.");
    execution.state = "returned";
    appendSupplierFact(show, actor, "return_accepted", "Authenticated controlled supplier return inspection: " + action.detail);
    await client.query("UPDATE on_resource_holds SET status='returned',updated_at=now() WHERE id=$1", [execution.id]);
  } else {
    currentSupplierPlan(show, execution);
    const authorization = currentActual(show).find(item => item.kind === "authorization" && item.purpose === "rental" && item.providerResourceId === execution.authorizationId && item.planVersion === execution.planVersion && item.amountMinor === execution.feeMinor + execution.depositMinor);
    if (!execution.authorizationId && action.type === "reconfirm") {
      if (compareInstants(show.clock, execution.deliveryAt) > 0) throw new DomainError("DELIVERY_WINDOW_MISSED", "The original delivery window passed. Obtain a new quote and replan.");
      await assertInventoryAvailable(client, show, execution);
      const now = await databaseTime(client);
      execution.holdExpiresAt = new Date(now.getTime() + HOLD_MS).toISOString(); execution.state = execution.paymentRootId ? "awaiting_payment" : "held"; execution.lastCode = null;
      await client.query("UPDATE on_resource_holds SET status='provisional',expires_at=$2,updated_at=now() WHERE id=$1", [execution.id, execution.holdExpiresAt]);
      await saveRentalExecution(client, show, execution);
      await enqueueJob(client, { tenantId: show.tenantId, kind: "supplier_expire", semanticKey: execution.id + ":" + execution.holdExpiresAt, payload: { executionId: execution.id }, runAfter: new Date(execution.holdExpiresAt) });
      await saveSupplierSnapshot(client, show, actor.id, "supplier.hold_renewed", `Authenticated ${supplierId} fixture service renewed provisional capacity for ${execution.unitId} on the same approved terms. Payment and final reservation confirmation remain separate.`);
      return execution;
    }
    if (!authorization) throw new DomainError("AUTHORIZATION_REQUIRED", "The supplier needs the exact verified rental authorization before confirmation.");
    if (["confirmed", "delivered", "accepted", "returned"].includes(execution.state)) return execution;
    const now = await databaseTime(client);
    if (Date.parse(execution.holdExpiresAt) <= now.getTime() && action.type !== "reconfirm") throw new DomainError("HOLD_EXPIRED", "The provisional hold expired during approval. Reconfirm this exact unit or review the uncaptured authorization's cancellation.");
    if (action.type === "reconfirm" && compareInstants(show.clock, execution.deliveryAt) > 0) throw new DomainError("DELIVERY_WINDOW_MISSED", "The original delivery window has passed. Obtain a new quote and replan; money history is retained.");
    await assertInventoryAvailable(client, show, execution);
    execution.state = "confirmed"; execution.lastCode = null;
    const serviceActor: Actor = { id: "enrolled-supplier:" + supplierId, tenantId: show.tenantId, roles: ["supplier"], personId: null, supplierId };
    appendSupplierFact(show, serviceActor, "supplier_confirmed", `Authenticated ${supplierId} fixture service confirmed ${execution.unitId}, its approved delivery window and exact quoted terms${action.type === "reconfirm" ? " after reacquiring expired capacity" : ""}.`);
    await client.query("UPDATE on_resource_holds SET status='confirmed',updated_at=now() WHERE id=$1", [execution.id]);
  }
  await saveRentalExecution(client, show, execution);
  await saveSupplierSnapshot(client, show, actor.id, "supplier." + action.type, `Controlled ${supplierId} service recorded ${action.type} for ${execution.unitId}. Physical participation is not claimed.`);
  return execution;
}

/** Only the authenticated HTTP boundary invokes this enrolled fixture service. */
export async function processSupplierRequest(supplierId: SupplierId, request: SupplierRequest): Promise<SupplierResponse> {
  return supplierTransaction(async client => {
    const show = await lockSupplierShow(client, request.tenantId);
    const payloadHash = digest(request);
    const prior = await client.query<{ payload_hash: string; response: SupplierResponse }>("SELECT payload_hash,response FROM on_supplier_requests WHERE tenant_id=$1 AND supplier_id=$2 AND request_id=$3", [request.tenantId, supplierId, request.requestId]);
    if (prior.rows[0]) {
      if (prior.rows[0].payload_hash !== payloadHash) throw new DomainError("SUPPLIER_REQUEST_CONFLICT", "This supplier request identity already has different instructions.");
      return prior.rows[0].response;
    }
    const actor = await supplierActor(client, request.tenantId, request.actorId);
    let result: SupplierResult;
    if (request.action.type === "quote") { assertProducer(actor); result = { kind: "quote", quote: await issueQuote(client, show, supplierId) }; }
    else if (request.action.type === "hold") result = { kind: "execution", execution: await hold(client, show, actor, supplierId, request.action) };
    else result = { kind: "execution", execution: await changeReservation(client, show, actor, supplierId, request.action) };
    const response = signSupplierResponse(supplierId, request.requestId, result);
    await client.query("INSERT INTO on_supplier_requests(tenant_id,supplier_id,request_id,payload_hash,response) VALUES($1,$2,$3,$4,$5)", [show.tenantId, supplierId, request.requestId, payloadHash, response]);
    return response;
  });
}

export async function expireSupplierHold(tenantId: string, executionId: string): Promise<JobResult> {
  return supplierTransaction(async client => {
    const show = await lockSupplierShow(client, tenantId); const execution = await readRentalExecution(client, tenantId, executionId);
    if (!["held", "awaiting_payment", "authorized"].includes(execution.state)) return { status: "complete" };
    const now = await databaseTime(client);
    if (Date.parse(execution.holdExpiresAt) > now.getTime()) return { status: "waiting", code: "HOLD_STILL_CURRENT", delaySeconds: Math.ceil((Date.parse(execution.holdExpiresAt) - now.getTime()) / 1000) };
    execution.state = execution.authorizationId ? "reconfirmation_required" : "expired"; execution.lastCode = "HOLD_EXPIRED";
    await client.query("UPDATE on_resource_holds SET status='expired',updated_at=now() WHERE id=$1 AND status='provisional'", [executionId]);
    await saveRentalExecution(client, show, execution);
    await saveSupplierSnapshot(client, show, "supplier-expiry-worker", "supplier.hold_expired", `The real-time hold for ${execution.unitId} expired. Existing payment history is preserved; capacity is unconfirmed.`);
    return { status: "complete" };
  });
}
