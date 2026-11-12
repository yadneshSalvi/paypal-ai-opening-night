import type { Actor } from "@/domain/contracts";
import type { SupplierId } from "@/domain/supplier-contracts";
import type { SupplierRecoveryEnvelope, SupplierRfqOutcome, SupplierTermInput, SupplierTermRef } from "@/domain/supplier-recovery";
export type { SupplierRecoveryEnvelope, SupplierRecoveryCommand } from "@/domain/supplier-recovery";
export interface SupplierRecoveryAuthority { actor: Actor; sessionHash: string }
export interface SupplierRecoveryReceipt { commandId: string; action: SupplierRecoveryEnvelope["command"]["type"]; requestDigest: string; recordId: string; revision: number; at: string; message: string }
export interface RetainedRentalSummary {
  id: string; supplierId: SupplierId; supplier: string; unitId: string; originalPlanVersion: number; state: string;
  feeMinor: number; depositMinor: number; verifiedFeeMinor: number; feeInstructionPending: boolean; accepted: boolean; current: boolean;
}
export interface SupplierTermsCard {
  supplierId: SupplierId; supplier: string; offerId: string; unitId: string;
  feeMinor: number; depositMinor: number; deliveryAt: string; scenarioDeadline: string;
  reference: SupplierTermRef | null; input: SupplierTermInput | null; actorLabel: string | null; scenarioAt: string | null;
  report: { id: string; availability: "delayed" | "unavailable" | "available"; earliestAt: string | null; reference: string } | null;
  usable: boolean; blockers: string[]; inventoryCommitted: boolean;
}
export interface SupplierRecoveryPreview {
  revision: number; digest: string; ready: boolean; blockers: string[]; retained: RetainedRentalSummary[];
  supplierTerms: { supplierId: SupplierId; termsId: string | null; termsDigest: string | null; sourceReportId: string | null }[];
  disruptionDigest: string; currentPlanVersion: number; replacesApprovedPlan: boolean; program: "full" | "support_only" | "cancelled";
}
export interface RecoveryRfqRecord {
  id: string; tenantId: string; actor: Actor; sessionHash: string; sessionExpiresAt: string; expiresAt: string; approvedAt: string;
  reviewedRevision: number; expectedRevision: number; previewDigest: string; basisDigest: string; detail: string;
  requestIds: Record<SupplierId, string>; terms: SupplierRecoveryPreview["supplierTerms"]; retained: RetainedRentalSummary[];
}
export interface SupplierRecoveryWorkspace {
  tenantId: string; actorId: string; sessionFingerprint: string; expiresAt: string; serverAt: string; revision: number; clock: string; accessUntil: string;
  access: "producer" | "operator" | "supplier"; supplierId: SupplierId | null; cards: SupplierTermsCard[];
  preview: SupplierRecoveryPreview | null; history: SupplierRecoveryReceipt[];
  requests: { id: string; status: "collecting" | "applied" | "needs_review"; lastCode: string | null; outcomes: SupplierRfqOutcome[]; sessionMatches: boolean; expiresAt: string | null; createdAt: string }[];
}
export interface SupplierInvitation { url: string; supplierId: SupplierId; expiresAt: string }
export interface SupplierRecoveryResult { workspace: SupplierRecoveryWorkspace; receipt: SupplierRecoveryReceipt; replayed: boolean; invitation?: SupplierInvitation | undefined }
