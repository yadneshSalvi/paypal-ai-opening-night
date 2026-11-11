import { z } from "zod";
import type { CueScope, Lane, ShowSnapshot } from "../contracts";

export const CREW_PROTOCOL = 1 as const;
export const crewDutyKinds = ["focus_signed_off", "cue_signed_off", "foh_contingency", "support_checkin", "support_ready", "headliner_checkin", "quiet_prep", "changeover"] as const;
export type CrewDutyKind = typeof crewDutyKinds[number];
export const crewCueKinds = ["DOORS_GO", "HOUSE_OPEN", "SUPPORT_START", "HEADLINER_START"] as const;
export type CrewCueKind = typeof crewCueKinds[number];

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const boundedId = z.string().min(1).max(120);
export const crewReviewSchema = z.object({ planVersion: z.number().int().positive(), planDigest: hash, sheetVersion: z.number().int().positive(), sheetDigest: hash, policyVersion: z.number().int().positive() }).strict();
export type CrewReview = z.infer<typeof crewReviewSchema>;
export const crewAcknowledgmentCommandSchema = z.object({ type: z.literal("acknowledge"), sheetVersion: z.number().int().positive(), sheetDigest: hash, seenTaskIds: z.array(boundedId).max(300), offline: z.boolean() }).strict();
export const crewLiveCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("attest"), kind: z.enum(crewDutyKinds), review: crewReviewSchema, detail: z.string().trim().min(12).max(1200), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("cue"), kind: z.enum(crewCueKinds), review: crewReviewSchema, reportId: hash, precedingCueId: z.uuid().nullable(), detail: z.string().trim().min(12).max(1200), confirmed: z.literal(true) }).strict(),
]);
export const crewCommandSchema = z.union([crewAcknowledgmentCommandSchema, crewLiveCommandSchema]);
export type CrewCommand = z.infer<typeof crewCommandSchema>;
export type CrewLiveCommand = z.infer<typeof crewLiveCommandSchema>;
export const crewCommandEnvelopeSchema = z.object({ idempotencyKey: z.uuid(), expectedRevision: z.number().int().positive(), command: crewCommandSchema }).strict();
export type CrewCommandEnvelope = z.infer<typeof crewCommandEnvelopeSchema>;

export interface CrewRecordContext extends CrewReview {
  protocol: 1; id: string; commandId: string; tenantId: string; showId: string; actorId: string; personId: string;
  recordedAt: string; fixtureAt: string; revision: number; source: "controlled_client"; detail: string;
}
export interface CrewAttestation extends CrewRecordContext { type: "attestation"; kind: CrewDutyKind; signature: string }
export interface CrewCueExecution extends CrewRecordContext { type: "cue"; kind: CrewCueKind; reportId: string; precedingCueId: string | null; signature: string }
export type CrewRecord = CrewAttestation | CrewCueExecution;
export type UnsignedCrewRecord = Omit<CrewAttestation, "signature"> | Omit<CrewCueExecution, "signature">;
export type CrewVerifier = (record: CrewRecord) => boolean;
export type CrewSigner = (record: UnsignedCrewRecord) => string;
export interface CrewAdoption {
  protocol: 1; actorId: string; adoptedAt: string; previousState: ShowSnapshot["state"]; previousGoReportId: string | null;
}
export interface CrewNextCall { id: string; name: string; lane: Lane; start: string; end: string; resources: string[]; sourceId: string }

