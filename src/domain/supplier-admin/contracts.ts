import type { Actor, SupplierOffer } from "../contracts";
import type { SupplierQuote } from "../supplier-contracts";

export type ManagedSupplierId = `enrolled-${string}`;
export type AdminKind = "enrollment" | "key" | "inventory" | "terms" | "supplier_mandate" | "rfq" | "round" | "acceptance" | "revocation";
export interface AdminAuthority { actor: Actor; sessionHash: string }
export interface AdminAccess { actor: Actor; sessionHash: string; expiresAt: string }
export interface AdminRecord<T = unknown> {
  id: string; tenantId: string; supplierId: ManagedSupplierId; kind: AdminKind; revision: number;
  createdAt: string; access: AdminAccess; data: T; provenance: "declared_controlled_supplier";
}
export interface Enrollment {
  name: string; reference: string; detail: string; ownerActorId: string; ownerFingerprint: string; ownerExpiresAt: string;
  status: "invited" | "admitted" | "revoked"; previousId: string | null;
  merchant: { state: "unconfigured"; message: string };
}
export interface SupplierKey { publicKey: string; previousId: string | null; algorithm: "Ed25519"; fingerprint: string }
export interface InventoryEdition {
  previousId: string | null; unitId: string; label: string; model: string; owned: true; available: boolean;
  availableFrom: string; availableUntil: string; compatible: boolean; qualifiedDriver: boolean | null; conditionVerified: boolean | null;
  capabilityEvidence: string; driverEvidence: string | null; conditionEvidence: string | null; reference: string; detail: string;
}
export interface TermEdition {
  previousId: string | null; inventoryId: string; feeMinor: number; depositMinor: number;
  earliestDelivery: string; latestDelivery: string; scenarioDeadline: string; validUntil: string;
  cancellation: string; reference: string; detail: string;
}
export interface NegotiationBounds {
  feeMinMinor: number; feeMaxMinor: number; depositMinMinor: number; depositMaxMinor: number;
  earliestDelivery: string; latestDelivery: string; maxRounds: number;
}
export interface SupplierMandate {
  enrollmentId: string; keyId: string; inventoryId: string; termsId: string;
  bounds: NegotiationBounds; expiresAt: string; detail: string;
}
export interface ReviewedRfq {
  enrollmentId: string; supplierMandateId: string; inventoryId: string; termsId: string; keyId: string;
  bounds: NegotiationBounds; sourceDigest: string; reviewedRevision: number; expiresAt: string; detail: string;
}
export interface AdminQuoteSource {
  supplierId: ManagedSupplierId; enrollmentId: string; inventoryId: string; termsId: string; keyId: string;
  supplierMandateId: string; rfqId: string; roundId: string; publicKey: string; keyFingerprint: string;
  supplierMandateDigest: string; rfqDigest: string; inventoryDigest: string; termsDigest: string;
  source: "declared_controlled_supplier";
}
export interface NegotiationDecline {
  id: string; tenantId: string; supplierId: ManagedSupplierId; rfqId: string; round: number;
  code: "BOUNDS_DO_NOT_OVERLAP" | "UNIT_UNAVAILABLE" | "UNIT_ALREADY_COMMITTED" | "EVIDENCE_MISSING";
  message: string; at: string; source: AdminQuoteSource; signature: string;
}
export interface NegotiationRound {
  rfqId: string; round: number; request: { feeMinor: number; depositMinor: number; deliveryAt: string };
  outcome: { kind: "quote"; quote: SupplierQuote } | { kind: "declined"; decline: NegotiationDecline };
}
export interface QuoteAcceptance { quoteId: string; rfqId: string; roundId: string; sourceDigest: string }
export interface Revocation { targetId: string; reason: string; targetKind: "enrollment" | "key" | "supplier_mandate" | "rfq" }
export interface AdminReceipt {
  commandId: string; action: string; requestDigest: string; recordId: string; revision: number;
  at: string; status: "completed" | "refused"; code: string | null; message: string;
}
export interface SupplierAdminCard {
  id: ManagedSupplierId; name: string; status: "invited" | "admitted" | "revoked" | "expired";
  enrollmentId: string; enrollment: Enrollment; key: (SupplierKey & { id: string; revision: number; active: boolean }) | null;
  keyHistory: { id: string; fingerprint: string; revision: number; status: "active" | "retired" | "revoked" }[];
  inventory: (InventoryEdition & { id: string; revision: number }) | null;
  terms: (TermEdition & { id: string; revision: number }) | null;
  units: { inventory: InventoryEdition & { id: string; revision: number }; terms: (TermEdition & { id: string; revision: number }) | null }[];
  mandates: { id: string; data: SupplierMandate; active: boolean; status: string }[];
  rfqs: { id: string; data: ReviewedRfq; status: string; roundLimit: number; rounds: { id: string; data: NegotiationRound; verified: boolean; accepted: boolean }[] }[];
  blockers: string[]; retained: { id: string; unitId: string; planVersion: number; state: string; feeMinor: number; depositMinor: number }[];
}
export interface AdminWorkspace {
  tenantId: string; actorId: string; sessionFingerprint: string; expiresAt: string; serverAt: string;
  revision: number; clock: string; accessUntil: string; role: "producer" | "supplier"; supplierId: string | null;
  reviewDigest: string; cards: SupplierAdminCard[]; history: AdminReceipt[];
  originalServices: Pick<SupplierOffer, "supplierId" | "supplier" | "unitId" | "feeMinor" | "depositMinor">[];
  currentPlan: { digest: string; offerId: string; planVersion: number; quoteId: string | null } | null;
}
export interface AdminResult { workspace: AdminWorkspace; receipt: AdminReceipt; replayed: boolean; invitation?: { url: string; expiresAt: string; supplierId: ManagedSupplierId } }
