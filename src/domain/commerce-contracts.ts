/** Local identities and public commerce projections. Provider token/customer IDs never enter these DTOs. */
export const ticketCohort = { standard: 42, vip: 38, count: 80, standardMinor: 3500, vipMinor: 5000, grossMinor: 337000, remedyMinor: 1500, remedyTotalMinor: 57000, currency: "USD" } as const;
export type TicketTier = "standard" | "vip";
export type CohortMode = "saved_wallet" | "buyer_present";
export type CohortState = "draft" | "approved" | "paused" | "revoked" | "expired" | "complete";
export type CommerceLineState = "waiting" | "queued" | "creating" | "approval_required" | "capturing" | "captured" | "refunding" | "refunded" | "pending" | "refused" | "stopped" | "needs_attention";

export interface CohortTerms {
  version: 1; seller: "venue"; currency: "USD"; showId: string; mode: CohortMode; walletId: string | null;
  standardCount: 42; vipCount: 38; maximumTickets: 80; maximumMinor: 337000;
  admissionMinor: 3500; perkMinor: 1500; purpose: "controlled_sandbox_ticket_cohort";
}
export interface PublicWallet {
  id: string; status: "preparing" | "approval_required" | "saving" | "ready" | "pending_reconciliation" | "refused" | "cancelled" | "expired" | "needs_attention";
  approvalUrl: string | null; walletId: string | null; reference: string | null;
  createdAt: string; expiresAt: string; checkedAt: string | null; lastCode: string | null;
  canRetry: boolean;
}
export interface PublicCommerceLine {
  id: string; ordinal: number; tier: TicketTier; amountMinor: number; state: CommerceLineState;
  intentId: string | null; captureReference: string | null; refundReference: string | null;
  approvalUrl: string | null; lastCode: string | null;
}
export interface PublicCohort {
  id: string; state: CohortState; terms: CohortTerms; digest: string; version: number;
  approvedAt: string | null; expiresAt: string | null; revokedAt: string | null;
  pauseCode: string | null; pauseTicketId: string | null; capturedCount: number; capturedMinor: number; reservedCount: number;
  unresolvedCount: number; currentVerifiedCount: number; captureReviewCount: number; lines: PublicCommerceLine[];
}
export interface PublicRemedyPreview {
  digest: string; planVersion: number; eligibleCount: number; requiredCount: 38; amountMinor: number;
  completedCount: number; newAmountMinor: number; ready: boolean; reason: string; captureReferences: string[];
}
export interface PublicRemedyBatch {
  id: string; state: Exclude<CohortState, "draft">; digest: string; planVersion: number;
  approvedAt: string; expiresAt: string; pauseCode: string | null;
  completedCount: number; refundedMinor: number; preservedAdmissionMinor: number; lines: PublicCommerceLine[];
}
export interface CommerceOverview {
  wallet: PublicWallet | null; cohort: PublicCohort | null;
  remedyPreview: PublicRemedyPreview; remedyBatch: PublicRemedyBatch | null; serverAt: string;
}
