/** Canonical Opening Night contract v1. Browser views are projections, never authority. */
import type { RentalExecution, SupplierId, SupplierQuoteRef } from "./supplier-contracts";
import type { CrewAdoption, CrewAttestation, CrewCueExecution, CrewNextCall, CrewProductionOverview } from "./crew/contracts";
import type { CancellationDecision, DisruptionAssessment, SupplierDisruption } from "./disruptions";
import type { RentalCloseoutCheck } from "./rental-closeout";
import type { SupplierTermRef } from "./supplier-recovery";
import type { ProductionInputState } from "./production-inputs/contracts";
export type Provenance = "sample" | "modelled" | "live_sandbox" | "replay";
export type Role = "producer" | "stage_manager" | "department_lead" | "foh" | "crew" | "supplier" | "driver";
export type Lane = "lighting" | "audio" | "stage" | "people" | "commercial" | "house";
export type CueScope = "DOORS" | "SUPPORT_START" | "HEADLINER_START";
export type TaskState = "planned" | "blocked" | "complete";
export interface EvidenceRef { id: string; title: string; source: Provenance; detail: string; recordedAt: string }
export interface Task {
  id: string; name: string; lane: Lane; start: string; end: string; durationMinutes: number;
  baselineStart: string; baselineEnd: string; resources: string[]; requiredSkill: string | null;
  state: TaskState; critical: boolean; affected: boolean; milestone: string | null; sourceId: string;
  /** Source-reviewed planning constraints survive later recovery proposals. They establish no physical completion. */
  sourceConstraints?: { amplified: boolean; earliestStart: string | null; latestEnd: string | null; compilationId: string };
  cancellation?: { decisionId: string; reason: string };
}
export interface Dependency { id: string; from: string; to: string; lagMinutes: number; financial: boolean }
export interface Resource {
  id: string; name: string; role: string; initials: string; kind: "person" | "equipment" | "space";
  department: Lane; skills: string[]; critical: boolean; reserve: boolean; color: string;
  availableFrom: string; availableUntil: string; rateMinor: number;
}
export interface Incident {
  id: string; kind: "flight" | "console" | "supplier_delay"; title: string; summary: string;
  receivedAt: string; sourceZone: string; sourceText: string; earliestAvailable: string;
  resourceIds: string[]; affectedTaskIds: string[]; confirmed: boolean; source: Provenance;
}
export interface SupplierOffer {
  id: string; supplierId: string; supplier: string; initials: string; unitId: string; revision: number;
  feeMinor: number; depositMinor: number; deliveryAt: string; expiresAt: string;
  compatible: boolean; qualifiedDriver: boolean | null; conditionVerified: boolean | null;
  terms: string; source: Provenance; status: "quoted" | "provisional" | "confirmed" | "expired";
  serviceQuote?: SupplierQuoteRef;
}
export type ConstraintStage = "schema" | "graph" | "temporal" | "semantic" | "evidence" | "authority";
export interface ConstraintIssue {
  code: string; stage: ConstraintStage; severity: "hard" | "unknown" | "approval";
  message: string; resourceId: string | null; taskId: string | null; sourceId: string;
}
export interface ApprovalRequirement { id: string; label: string; role: Role | "artist_representative"; grantedBy: string | null }
export interface EngineReport {
  engine: "bryntum-gantt-enterprise"; version: "8.0.0"; status: "passed" | "rejected" | "unavailable";
  computedAt: string; durationMs: number; inputDigest: string; reason: string | null;
  dates: { id: string; start: string; end: string }[];
}
export interface ConstraintReport {
  status: "feasible" | "feasible_with_approval" | "infeasible" | "unknown_pending_evidence";
  issues: ConstraintIssue[]; rulesChecked: string[]; engine: EngineReport | null;
}
export interface PlanPatch {
  baseRevision: number; offerId: string; offerRevision: number; policyVersion: number;
  programMode?: "support_only";
  tasks: Task[]; dependencies: Dependency[]; doorsAt: string; supportAt: string; headlinerAt: string;
  crewFinishAt: string; overtimeMinor: number; canceledPerk: boolean; changedPeople: string[];
}
export interface Candidate {
  strategy?: import("./planning-workbench/strategies").StrategyProvenance;
  id: string; family: "doors" | "budget" | "artist" | "direct"; name: string; summary: string;
  digest: string; sourceDigest: string; generatedAt: string; patch: PlanPatch; approvals: ApprovalRequirement[];
  report: ConstraintReport; cost: { rentalMinor: number; overtimeMinor: number; remedyMinor: number; totalMinor: number };
}
export interface RescueRun { id: string; baseRevision: number; createdAt: string; completedAt: string; candidates: Candidate[]; source: "modelled"; strategySource: "deterministic_enumerator" | "model_assisted_proposal" }
export interface PublishedRunSheet {
  id: string; version: number; planRevision: number; candidateId: string | null; digest: string;
  publishedAt: string; tasks: Task[]; changes: { taskId: string; name: string; before: string; after: string; reason: string; resourceIds: string[] }[];
  operatingDigest?: string;
  productionInputDigest?: string;
  tourAssignmentDigest?: string;
}
export interface Acknowledgment { id: string; personId: string; sheetVersion: number; sheetDigest: string; receivedAt: string; source: "controlled_client"; offline: boolean; actorId?: string; commandId?: string; seenTaskIds?: string[] }
export interface FinancialEvidence {
  id: string; operationId: string; kind: "authorization" | "capture" | "refund" | "void" | "payout";
  purpose: "rental" | "ticket" | "vip_remedy" | "event_remedy" | "deposit" | "rental_cancel" | "crew"; status: "pending" | "completed" | "failed";
  amountMinor: number; currency: "USD"; source: Provenance; verified: boolean; planVersion: number;
  providerResourceId: string; parentId: string | null; ticketId: string | null; recordedAt: string;
  allocation?: { decisionId: string; admissionMinor: number; perkMinor: number };
  rentalCloseoutId?: string;
}
export interface FinancialObservation {
  id: string; seller: "venue" | "brightline"; kind: "order" | "authorization" | "capture" | "refund" | "payout";
  providerResourceId: string; status: string; amountMinor: number | null; currency: string | null;
  parentId: string | null; observedAt: string; transport: "paypal_https" | "local_fixture"; refundedMinor?: number | null; readRevision?: number;
}
export interface FinancialCheck {
  id: string; seller: "venue" | "brightline"; eventType: string; resources: { kind: string; id: string }[];
  status: "pending" | "resolved"; receivedAt: string; revision: number; resolvedAt: string | null;
  transport: "paypal_https" | "local_fixture";
}
export interface Ticket {
  id: string; tier: "standard" | "vip"; admissionMinor: number; perkMinor: number; captureId: string | null;
  source: Provenance; refundedMinor: number; status: "reserved" | "captured" | "partially_refunded" | "refunded";
}
export interface OperationalFact {
  id: string; kind: "supplier_confirmed" | "delivery_accepted" | "return_accepted" | "focus_signed_off" | "cue_signed_off" | "foh_contingency" | "support_checkin" | "support_ready" | "headliner_checkin" | "quiet_prep" | "changeover";
  planVersion: number; actorId: string; role: Role; recordedAt: string; fixtureAt: string; source: Provenance; detail: string;
}
export interface ReadinessGate { id: string; label: string; complete: boolean; value: string; reason: string; evidenceIds: string[]; href: string }
export interface ReadinessReport { id: string; revision: number; sheetVersion: number; scope: CueScope; ready: boolean; gates: ReadinessGate[]; blockers: string[]; computedAt: string }
export interface DomainEvent { id: string; type: string; message: string; at: string; fixtureAt: string; actorId: string; source: Provenance; revision: number }
export interface ExternalPlanApproval {
  requestId: string; receiptId: string; receiptDigest: string; requirementId: string; role: "artist_representative";
  reviewerId: string; declaredName: string; candidateDigest: string; sourceDigest: string; baseRevision: number;
  approvedAt: string; expiresAt: string; provenance: "controlled_declaration" | "invited_declaration";
}
/** Supplied only after the server verifies the original immutable consent and current issuer. */
export interface VerifiedPlanConsent extends ExternalPlanApproval { issuerActorId: string }
export interface ApprovedPlan { candidateId: string; digest: string; approvedAt: string; actorId: string; commercialCapMinor: number; roles: string[]; baseRevision: number; externalApprovals?: ExternalPlanApproval[] }
export interface ShowSnapshot {
  schemaVersion: 1; id: string; tenantId: string; revision: number; planVersion: number; title: string; support: string; venue: string;
  zone: "America/Chicago"; showDate: string; clock: string; createdAt: string; updatedAt: string;
  doorsAt: string; curfewAt: string; accessUntil: string; nextCallAt: string;
  state: "standby" | "go" | "house_open"; policy: { version: number; minimumRestMinutes: number; maxShiftMinutes: number; refundCount: 38; criticalCrewCount: number };
  tasks: Task[]; dependencies: Dependency[]; resources: Resource[]; offers: SupplierOffer[]; incidents: Incident[];
  runs: RescueRun[]; approvedPlan: ApprovedPlan | null; sheets: PublishedRunSheet[]; acknowledgments: Acknowledgment[];
  financialEvidence: FinancialEvidence[]; tickets: Ticket[]; facts: OperationalFact[]; sources: EvidenceRef[]; events: DomainEvent[];
  financialObservations?: FinancialObservation[];
  financialChecks?: FinancialCheck[];
  commercialProtocol?: 2;
  rentalExecutions?: RentalExecution[];
  rentalCloseoutChecks?: RentalCloseoutCheck[];
  crewProtocol?: 1;
  crewAdoption?: CrewAdoption;
  crewAttestations?: CrewAttestation[];
  crewCues?: CrewCueExecution[];
  crewNextCalls?: CrewNextCall[];
  /** Private settlement records stay outside the operational snapshot. This marker protects their history. */
  settlementVersion?: number;
  /** Private recipient and payout records remain in the encrypted payout ledger. */
  payoutVersion?: number;
  /** Attributed account entries, invoice instructions and report editions have immutable private history. */
  wrapVersion?: number;
  supplierDisruptions?: SupplierDisruption[];
  supplierTermRevisions?: SupplierTermRef[];
  disruptionAssessments?: DisruptionAssessment[];
  cancellationDecision?: CancellationDecision;
  productionInputs?: ProductionInputState;
  tourAssignments?: import("./planning-workbench/tour-admission").TourAssignmentState;
  goReportId: string | null;
}
export interface Actor { id: string; tenantId: string; roles: Role[]; personId: string | null; supplierId?: SupplierId; executionId?: string }
export interface ConsoleData { show: ShowSnapshot; readiness: ReadinessReport[]; currentActor: Actor; serverAt: string; crew?: CrewProductionOverview; controlledQa?: boolean; controlledPlanningQa?: boolean }
export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); this.name = "DomainError"; }
}
