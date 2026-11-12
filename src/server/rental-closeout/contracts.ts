import type { Actor } from "@/domain/contracts";
import type { PaymentIntent } from "@/domain/payment-authority";
import type { RentalExecution } from "@/domain/supplier-contracts";
import type { CloseoutEnvelope, RentalCloseoutGrant, RentalReturnRecord, ReturnCondition } from "@/domain/rental-closeout";
export type { CloseoutEnvelope, CloseoutCommand, RentalCloseoutGrant, RentalReturnRecord, ReturnCondition } from "@/domain/rental-closeout";
export interface CloseoutAuthority { actor: Actor; sessionHash: string }
export interface CloseoutReceipt { commandId: string; action: CloseoutEnvelope["command"]["type"]; requestDigest: string; recordId: string; revision: number; at: string; message: string }
export interface CloseoutProgress { intentId: string | null; lastCode: string | null; dispatchAuthorizedAt: string | null }
export interface PublicReturn {
  id: string; previousId: string | null; condition: ReturnCondition; detail: string; actorLabel: string;
  observedAt: string; recordedAt: string; fixtureAt: string; planVersion: number;
  source: RentalReturnRecord["source"]; current: boolean;
}
export interface PublicCloseout {
  id: string; intentId: string | null; state: "queued" | "prepared" | "pending" | "complete" | "needs_attention" | "stopped";
  code: string | null; approvedAt: string; expiresAt: string; stoppedAt: string | null; historical: boolean;
  canRetry: boolean; canStop: boolean; sessionMatches: boolean; residualMinor: number;
}
export interface RentalCloseoutCard {
  id: string; executionDigest: string; supplierId: RentalExecution["supplierId"]; supplier: string; unitId: string;
  originalPlanVersion: number; currentPlan: boolean; state: RentalExecution["state"];
  acceptedAt: string | null; originalDeliveryAt: string; feeMinor: number; depositMinor: number;
  verifiedFeeMinor: number; historicalFeeMinor: number; releasedMinor: number; historicalReleasedMinor: number; feeReference: string | null; authorizationReference: string | null;
  originalFeeIntentId: string | null; originalFeeState: string | null;
  canRecordReturn: boolean; returnBlocker: string | null; latestReturnId: string | null; returns: PublicReturn[];
  canReviewClosure: boolean; closureBlockers: string[]; closeout: PublicCloseout | null;
  evidenceBoundary: "controlled_fixture" | "sandbox_with_controlled_supplier";
}
export interface CloseoutPreview {
  executionId: string; executionDigest: string; revision: number; digest: string; ready: boolean;
  supplier: string; unitId: string; originalPlanVersion: number; currentPlan: boolean;
  authorizationMinor: number; acceptedFeeMinor: number; residualMinor: number;
  orderReference: string | null; authorizationReference: string | null; captureReference: string | null;
  returnId: string | null; returnCondition: ReturnCondition | null; blockers: string[];
  existingIntentId: string | null; providerActionsEnabled: boolean;
}
export interface CloseoutWorkspace {
  tenantId: string; actorId: string; sessionFingerprint: string; expiresAt: string; revision: number; clock: string;
  access: "producer" | "operator" | "supplier"; supplierId: RentalExecution["supplierId"] | null;
  providerActionsEnabled: boolean; rentals: RentalCloseoutCard[]; history: CloseoutReceipt[];
}
export interface CloseoutResult { workspace: CloseoutWorkspace; receipt: CloseoutReceipt; replayed: boolean }
export interface PreparedCloseout { preview: CloseoutPreview; execution: RentalExecution; grant: Omit<RentalCloseoutGrant, "id" | "actor" | "sessionHash" | "approvedAt" | "expiresAt" | "detail"> | null; existingIntent: PaymentIntent | null }