// This is intentionally independent of ConsoleData/ShowSnapshot. Every field is
// an allowlisted personal read model, including its runtime cache validator.
export const crewCallSchema = z.object({ id: boundedId, name: z.string().max(200), lane: z.enum(["lighting", "audio", "stage", "people", "commercial", "house"]), start: instant, end: instant, durationMinutes: z.number().nonnegative(), resources: z.array(boundedId).max(1), critical: z.boolean(), affected: z.boolean(), nextDay: z.boolean() }).strict();
export type CrewCall = z.infer<typeof crewCallSchema>;
const changeSchema = z.object({ taskId: boundedId, name: z.string().max(200), before: z.string().max(100), after: z.string().max(100), reason: z.string().max(500) }).strict();
export const crewReadbackSchema = z.object({ id: boundedId, commandId: z.uuid().nullable(), actorId: boundedId.nullable(), sheetVersion: z.number().int().positive(), sheetDigest: hash, receivedAt: instant, offline: z.boolean(), current: z.boolean(), attribution: z.enum(["person_capability", "legacy_record"]) }).strict();
export type CrewReadback = z.infer<typeof crewReadbackSchema>;
export const crewRecordSummarySchema = z.object({ id: z.uuid(), commandId: z.uuid(), type: z.enum(["attestation", "cue"]), kind: z.enum([...crewDutyKinds, ...crewCueKinds]), personId: boundedId, personName: z.string().max(100), actorId: boundedId, detail: z.string().max(1200), recordedAt: instant, fixtureAt: instant, planVersion: z.number().int().positive(), sheetVersion: z.number().int().positive(), sheetDigest: hash, status: z.enum(["current", "historical", "invalid"]), signatureFingerprint: hash }).strict();
export type CrewRecordSummary = z.infer<typeof crewRecordSummarySchema>;
export const crewDutySchema = z.object({ kind: z.enum(crewDutyKinds), title: z.string().max(160), instructions: z.string().max(500), taskIds: z.array(boundedId).max(5), earliestAt: instant.nullable(), available: z.boolean(), blockers: z.array(z.string().max(300)).max(12), record: crewRecordSummarySchema.nullable() }).strict();
export type CrewDuty = z.infer<typeof crewDutySchema>;
export const crewReadinessSchema = z.object({ scope: z.enum(["DOORS", "SUPPORT_START", "HEADLINER_START"]), reportId: hash, revision: z.number().int().positive(), ready: z.boolean(), gates: z.array(z.object({ id: boundedId, label: z.string().max(150), complete: z.boolean(), status: z.string().max(100) }).strict()).max(12) }).strict();
export type CrewReadiness = z.infer<typeof crewReadinessSchema>;
export const crewCueOptionSchema = z.object({ kind: z.enum(crewCueKinds), title: z.string().max(160), scope: z.enum(["DOORS", "SUPPORT_START", "HEADLINER_START"]), earliestAt: instant, reportId: hash, precedingCueId: z.uuid().nullable(), available: z.boolean(), blockers: z.array(z.string().max(300)).max(20), record: crewRecordSummarySchema.nullable() }).strict();
export type CrewCueOption = z.infer<typeof crewCueOptionSchema>;
export const crewDataSchema = z.object({
  schemaVersion: z.literal(1), protocol: z.union([z.literal(0), z.literal(1)]), controlledQa: z.boolean(), serverAt: instant,
  access: z.object({ actorId: boundedId, expiresAt: instant }).strict(),
  person: z.object({ id: boundedId, name: z.string().max(100), role: z.string().max(120), color: z.string().regex(/^#[a-fA-F0-9]{6}$/), critical: z.boolean(), reserve: z.boolean() }).strict(),
  show: z.object({ title: z.string().max(150), support: z.string().max(150), venue: z.string().max(150), zone: z.literal("America/Chicago"), showDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), clock: instant, revision: z.number().int().positive(), planVersion: z.number().int().positive(), doorsAt: instant }).strict(),
  sheet: z.object({ version: z.number().int().positive(), digest: hash, planVersion: z.number().int().positive(), publishedAt: instant, currentPlan: z.boolean(), recovery: z.boolean(), calls: z.array(crewCallSchema).max(600), changes: z.array(changeSchema).max(300) }).strict(),
  review: crewReviewSchema.nullable(),
  acknowledgments: z.array(crewReadbackSchema).max(1000),
  rest: z.object({ lastCallId: boundedId.nullable(), lastFinishAt: instant.nullable(), nextCall: crewCallSchema.nullable(), minutes: z.number().nullable(), minimumMinutes: z.number().positive(), status: z.enum(["pass", "fail", "unknown", "not_scheduled"]) }).strict(),
  duties: z.array(crewDutySchema).max(8), cues: z.array(crewCueOptionSchema).max(4), readiness: z.array(crewReadinessSchema).max(3),
  history: z.array(crewRecordSummarySchema).max(1000),
  contact: z.object({ label: z.string().max(100), instruction: z.string().max(300) }).strict(),
}).strict();
export type CrewData = z.infer<typeof crewDataSchema>;
export interface CrewCommandReceipt { id: string; commandId: string; type: "acknowledgment" | "attestation" | "cue"; current: boolean }
export interface CrewCommandResponse { data: CrewData; receipt: CrewCommandReceipt; replayed: boolean }
export interface CrewProductionOverview {
  protocol: 0 | 1; duties: { kind: CrewDutyKind; title: string; personIds: string[]; record: CrewRecordSummary | null }[];
  history: CrewRecordSummary[]; cues: { kind: CrewCueKind; title: string; personIds: string[]; record: CrewRecordSummary | null }[];
  legacyFactCount: number;
}
export const cueScope = (kind: CrewCueKind): CueScope => kind === "DOORS_GO" || kind === "HOUSE_OPEN" ? "DOORS" : kind;
