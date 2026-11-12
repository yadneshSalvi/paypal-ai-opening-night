import type { PoolClient } from "pg";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { SupplierQuote } from "@/domain/supplier-contracts";
import { verifySupplierQuote } from "../supplier-protocol";
import { readSupplierTerms, supplierTermsBlocker } from "./store";

/** A fresh supplier edition must remain current when the separate plan approval commits. */
export async function requireSupplierTermsForApproval(db: PoolClient, show: ShowSnapshot, candidateId: string) {
  const candidate = show.runs.at(-1)?.candidates.find(item => item.id === candidateId);
  const offer = show.offers.find(item => item.id === candidate?.patch.offerId);
  if (!offer || !offer.serviceQuote?.termsSource && !show.supplierTermRevisions?.some(item => item.supplierId === offer.supplierId)) return;
  const reference = offer.serviceQuote;
  if (!reference?.termsSource) throw new DomainError("SUPPLIER_TERMS_CHANGED", "The proposal does not use this supplier's current attributed terms.");
  const quote = (await db.query<{ document: SupplierQuote }>("SELECT document FROM on_supplier_quotes WHERE tenant_id=$1 AND id=$2 AND supplier_id=$3", [show.tenantId, reference.id, offer.supplierId])).rows[0]?.document;
  const { serviceQuote: _source, ...offered } = offer;
  if (!quote || !quote.termsSource || !verifySupplierQuote(quote) || quote.termsDigest !== reference.termsDigest || digest(quote.offer) !== digest(offered) || digest(quote.termsSource) !== digest(reference.termsSource)) throw new DomainError("SUPPLIER_TERMS_INTEGRITY", "The exact current supplier quote cannot be authenticated.", 503);
  const now = (await db.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
  if (Date.parse(quote.validUntil) <= now.getTime()) throw new DomainError("QUOTE_EXPIRED", "The reviewed quote expired before approval. Obtain and validate a fresh quote.");
  const source = await readSupplierTerms(db, show.tenantId, reference.termsSource.id);
  const blocker = await supplierTermsBlocker(db, show, source.record, source.digest);
  if (source.digest !== reference.termsSource.digest || source.record.supplierId !== offer.supplierId || source.record.unitId !== offer.unitId || blocker) throw new DomainError("SUPPLIER_TERMS_CHANGED", blocker?.message ?? "The proposal's original supplier source changed.");
}
