import { z } from "zod";
import type { Candidate, EvidenceRef, ExternalPlanApproval, Role } from "./contracts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), "Use ordinary text.");
export const consentTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,23) === value.slice(0,23));
export const producerConsentScopeSchema = z.strictObject({ tenantId: z.uuid(), actorId: text(1,180), sessionExpiresAt: consentTimestamp, sessionFingerprint: hash });
export type ProducerConsentScope = z.infer<typeof producerConsentScopeSchema>;
const candidateBinding = { candidateId: text(1,100), candidateDigest: hash };
export const producerConsentCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("invite"), ...candidateBinding, requirementId: text(1,80), representativeName: text(2,100), representationBasis: text(20,1000), sourceId: text(1,160), validityMinutes: z.number().int().min(5).max(60), sourceReviewed: z.literal(true), invitationReviewed: z.literal(true) }),
  z.strictObject({ type: z.literal("revoke"), requestId: z.uuid(), reviewDigest: hash, reason: text(12,1000) }),
  z.strictObject({ type: z.literal("approve_plan"), ...candidateBinding, approvals: z.array(text(1,80)).min(1).max(12), reviewed: z.literal(true) }),
]);
export const producerConsentEnvelopeSchema = z.strictObject({ version: z.literal(1), commandId: z.uuid(), scope: producerConsentScopeSchema, expectedRevision: z.number().int().positive(), approvalRevision: z.number().int().nonnegative(), command: producerConsentCommandSchema });
export type ProducerConsentEnvelope = z.infer<typeof producerConsentEnvelopeSchema>;
export const reviewerConsentEnvelopeSchema = z.strictObject({ version: z.literal(1), commandId: z.uuid(), requestId: z.uuid(), reviewDigest: hash, expiresAt: consentTimestamp, capabilityFingerprint: hash, decision: z.enum(["approve","decline"]), declaredName: text(2,100), authorityConfirmed: z.literal(true), contentReviewed: z.literal(true), statement: text(12,1200) });
export type ReviewerConsentEnvelope = z.infer<typeof reviewerConsentEnvelopeSchema>;
export type ConsentEnvelope = ProducerConsentEnvelope | ReviewerConsentEnvelope;
export type ConsentState = "awaiting_representative" | "consented" | "declined" | "revoked" | "expired" | "source_changed" | "committed";
export interface ConsentReview {
  version: 1; requestId: string; production: { title: string; venue: string; showDate: string; zone: string };
  candidate: { id: string; name: string; digest: string; sourceDigest: string; baseRevision: number };
  requirement: { id: string; label: string; role: "artist_representative" };
  representative: { invitedName: string; basis: string; source: EvidenceRef };
  changes: { taskId: string; name: string; before: { start: string; end: string; minutes: number } | null; proposed: { start: string; end: string; minutes: number } | null }[];
  proposedDoorsAt: string; createdAt: string; expiresAt: string;
  provenance: "controlled_declaration" | "invited_declaration";
  authorityNotice: string;
}
export interface ConsentDecision {
  id: string; requestId: string; decision: "approve" | "decline"; declaredName: string; statement: string;
  reviewDigest: string; recordedAt: string; receiptDigest: string; reviewerId: string;
}
export interface ConsentRequestView {
  review: ConsentReview; reviewDigest: string; state: ConsentState; blocker: string | null;
  decision: ConsentDecision | null; revoked: { at: string; reason: string } | null;
  committed: { commandId: string; planVersion: number; at: string } | null; ownOriginalAccess: boolean; originalReviewPath: string | null;
}
export interface ReviewerConsentView extends Omit<ConsentRequestView,"ownOriginalAccess"|"originalReviewPath"> { capabilityFingerprint: string; serverAt: string }
export interface ConsentCandidate {
  candidate: Candidate; current: boolean; blocker: string | null;
  supplierName: string; depositMinor: number; commercialCapMinor: number;
  changes: ConsentReview["changes"];
  requests: { requirementId: string; requestId: string; state: ConsentState; ownOriginalAccess: boolean }[];
}
export interface ProducerConsentWorkspace {
  scope: ProducerConsentScope; revision: number; approvalRevision: number; serverAt: string;
  production: ConsentReview["production"]; actorRoles: Role[]; sources: EvidenceRef[]; candidates: ConsentCandidate[]; requests: ConsentRequestView[];
}
export interface ConsentReceipt {
  version: 1; commandId: string; action: "invite" | "revoke" | "approve_plan" | "approve" | "decline";
  scopeId: string; expiresAt: string; requestDigest: string; acceptedAt: string; receiptDigest: string;
  result: { requestId?: string; reviewDigest?: string; reviewPath?: string; decision?: ConsentDecision; revision?: number; planVersion?: number; candidateDigest?: string; externalApprovals?: ExternalPlanApproval[]; message: string };
}
export interface ConsentCommandResult { receipt: ConsentReceipt; replayed: boolean }
export const consentStateText: Record<ConsentState,string> = {
  awaiting_representative: "Awaiting the invited representative", consented: "Consent saved · producer decision remains separate", declined: "The representative declined this exact proposal", revoked: "Unused review access stopped", expired: "This review window ended", source_changed: "The production changed · review a new proposal", committed: "Included in the separate producer approval",
};
