import { z } from "zod";

const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/);
const text = (max = 240) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const timeInputSchema = z.object({ local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), zone: text(80), disambiguation: z.enum(["reject", "earlier", "later"]).default("reject") }).strict();
export type TimeInput = z.infer<typeof timeInputSchema>;
export interface ZonedTime extends TimeInput { instant: string; offset: string }
export const sourceSchema = z.object({ id, title: text(200), kind: z.enum(["manual", "fixture", "source_document", "template"]), status: z.enum(["reviewed", "assumption", "unknown"]), version: z.number().int().positive(), contentHash: hash.nullable(), documentId: z.uuid().nullable(), locator: text(240).nullable(), unitId: text(240).nullable().optional(), note: text(1200) }).strict();
export type PlanningSource = z.infer<typeof sourceSchema>;
const sourceIds = z.array(id).max(20);
export const issueSchema = z.object({ id, label: text(700), hard: z.boolean(), sourceIds }).strict();
export type PlanningUnknown = z.infer<typeof issueSchema>;
const kind = z.enum(["person", "equipment", "space"]);
const lane = z.enum(["stage", "lighting", "audio", "house", "people"]);
export const slotSchema = z.object({ id, label: text(160), kind, skills: z.array(text(100)).max(30), capacity: z.number().int().min(1).max(100), sourceIds }).strict();
export type ResourceSlot = z.infer<typeof slotSchema>;
export const relativeWindowSchema = z.object({ dayOffset: z.number().int().min(-7).max(30), localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }).strict();
export const templateCallSchema = z.object({ id, label: text(180), lane, dayOffset: z.number().int().min(-7).max(30), localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), durationMinutes: z.number().int().min(0).max(2880), slotIds: z.array(id).max(30), requiredSkills: z.array(text(100)).max(30), amplified: z.boolean(), earliest: relativeWindowSchema.nullable().optional(), latest: relativeWindowSchema.nullable().optional(), sourceIds }).strict();
export type TemplateCall = z.infer<typeof templateCallSchema>;
export const edgeSchema = z.object({ id, from: id, to: id, lagMinutes: z.number().int().min(0).max(2880), sourceIds }).strict();
export const stageSchema = z.object({ width: z.number().positive().max(10000).nullable(), depth: z.number().positive().max(10000).nullable(), units: z.enum(["m", "ft", "normalized"]), status: z.enum(["illustrative", "needs_review", "reviewed_source"]), sourceIds, pins: z.array(z.object({ id, label: text(120), x: z.number().min(0).max(10000).nullable(), y: z.number().min(0).max(10000).nullable(), slotId: id.nullable(), callId: id.nullable(), sourceIds }).strict()).max(150) }).strict();
export type StagePlan = z.infer<typeof stageSchema>;
export const templateSpecSchema = z.object({ name: text(160), description: text(1200), zonePolicy: z.literal("venue_wall_clock"), slots: z.array(slotSchema).max(100), calls: z.array(templateCallSchema).max(500), dependencies: z.array(edgeSchema).max(1500), minimumRestMinutes: z.number().int().min(0).max(1440).nullable(), maxDutyMinutes: z.number().int().min(1).max(2880).nullable(), sources: z.array(sourceSchema).min(1).max(2000), unknowns: z.array(issueSchema).max(200), stage: stageSchema }).strict();
export type TemplateSpec = z.infer<typeof templateSpecSchema>;
export interface Edition { id: string; revision: number; digest: string; archived: boolean; createdAt: string; updatedAt: string; actorId: string; reason: string }
export interface ProductionTemplate extends Edition { kind: "template"; spec: TemplateSpec; origin: "authored" | "reviewed_compiler" | "synthetic_fixture"; compilerBinding: CompilerBinding | null }
export interface CompilerBinding { id: string; digest: string; baseRevision: number; sources: { id: string; version: number; hash: string; extractionDigest: string }[] }
export const venueInputSchema = z.object({ name: text(160), city: text(120), zone: text(80), access: timeInputSchema.nullable(), curfew: timeInputSchema.nullable(), accessUntil: timeInputSchema.nullable(), sourceIds }).strict();
export type VenueInput = z.infer<typeof venueInputSchema>;
export interface PlanningVenue extends Omit<VenueInput, "access" | "curfew" | "accessUntil"> { access: ZonedTime | null; curfew: ZonedTime | null; accessUntil: ZonedTime | null }
export interface ProductionCall extends Omit<TemplateCall, "dayOffset" | "localTime" | "earliest" | "latest"> { start: ZonedTime; end: ZonedTime; earliest?: ZonedTime | null; latest?: ZonedTime | null }
export interface PlannedProduction extends Edition { kind: "production"; name: string; origin: "blank" | "demo" | "template_derived" | "source_imported"; showDate: string; venue: PlanningVenue; template: { id: string; revision: number; digest: string } | null; compilerBinding: CompilerBinding | null; slots: ResourceSlot[]; calls: ProductionCall[]; dependencies: z.infer<typeof edgeSchema>[]; allocations: Record<string, string>; assignmentOverrides: Record<string, Record<string, string>>; minimumRestMinutes: number | null; maxDutyMinutes: number | null; sources: PlanningSource[]; unknowns: PlanningUnknown[]; stage: StagePlan; operationalEvidence: never[]; commercialEvidence: never[] }
export const availabilitySchema = z.object({ start: timeInputSchema, end: timeInputSchema }).strict();
export const tourResourceSchema = z.object({ id, label: text(160), kind, personId: id.nullable(), skills: z.array(text(100)).max(30), capacity: z.number().int().min(1).max(100), availability: z.array(availabilitySchema).max(100), availabilityStatus: z.enum(["reviewed", "assumption", "unknown"]), forecastHourlyMinor: z.number().int().min(0).max(1000000).nullable(), sourceIds }).strict();
export type TourResource = z.infer<typeof tourResourceSchema>;
export const legSchema = z.object({ id, label: text(160), fromProductionId: z.uuid(), toProductionId: z.uuid(), resourceIds: z.array(id).min(1).max(100), departure: timeInputSchema, durationMinutes: z.number().int().min(0).max(14400).nullable(), loadingMinutes: z.number().int().min(0).max(1440), unloadingMinutes: z.number().int().min(0).max(1440), mode: z.enum(["road", "rail", "air", "walk", "unknown"]), status: z.enum(["reviewed", "assumption", "unknown"]), forecastCostMinor: z.number().int().min(0).max(100000000).nullable(), sourceIds }).strict();
export type TravelLeg = z.infer<typeof legSchema>;
export const tourDraftSchema = z.object({ name: text(160), productionIds: z.array(z.uuid()).max(50), resources: z.array(tourResourceSchema).max(100), legs: z.array(legSchema).max(100), sources: z.array(sourceSchema).min(1).max(200), minimumRestMinutes: z.number().int().min(0).max(1440), maxDutyMinutes: z.number().int().min(1).max(2880) }).strict();
export type TourDraft = z.infer<typeof tourDraftSchema>;
export interface Tour extends Edition, TourDraft { kind: "tour" }
export interface ConstraintFinding { id: string; code: string; severity: "hard" | "unknown" | "approval"; message: string; productionIds: string[]; callIds: string[]; resourceIds: string[]; sourceIds: string[] }
export interface RestResult { resourceId: string; fromProductionId: string; toProductionId: string; previousEnd: string; nextStart: string; travelMinutes: number | null; restMinutes: number | null; minimumMinutes: number; slackMinutes: number | null; status: "pass" | "fail" | "unknown" }
export interface EngineProof { vendor: "Bryntum Gantt Enterprise"; version: "8.0.0"; status: "passed" | "rejected" | "unavailable"; tasks: number; dependencies: number; elapsedMs: number; inputDigest: string; resultDigest: string | null; constraints: string[] }
export interface TourReport { status: "feasible" | "needs_review" | "infeasible" | "unknown"; hard: ConstraintFinding[]; unknown: ConstraintFinding[]; approvals: ConstraintFinding[]; rests: RestResult[]; forecast: { travelMinor: number; labourMinor: number; totalMinor: number; unknownItems: number; currency: "USD" }; travelMinutes: number | null; engine: EngineProof | null }
export const candidateInputSchema = z.object({ name: text(120), explanation: text(1200), shifts: z.array(z.object({ productionId: z.uuid(), callId: id, minutes: z.number().int().min(-2880).max(2880) }).strict()).max(500), legOverrides: z.array(z.object({ legId: id, leg: legSchema }).strict()).max(100) }).strict();
export type CandidateInput = z.infer<typeof candidateInputSchema>;
export interface TourCandidate { id: string; name: string; explanation: string; changes: CandidateInput; report: TourReport; calls: { productionId: string; callId: string; label: string; before: ZonedTime; after: ZonedTime }[]; digest: string }
export interface RouteComparison extends Edition { kind: "comparison"; tourId: string; tourRevision: number; tourDigest: string; productionBindings: { id: string; revision: number; digest: string }[]; sourceDigest: string; candidates: TourCandidate[]; applied: { candidateId: string; commandId: string; at: string; actorId: string; approvedFindingIds: string[] } | null }
export interface SwapDecision { actorId: string; personId: string | null; sessionFingerprint: string; at: string; kind: "requested" | "accepted" | "declined" | "withdrawn" | "approved"; reason: string }
export interface ShiftSwap extends Edition { kind: "swap"; tourId: string; tourRevision: number; productionId: string; productionRevision: number; callId: string; fromResourceId: string; toResourceId: string; requesterPersonId: string; recipientPersonId: string; state: "requested" | "accepted" | "declined" | "withdrawn" | "approved"; decisions: SwapDecision[]; reverseOf: string | null; report: TourReport; productionBindings: { id: string; revision: number; digest: string }[] }
export interface PlanningAcknowledgment { id: string; personId: string; productionId: string; callId: string; obligationDigest: string; actorId: string; at: string; kind: "readback" }
export type TourRecord = ProductionTemplate | PlannedProduction | Tour | RouteComparison | ShiftSwap;
const common = { commandId: z.uuid() };
const edition = { id: z.uuid(), expectedRevision: z.number().int().positive() };
const reason = text(1000);
export const tourCommandSchema = z.object({ ...common, action: z.discriminatedUnion("type", [
  z.object({ type: z.literal("template.create"), spec: templateSpecSchema, reusableReviewed: z.literal(true) }).strict(),
  z.object({ type: z.literal("template.revise"), ...edition, spec: templateSpecSchema, reason, reusableReviewed: z.literal(true) }).strict(),
  z.object({ type: z.literal("template.from_compiler"), compilationId: z.uuid(), compilationDigest: hash, reviewedSourceIds: z.array(z.uuid()).min(1).max(8), acceptedAssumptionIds: z.array(text(240)).max(2000), reusableReviewed: z.literal(true) }).strict(),
  z.object({ type: z.literal("production.instantiate"), templateId: z.uuid(), templateRevision: z.number().int().positive(), templateDigest: hash, name: text(160), showDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), venue: venueInputSchema, foldChoice: z.enum(["reject", "earlier", "later"]).default("reject") }).strict(),
  z.object({ type: z.literal("production.from_compiler"), compilationId: z.uuid(), compilationDigest: hash, reviewedSourceIds: z.array(z.uuid()).min(1).max(8), acceptedAssumptionIds: z.array(text(240)).max(2000), reviewed: z.literal(true) }).strict(),
  z.object({ type: z.literal("production.demo"), name: text(160), showDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), venue: venueInputSchema, foldChoice: z.enum(["reject", "earlier", "later"]).default("reject"), fictionalReviewed: z.literal(true) }).strict(),
  z.object({ type: z.literal("production.create"), name: text(160), showDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), venue: venueInputSchema }).strict(),
  z.object({ type: z.literal("production.revise"), ...edition, spec: templateSpecSchema, venue: venueInputSchema, reason, requirementsReviewed: z.literal(true), foldChoice: z.enum(["reject", "earlier", "later"]).default("reject") }).strict(),
  z.object({ type: z.literal("production.allocate"), ...edition, allocations: z.record(id, id), reason }).strict(),
  z.object({ type: z.literal("production.stage"), ...edition, stage: stageSchema, coordinatesReviewed: z.literal(true), reason }).strict(),
  z.object({ type: z.literal("tour.create"), draft: tourDraftSchema }).strict(),
  z.object({ type: z.literal("tour.revise"), ...edition, draft: tourDraftSchema, reason }).strict(),
  z.object({ type: z.literal("record.archive"), ...edition, archived: z.boolean(), reason }).strict(),
  z.object({ type: z.literal("comparison.create"), tourId: z.uuid(), expectedRevision: z.number().int().positive(), alternatives: z.array(candidateInputSchema).min(2).max(6) }).strict(),
  z.object({ type: z.literal("comparison.apply"), comparisonId: z.uuid(), comparisonDigest: hash, candidateId: id, acceptedFindingIds: z.array(id).max(1000), reviewed: z.literal(true) }).strict(),
  z.object({ type: z.literal("swap.request"), tourId: z.uuid(), expectedTourRevision: z.number().int().positive(), productionId: z.uuid(), expectedProductionRevision: z.number().int().positive(), callId: id, recipientResourceId: id, reason, reverseOf: z.uuid().nullable() }).strict(),
  z.object({ type: z.literal("swap.decide"), ...edition, decision: z.enum(["accept", "decline", "withdraw", "approve"]), reason, reviewed: z.literal(true) }).strict(),
  z.object({ type: z.literal("personal.acknowledge"), productionId: z.uuid(), callId: id, obligationDigest: hash, reviewed: z.literal(true) }).strict(),
]) }).strict();
export type TourCommand = z.infer<typeof tourCommandSchema>;
export interface TourReceipt { commandId: string; action: TourCommand["action"]["type"]; actorId: string; at: string; records: { id: string; kind: TourRecord["kind"]; revision: number; digest: string }[]; acknowledgmentId?: string }
export interface TourWorkspace { tenantId: string; actorId: string; sessionFingerprint: string; expiresAt: string; templates: ProductionTemplate[]; productions: PlannedProduction[]; tours: Tour[]; reports: Record<string, TourReport>; readbacks: { productionId: string; callId: string; resourceId: string; personId: string; current: boolean; obligationDigest: string }[]; comparisons: RouteComparison[]; swaps: ShiftSwap[]; acknowledgments: PlanningAcknowledgment[]; roster: { id: string; name: string; skills: string[] }[]; history: TourReceipt[]; controlled: boolean }
export interface PersonalTour { tenantId: string; sessionFingerprint: string; person: { id: string; name: string }; actorId: string; expiresAt: string; calls: { productionId: string; productionName: string; venue: string; zone: string; productionRevision: number; call: Pick<ProductionCall, "id" | "label" | "start" | "end" | "lane">; obligationDigest: string; acknowledged: boolean; resourceId: string; tourId: string; tourRevision: number }[]; rests: RestResult[]; swaps: { id: string; revision: number; state: ShiftSwap["state"]; tourId: string; productionId: string; callId: string; fromResourceId: string; toResourceId: string; reverseOf: string | null; productionName: string; callLabel: string; requester: string; recipient: string; isRequester: boolean; isRecipient: boolean; decisions: SwapDecision[]; issues: ConstraintFinding[] }[]; colleagues: { id: string; name: string; tourId: string }[]; history: { id: string; at: string; productionId: string; callId: string; current: boolean }[]; controlled: boolean }
