import type { Actor, ShowSnapshot } from "./contracts";
import type { SupplierId } from "./supplier-contracts";
import { digest } from "./hash";
import { disruptionDigest } from "./disruptions";

export { supplierRecoveryCommandSchema, supplierRecoveryEnvelopeSchema } from "./supplier-recovery-command";
export type { SupplierRecoveryCommand, SupplierRecoveryEnvelope, SupplierTermInput } from "./supplier-recovery-command";
import type { SupplierTermInput } from "./supplier-recovery-command";

export interface SupplierTermRef {
  id: string; digest: string; supplierId: SupplierId; revision: number; publishedAt: string; validUntil: string;
  sourceReportId: string | null; source: "controlled_supplier_terms";
}
export interface SupplierTermsRecord {
  id: string; tenantId: string; supplierId: SupplierId; unitId: string; revision: number;
  input: SupplierTermInput; actor: Actor; sessionHash: string; sessionExpiresAt: string;
  publishedAt: string; validUntil: string; scenarioAt: string; source: "controlled_supplier_terms";
}
export const supplierDeclineCodes = ["UNIT_UNAVAILABLE", "FRESH_TERMS_REQUIRED", "TERMS_CHANGED", "TERMS_EXPIRED", "TERMS_ACCESS_ENDED", "TERMS_REPORT_CHANGED", "UNIT_ALREADY_COMMITTED"] as const;
export type SupplierDeclineCode = typeof supplierDeclineCodes[number];
export interface SupplierDecline {
  id: string; tenantId: string; supplierId: SupplierId; offerId: string; unitId: string;
  code: SupplierDeclineCode; message: string; reportId: string | null; termsId: string | null;
  recordedAt: string; source: "authenticated_fixture_service";
}
export type SupplierRfqOutcome = { supplierId: SupplierId; kind: "quote"; quoteId: string } | { supplierId: SupplierId; kind: "declined"; decline: SupplierDecline };

/** These are the inputs a producer actually reviews. Work and money stay on their original identities. */
export function supplierRecoveryBasis(show: ShowSnapshot) {
  return digest({ revision: show.revision, clock: show.clock, planVersion: show.planVersion, approvedPlan: show.approvedPlan,
    disruptionDigest: disruptionDigest(show), terms: show.supplierTermRevisions ?? [], offers: show.offers,
    rentals: show.rentalExecutions ?? [], financialEvidence: show.financialEvidence,
    cancellation: show.cancellationDecision ?? null });
}
