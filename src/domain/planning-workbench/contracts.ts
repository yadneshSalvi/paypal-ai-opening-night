import { z } from "zod";
import type { Candidate, ConstraintIssue, EngineReport, Task } from "../contracts";
import { inputScopeSchema, type InputScope } from "../production-inputs/contracts";
import type { PlannedProduction, ProductionTemplate, Tour, TourReport } from "../tour/contracts";
import { strategyRequestSchema, assignmentMapSchema, type StrategyRequest, type AssignmentMap } from "./options";
import type { strategyMetrics } from "./strategies";
import type { TourAssignmentState } from "./tour-admission";
import type { learningProposal } from "./learning";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const workbenchCommandSchema = z.discriminatedUnion("type", [
 z.strictObject({ type: z.literal("strategies.preview"), request: strategyRequestSchema }),
 z.strictObject({ type: z.literal("strategies.admit"), reviewId: z.uuid(), reviewDigest: hash, reviewed: z.literal(true) }),
 z.strictObject({ type: z.literal("tour.preview"), tourId: z.uuid(), productionId: z.uuid(), tourDigest: hash, productionDigest: hash, mapping: assignmentMapSchema }),
 z.strictObject({ type: z.literal("tour.admit"), reviewId: z.uuid(), reviewDigest: hash, acceptedFindingIds: z.array(z.string().min(1).max(100)).max(1000), assignmentsReviewed: z.literal(true), publicationRequired: z.literal(true) }),
 z.strictObject({ type: z.literal("learning.preview"), productions: z.array(z.strictObject({ id: z.uuid(), digest: hash })).min(1).max(8), name: z.string().trim().min(3).max(160) }),
 z.strictObject({ type: z.literal("learning.admit"), reviewId: z.uuid(), reviewDigest: hash, requirementsReviewed: z.literal(true), noAuthorityInherited: z.literal(true) }),
]);
export type WorkbenchCommand = z.infer<typeof workbenchCommandSchema>;
export const workbenchEnvelopeSchema = z.strictObject({ version: z.literal(1), commandId: z.uuid(), scope: inputScopeSchema, expectedRevision: z.number().int().positive(), command: workbenchCommandSchema });
export type WorkbenchEnvelope = z.infer<typeof workbenchEnvelopeSchema>;
export type ReviewContent =
 | { kind: "strategies"; request: StrategyRequest; candidates: Candidate[]; metrics: ReturnType<typeof strategyMetrics> }
 | { kind: "tour"; tour: Tour; production: PlannedProduction; portfolio: { id: string; revision: number; digest: string }[]; mapping: AssignmentMap; sourceDigest: string; report: TourReport; tasks: Task[]; beforeTasks: Task[]; differences: { callId: string; taskId: string; label: string; before: string[]; after: string[] }[]; assignments: TourAssignmentState["assignments"]; issues: ConstraintIssue[]; engine: EngineReport }
 | { kind: "learning"; proposal: ReturnType<typeof learningProposal>; sourceStateDigest: string };
export interface WorkbenchReview { version: 1; id: string; digest: string; scope: InputScope; baseRevision: number; sourceDigest: string; createdAt: string; expiresAt: string; content: ReviewContent }
export interface WorkbenchReceipt { version: 1; commandId: string; requestDigest: string; scope: InputScope; acceptedAt: string; action: WorkbenchCommand["type"]; result: { reviewId: string; digest: string; revision: number; admitted: boolean; templateId?: string; message: string }; digest: string }
export interface WorkbenchResult { receipt: WorkbenchReceipt; replayed: boolean }
export interface WorkbenchWorkspace { version: 1; scope: InputScope; revision: number; serverAt: string; sourceDigest: string; production: { id: string; title: string; venue: string; showDate: string; zone: string }; offers: { id: string; supplier: string; revision: number; source: string }[]; tasks: { id: string; name: string; start: string; end: string; resources: string[]; requiredSkill: string | null; mutable: boolean }[]; people: { id: string; name: string; skills: string[] }[]; productions: PlannedProduction[]; tours: Tour[]; templates: ProductionTemplate[]; reviews: { review: WorkbenchReview; state: "current" | "stale" | "expired" | "admitted"; reason: string | null; receipt: WorkbenchReceipt | null }[]; currentTourAdmission: TourAssignmentState | null; controlled: boolean }
