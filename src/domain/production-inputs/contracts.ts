import { z } from "zod";
import type { Actor, ConstraintIssue, EngineReport, Resource, ShowSnapshot } from "../contracts";
import type { SourceBinding, SourceDocument } from "../sources";

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const inputHash = z.string().regex(/^[a-f0-9]{64}$/);
export const inputInstant = z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), "Use an exact instant with an offset.");
export const inputExpiry = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
export const inputCitationSchema = z.strictObject({ sourceId: z.uuid(), unitId: text(1, 100), quote: text(1, 1500) });
export type InputCitation = z.infer<typeof inputCitationSchema>;
export const inputFact = <T extends z.ZodType>(value: T) => z.strictObject({ value, citations: z.array(inputCitationSchema).min(1).max(8) });
const interval = z.strictObject({ from: inputInstant, until: inputInstant }).refine(value => Date.parse(value.from) < Date.parse(value.until), "Availability must end after it starts.");
export const qualificationSchema = z.strictObject({ skill: text(1, 100).regex(/^[a-z][a-z0-9_]*$/), expiresAt: inputInstant.nullable() });
const qualifications = z.array(qualificationSchema).max(40).refine(value => new Set(value.map(item => item.skill)).size === value.length, "List each qualification once.");
const department = z.enum(["lighting", "audio", "stage", "people", "house"]);
const rosterFields = {
  role: inputFact(text(2, 100)), department: inputFact(department), qualifications: inputFact(qualifications),
  availability: inputFact(interval), status: inputFact(z.enum(["active", "reserve"])),
  assignments: inputFact(z.array(text(1, 100)).max(150).refine(value => new Set(value).size === value.length)),
};
export const rosterChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("add"), key: text(1, 40).regex(/^[a-z][a-z0-9_-]*$/), name: inputFact(text(2, 100)), ...rosterFields }),
  z.strictObject({ kind: z.literal("update"), personId: text(1, 100), changes: z.strictObject(rosterFields).partial().refine(value => Object.keys(value).length > 0, "Choose at least one changed field.") }),
]);
export const venueChangesSchema = z.strictObject({
  accessWindow: inputFact(interval).optional(), amplifiedCurfew: inputFact(inputInstant).optional(),
  minimumRestMinutes: inputFact(z.number().int().min(0).max(2880)).optional(), maximumShiftMinutes: inputFact(z.number().int().min(60).max(1440)).optional(),
});
export const inputDraftSchema = z.strictObject({
  title: text(3, 160), rationale: text(20, 1500), roster: z.array(rosterChangeSchema).max(40), venue: venueChangesSchema,
}).refine(value => value.roster.length > 0 || Object.keys(value.venue).length > 0, "Propose at least one roster or venue change.");
export type InputDraft = z.infer<typeof inputDraftSchema>;
export type RosterChange = z.infer<typeof rosterChangeSchema>;
export const inputScopeSchema = z.strictObject({ tenantId: z.uuid(), actorId: text(1, 180), sessionFingerprint: inputHash, sessionExpiresAt: inputExpiry });
export type InputScope = z.infer<typeof inputScopeSchema>;
const rights = z.strictObject({ basis: z.enum(["owned", "authorized", "licensed", "public_domain"]), owner: text(1, 180), note: text(0, 800) });
const sourceMeta = { title: text(3, 160), provenance: z.enum(["controlled_declaration", "authorized_document"]), authorityNote: text(20, 1500), rightsConfirmed: z.literal(true) };
export const inputCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("retain_source"), ...sourceMeta, text: z.string().min(1).max(40000).refine(value => value.trim().length > 0), rights, replacesId: z.uuid().nullable() }),
  z.strictObject({ type: z.literal("admit_document"), ...sourceMeta, documentId: z.uuid(), contentHash: inputHash }),
  z.strictObject({ type: z.literal("propose"), draft: inputDraftSchema, sourceReviewed: z.literal(true) }),
  z.strictObject({ type: z.literal("preview"), proposalId: z.uuid(), proposalDigest: inputHash }),
  z.strictObject({ type: z.literal("approve"), previewId: z.uuid(), previewDigest: inputHash, sourceReviewed: z.literal(true), authorityDeclared: z.literal(true), consequencesReviewed: z.literal(true), schedulingBlockersAccepted: z.literal(true) }),
  z.strictObject({ type: z.literal("reject"), proposalId: z.uuid(), proposalDigest: inputHash, reason: text(12, 1000) }),
]);
export const inputEnvelopeSchema = z.strictObject({ version: z.literal(1), commandId: z.uuid(), scope: inputScopeSchema, expectedRevision: z.number().int().positive(), inputRevision: z.number().int().nonnegative(), command: inputCommandSchema });
export type InputEnvelope = z.infer<typeof inputEnvelopeSchema>;
export interface InputAuthority { actor: Actor; sessionHash: string }
export interface InputSource {
  id: string; familyId: string; version: number; title: string; provenance: "controlled_declaration" | "authorized_document";
  authorityNote: string; rights: z.infer<typeof rights>; contentHash: string; extractionDigest: string;
  units: { id: string; text: string; location: string }[]; createdAt: string;
  originalText: string | null;
  documentBinding: SourceBinding | null; originalDocument: SourceDocument | null;
}
export interface InputSourceView extends InputSource { current: boolean; blocker: string | null }
export interface InputProposal {
  id: string; digest: string; draft: InputDraft; sourceBindings: { id: string; digest: string }[]; sources: InputSource[];
  scope: InputScope; baseRevision: number; inputRevision: number; createdAt: string; expiresAt: string;
}
export interface InputDifference { field: string; before: string; after: string; citations: InputCitation[] }
export interface ProductionInputState {
  version: 1; editionId: string; revision: number; digest: string; admittedAtRevision: number; admittedAt: string; sourceIds: string[];
  roster: { personId: string; qualifications?: z.infer<typeof qualificationSchema>[]; sourceIds: string[]; provenance: "declared_planning_input" }[];
  venue: { accessFrom?: string; maximumShiftMinutes?: number; sourceIds: string[] };
}
export interface InputPreview {
  id: string; proposalId: string; proposalDigest: string; scope: InputScope; baseRevision: number; inputRevision: number; currentDigest: string;
  sourceBindings: InputProposal["sourceBindings"]; differences: InputDifference[]; issues: ConstraintIssue[]; engine: EngineReport;
  status: "ready_for_input_review" | "schedule_requires_replan" | "unknown"; notice: string; createdAt: string; expiresAt: string; digest: string;
}
export interface InputEdition {
  id: string; revision: number; proposalId: string; previewId: string; digest: string; approvedAt: string; actorId: string; sourceIds: string[];
  state: ProductionInputState; before: Pick<ShowSnapshot, "resources" | "tasks" | "policy" | "curfewAt" | "accessUntil" | "approvedPlan" | "state" | "goReportId">;
  after: Pick<ShowSnapshot, "resources" | "tasks" | "policy" | "curfewAt" | "accessUntil">; differences: InputDifference[]; issues: ConstraintIssue[]; engine: EngineReport;
}
export interface InputProposalView { proposal: InputProposal; state: "proposed" | "stale" | "expired" | "rejected" | "admitted"; blocker: string | null; latestPreview: InputPreview | null; decision: { kind: "approve" | "reject"; reason: string; recordedAt: string; editionId: string | null } | null }
export interface InputReceipt {
  version: 1; commandId: string; requestDigest: string; scopeId: string; expiresAt: string; action: InputEnvelope["command"]["type"]; acceptedAt: string;
  result: { sourceId?: string; proposalId?: string; previewId?: string; editionId?: string; digest?: string; revision: number; inputRevision: number; message: string }; receiptDigest: string;
}
export interface InputCommandResult { receipt: InputReceipt; replayed: boolean }
export interface InputWorkspace {
  version: 1; scope: InputScope; revision: number; inputRevision: number; serverAt: string; production: { title: string; venue: string; zone: string; showDate: string };
  sources: InputSourceView[]; documents: SourceDocument[]; proposals: InputProposalView[]; editions: InputEdition[];
  resources: Resource[]; tasks: { id: string; name: string; resources: string[]; requiredSkill: string | null }[];
  venue: { accessFrom: string | null; accessUntil: string; amplifiedCurfew: string; minimumRestMinutes: number; maximumShiftMinutes: number };
  currentInput: ProductionInputState | null; currentPlan: boolean; publicationCurrent: boolean; provenanceNotice: string;
}
