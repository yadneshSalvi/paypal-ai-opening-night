import type { PoolClient } from "pg";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { SupplierQuote } from "@/domain/supplier-contracts";
import { managedSupplierIdSchema } from "@/domain/supplier-admin/commands";
import type { AdminRecord, Enrollment, InventoryEdition, ManagedSupplierId, NegotiationRound, QuoteAcceptance, ReviewedRfq, SupplierKey, SupplierMandate, TermEdition } from "@/domain/supplier-admin/contracts";
import { readAdminRecords, admitted, currentInventory, currentKey, currentTerms, recordById, requireAdminAuthority, revoked, accessCurrent } from "./store";
import { verifyManagedQuoteSignature } from "./signatures";
import { lockSupplierShow, supplierTransaction } from "../supplier-storage";
import { signSupplierResponse, type SupplierRequest, type SupplierResponse } from "../supplier-protocol";
import { sealIntelligence, openIntelligence } from "../intelligence/private-payload";

export const isManagedSupplierId = (value: string): value is ManagedSupplierId => managedSupplierIdSchema.safeParse(value).success;
export async function requireManagedEnrollment(db: Pick<PoolClient, "query">, tenantId: string, supplierId: string) {
  if (!isManagedSupplierId(supplierId)) throw new DomainError("SUPPLIER_NOT_ENROLLED", "This supplier is not enrolled.", 404);
  return admitted(await readAdminRecords(db, tenantId), supplierId);
}
/** Crypto is retained for history; only this database/source comparison admits a NEW commitment. */
export async function requireManagedQuoteCurrent(db: PoolClient, show: ShowSnapshot, actor: Actor, quote: SupplierQuote, producerAccess?: { sessionHash: string; expiresAt: string }) {
  const source = quote.adminSource;
  if (!source || !isManagedSupplierId(quote.supplierId) || source.supplierId !== quote.supplierId || quote.tenantId !== show.tenantId || !verifyManagedQuoteSignature(quote)) throw new DomainError("SUPPLIER_QUOTE_NOT_AUTHENTICATED", "This exact managed supplier quote cannot be authenticated.", 403);
  if (!producerAccess) throw new DomainError("SUPPLIER_ADMIN_REVIEW_ACCESS", "The commitment needs the producer's exact current access and original full expiry.", 403);
  await requireAdminAuthority(db, { actor, sessionHash: producerAccess.sessionHash }, producerAccess.expiresAt, "producer");
  const records = await readAdminRecords(db, show.tenantId), enrollment = admitted(records, quote.supplierId), key = currentKey(records, quote.supplierId);
  const inventory = recordById<InventoryEdition>(records, source.inventoryId, "inventory", quote.supplierId), terms = recordById<TermEdition>(records, source.termsId, "terms", quote.supplierId);
  const mandate = recordById<SupplierMandate>(records, source.supplierMandateId, "supplier_mandate", quote.supplierId), rfq = recordById<ReviewedRfq>(records, source.rfqId, "rfq", quote.supplierId), round = recordById<NegotiationRound>(records, source.roundId, "round", quote.supplierId);
  if (enrollment.id !== source.enrollmentId || key.id !== source.keyId || key.data.publicKey !== source.publicKey || key.data.fingerprint !== source.keyFingerprint || inventory.data.unitId !== quote.offer.unitId || currentInventory(records, quote.supplierId, quote.offer.unitId)?.id !== inventory.id || currentTerms(records, quote.supplierId, quote.offer.unitId)?.id !== terms.id || terms.data.inventoryId !== inventory.id || !inventory.data.available || !inventory.data.owned || !inventory.data.compatible || inventory.data.qualifiedDriver !== true || inventory.data.conditionVerified !== true || mandate.data.enrollmentId !== enrollment.id || mandate.data.keyId !== key.id || mandate.data.inventoryId !== inventory.id || mandate.data.termsId !== terms.id || rfq.data.supplierMandateId !== mandate.id || rfq.data.inventoryId !== inventory.id || rfq.data.termsId !== terms.id || rfq.data.keyId !== key.id || rfq.data.enrollmentId !== enrollment.id || revoked(records, mandate.id) || revoked(records, rfq.id) || digest(mandate) !== source.supplierMandateDigest || digest(rfq) !== source.rfqDigest || digest(inventory) !== source.inventoryDigest || digest(terms) !== source.termsDigest || mandate.access.actor.id !== enrollment.data.ownerActorId || round.data.rfqId !== rfq.id || round.data.outcome.kind !== "quote" || digest(round.data.outcome.quote) !== digest(quote)) throw new DomainError("SUPPLIER_ADMIN_SOURCE_CHANGED", "Current admission, signer, owned inventory, terms or exact negotiation source changed. Original commitments remain retained.", 409);
  const now = (await db.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.getTime();
  if ([quote.validUntil, terms.data.validUntil, mandate.data.expiresAt, rfq.data.expiresAt].some(value => Date.parse(value) <= now) || Date.parse(terms.data.scenarioDeadline) <= Date.parse(show.clock) || Date.parse(quote.offer.deliveryAt) < Date.parse(show.clock)) throw new DomainError("SUPPLIER_MANDATE_EXPIRED", "The quote or one of its original fixed mandates expired. New access cannot renew it.");
  if (rfq.access.sessionHash !== producerAccess.sessionHash || rfq.access.expiresAt !== producerAccess.expiresAt || rfq.access.actor.id !== actor.id) throw new DomainError("SUPPLIER_RFQ_OWNER", "Only the exact producer capability that reviewed this request may reserve its quote.", 403);
  if (Date.parse(inventory.data.availableUntil) < Date.parse(show.accessUntil)) throw new DomainError("SUPPLIER_INVENTORY_WINDOW", "The owned unit does not cover the full reserved production window.");
  await accessCurrent(db, enrollment.access); await accessCurrent(db, key.access); await accessCurrent(db, rfq.access); await accessCurrent(db, mandate.access); await accessCurrent(db, terms.access);
  const acceptance = records.find(record => record.kind === "acceptance" && (record.data as QuoteAcceptance).quoteId === quote.id) as AdminRecord<QuoteAcceptance> | undefined;
  const candidate = show.runs.flatMap(run => run.candidates).find(value => value.digest === show.approvedPlan?.digest);
  if (!acceptance || acceptance.data.rfqId !== rfq.id || acceptance.data.roundId !== round.id || !candidate || candidate.sourceDigest !== acceptance.data.sourceDigest || candidate.patch.offerId !== quote.offer.id || candidate.patch.offerRevision !== quote.revision) throw new DomainError("SUPPLIER_ADMIN_PLAN_SOURCE", "The separately approved actual-engine plan must use this exact admitted quote and reviewed source.");
  return { enrollment, key, inventory, terms, mandate, rfq };
}
/** The fixed same-origin transport cannot enroll an endpoint or invent a quote. */
export async function processManagedSupplierRequest(supplierId: ManagedSupplierId, request: SupplierRequest): Promise<SupplierResponse> {
  return supplierTransaction(async db => {
    const show = await lockSupplierShow(db, request.tenantId);
    if (request.action.type !== "hold") throw new DomainError("SUPPLIER_ADMIN_DESK_REQUIRED", "Use the exact managed negotiation or original reservation command desk for this supplier.", 403);
    const access = request.action.producerAccess;
    if (!access) throw new DomainError("SUPPLIER_ADMIN_REVIEW_ACCESS", "The managed supplier requires the exact original producer capability.", 403);
    const actor = (await db.query<{ actor: Actor }>("SELECT actor FROM on_sessions WHERE token_hash=$1 AND tenant_id=$2 AND actor->>'id'=$3", [access.sessionHash, request.tenantId, request.actorId])).rows[0]?.actor;
    if (!actor) throw new DomainError("SUPPLIER_ADMIN_ACCESS_ENDED", "This original producer access is unavailable.", 401);
    await requireAdminAuthority(db, { actor, sessionHash: access.sessionHash }, access.expiresAt, "producer");
    const payloadHash = digest(request), prior = (await db.query<{ payload_hash: string; response_cipher: string }>("SELECT payload_hash,response_cipher FROM on_supplier_admin_requests WHERE tenant_id=$1 AND supplier_id=$2 AND request_id=$3", [show.tenantId, supplierId, request.requestId])).rows[0];
    if (prior) {
      if (prior.payload_hash !== payloadHash) throw new DomainError("SUPPLIER_REQUEST_CONFLICT", "The original supplier request has different instructions.");
      return openIntelligence<SupplierResponse>(show.tenantId, `supplier-admin-request:${supplierId}:${request.requestId}`, prior.response_cipher);
    }
    await requireManagedEnrollment(db, show.tenantId, supplierId);
    const execution = await (await import("../supplier-service")).hold(db, show, actor, supplierId, request.action);
    await requireAdminAuthority(db, { actor, sessionHash: access.sessionHash }, access.expiresAt, "producer");
    const response = signSupplierResponse(supplierId, request.requestId, { kind: "execution", execution });
    await db.query("INSERT INTO on_supplier_admin_requests(tenant_id,supplier_id,request_id,payload_hash,response_cipher) VALUES($1,$2,$3,$4,$5)", [show.tenantId, supplierId, request.requestId, payloadHash, sealIntelligence(show.tenantId, `supplier-admin-request:${supplierId}:${request.requestId}`, response)]);
    return response;
  });
}
