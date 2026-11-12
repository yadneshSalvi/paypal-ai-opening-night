import type { Actor, ShowSnapshot } from "@/domain/contracts";
import type { CancellationDecision, CancellationTarget, DisruptionAssessment, DisruptionEnvelope, DisruptionMode, SupplierDisruption } from "@/domain/disruptions";
export type { CancellationDecision, DisruptionAssessment, DisruptionCommand, DisruptionEnvelope, DisruptionMode, SupplierDisruption } from "@/domain/disruptions";
export interface DisruptionAuthority { actor: Actor; sessionHash: string }
export interface EventRemedyAllocation {
  id: string; tenantId: string; decisionId: string; ticketId: string; tier: "standard" | "vip";
  rootIntentId: string; orderId: string; captureId: string; captureMinor: number;
  admissionMinor: number; perkMinor: number; amountMinor: number;
  priorRefunds: { id: string; amountMinor: number }[];
}
export interface CancellationRecord {
  decision: CancellationDecision; tenantId: string; sessionHash: string; actor: Actor;
  planVersion: number; planDigest: string | null; allocationDigest: string;
}
export interface RemedyProgress { intentId: string | null; lastCode: string | null; dispatchAuthorizedAt: string | null }
export interface CancellationPreview {
  digest: string; revision: number; mode: DisruptionMode; admissionRefundMinor: number; ready: boolean;
  capturedTickets: number; admissionMinor: number; perkMinor: number; newRefundMinor: number;
  alreadyRefundedMinor: number; preservedAdmissionMinor: number; blockers: string[];
  lines: { ticketId: string; tier: "standard" | "vip"; captureReference: string; priorRefundMinor: number; admissionMinor: number; perkMinor: number; amountMinor: number }[];
  obligations: { label: string; detail: string; amountMinor: number | null; href: string }[];
}
export interface PreparedCancellation { preview: CancellationPreview; items: Omit<EventRemedyAllocation, "id" | "decisionId">[]; targets: CancellationTarget[] }
export interface DisruptionReceipt { commandId: string; action: DisruptionEnvelope["command"]["type"]; requestDigest: string; recordId: string | null; revision: number; message: string; at: string }
export interface PublicEventRemedy {
  id: string; ticketId: string; tier: "standard" | "vip"; captureReference: string; amountMinor: number; admissionMinor: number; perkMinor: number;
  state: "queued" | "prepared" | "pending" | "complete" | "needs_attention" | "stopped"; code: string | null; refundReference: string | null; canRetry: boolean;
}
export interface DisruptionWorkspace {
  tenantId: string; revision: number; actorId: string; sessionFingerprint: string; access: "producer" | "operator" | "supplier"; expiresAt: string;
  clock: string; providerActionsEnabled: boolean;
  offers: { id: string; revision: number; supplierId: string; supplier: string; unitId: string; deliveryAt: string; executionId: string | null; executionState: string | null }[];
  reports: SupplierDisruption[]; assessments: DisruptionAssessment[]; assessmentIsCurrent: boolean; decision: CancellationDecision | null;
  remedies: PublicEventRemedy[]; historicalDecisions: { id: string; mode: DisruptionMode; approvedAt: string; newRefundMinor: number; stopped: boolean }[];
  rentalCommitments: { id: string; supplier: string; unitId: string; state: string; authorizationMinor: number; capturedMinor: number; canCancel: boolean; blocker: string | null }[];
  obligations: CancellationPreview["obligations"];
}
export interface DisruptionResult { workspace: DisruptionWorkspace; receipt: DisruptionReceipt; replayed: boolean }
export type DisruptionShow = ShowSnapshot;
