import { z } from "zod";
import type { Dependency, EngineReport, Resource, Task } from "./contracts";

export const sourceLimits = { bytes: 4 * 1024 * 1024, textCharacters: 180000, units: 5000, pages: 32, sheets: 12, cells: 5000, zipEntries: 512, inflatedBytes: 12 * 1024 * 1024, documentsPerCompilation: 8, compilationCharacters: 220000, tasks: 150, resources: 100, dependencies: 400 } as const;
export const sourceParserVersion = "opening-source-v1/pdfjs-6.5.438/exceljs-4.4.0";
export const sourceRoleSchema = z.enum(["rider", "venue", "schedule", "crew", "equipment", "rates", "other"]);
export const sourceRightsSchema = z.object({ basis: z.enum(["owned", "authorized", "licensed", "public_domain"]), owner: z.string().trim().min(1).max(180), note: z.string().trim().max(800) }).strict();
export const sourceUploadSchema = z.object({ requestId: z.uuid(), title: z.string().trim().min(1).max(160), role: sourceRoleSchema, rights: sourceRightsSchema, rightsConfirmed: z.literal(true), replacesId: z.uuid().nullable() }).strict();
export type SourceUpload = z.infer<typeof sourceUploadSchema>;
export const sourceLocatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), line: z.number().int().positive(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("pdf"), page: z.number().int().positive(), rect: z.array(z.number()).length(4), width: z.number().positive(), height: z.number().positive() }).strict(),
  z.object({ kind: z.literal("cell"), sheet: z.string().max(200), row: z.number().int().positive(), column: z.number().int().positive(), cell: z.string().max(20), formula: z.string().max(8000).nullable() }).strict(),
]);
export const sourceUnitSchema = z.object({ id: z.string().max(100), text: z.string().min(1).max(12000), locator: sourceLocatorSchema, caution: z.string().max(800).nullable() }).strict();
export const sourceExtractionSchema = z.object({ parserVersion: z.literal(sourceParserVersion), units: z.array(sourceUnitSchema).max(sourceLimits.units), notices: z.array(z.object({ code: z.string().max(100), message: z.string().max(1000), blocking: z.boolean() }).strict()).max(100), pageCount: z.number().int().nonnegative(), sheetCount: z.number().int().nonnegative() }).strict();
export type SourceUnit = z.infer<typeof sourceUnitSchema>;
export type SourceExtraction = z.infer<typeof sourceExtractionSchema>;
export type SourceState = "saved" | "parsing" | "ready" | "needs_attention" | "failed" | "deleted";
export interface SourceDocument {
  id: string; familyId: string; version: number; title: string; filename: string; role: z.infer<typeof sourceRoleSchema>;
  rights: z.infer<typeof sourceRightsSchema> | null; kind: "text" | "pdf" | "spreadsheet"; mediaType: string;
  byteLength: number; contentHash: string; extractionDigest: string | null; state: SourceState; current: boolean;
  createdAt: string; deletedAt: string | null; extraction: SourceExtraction | null; failureCode?: string | null;
}
export const sourceCitationSchema = z.object({ sourceId: z.uuid(), unitId: z.string().min(1).max(100), quote: z.string().min(1).max(1500) }).strict();
export type SourceCitation = z.infer<typeof sourceCitationSchema>;
const fact = <T extends z.ZodType>(value: T) => z.object({ value: value.nullable(), citations: z.array(sourceCitationSchema).max(8), assumption: z.string().trim().min(1).max(800).nullable() }).strict();
export type SourceFact<T> = { value: T | null; citations: SourceCitation[]; assumption: string | null };
const label = z.string().trim().min(1).max(180), instant = z.string().datetime({ offset: true });
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/), target = z.string().min(1).max(150).nullable();
const lane = z.enum(["lighting", "audio", "stage", "people", "commercial", "house"]);
export const compiledGraphSchema = z.object({
  schemaVersion: z.literal(1), summary: z.string().min(1).max(2000),
  production: z.object({ title: fact(label), venue: fact(label), zone: fact(z.string().min(1).max(80)), showDate: fact(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)) }).strict(),
  policy: z.object({ curfewAt: fact(instant), accessUntil: fact(instant), minimumRestMinutes: fact(z.number().int().min(0).max(1440)) }).strict(),
  resources: z.array(z.object({
    key, targetId: target, name: fact(label), kind: fact(z.enum(["person", "equipment", "space"])), department: fact(lane),
    skills: fact(z.array(z.string().min(1).max(100)).max(30)), availableFrom: fact(instant), availableUntil: fact(instant), capacity: fact(z.number().int().min(1).max(1000)), hourlyRateMinor: fact(z.number().int().min(0).max(1000000)),
  }).strict()).max(sourceLimits.resources),
  tasks: z.array(z.object({
    key, targetId: target, name: fact(label), lane: fact(lane), start: fact(instant), durationMinutes: fact(z.number().int().min(0).max(1440)),
    resources: fact(z.array(key).max(30)), requiredSkill: fact(z.string().min(1).max(100)), amplified: fact(z.boolean()),
    earliestStart: fact(instant), latestEnd: fact(instant),
  }).strict()).min(1).max(sourceLimits.tasks),
  dependencies: z.array(z.object({ key, from: key, to: key, lagMinutes: fact(z.number().int().min(0).max(1440)) }).strict()).max(sourceLimits.dependencies),
  unknowns: z.array(z.object({ field: z.string().max(200), message: z.string().min(1).max(800), blocking: z.boolean() }).strict()).max(100),
  conflicts: z.array(z.object({ field: z.string().max(200), message: z.string().min(1).max(800), citations: z.array(sourceCitationSchema).min(1).max(8) }).strict()).max(100),
  unsupportedRequirements: z.array(z.object({ message: z.string().min(1).max(800), citations: z.array(sourceCitationSchema).max(8) }).strict()).max(100),
}).strict();
export type CompiledGraph = z.infer<typeof compiledGraphSchema>;
export interface SourceBinding { id: string; familyId: string; version: number; hash: string; extractionDigest: string }
export interface CompilerIssue { code: string; severity: "hard" | "unknown"; blocking: boolean; field: string; message: string; citations: SourceCitation[] }
export interface CompilerAssumption { id: string; field: string; statement: string; value: unknown }
export interface CompilerCitation { field: string; citation: SourceCitation; valid: boolean; locator: SourceUnit["locator"] | null; title: string }
export interface CompilerPatch { tasks: Task[]; dependencies: Dependency[]; resources: Resource[]; curfewAt: string; accessUntil: string; minimumRestMinutes: number; importedTaskIds: string[]; importedResourceIds: string[] }
export interface CompilerReview {
  graph: CompiledGraph; issues: CompilerIssue[]; assumptions: CompilerAssumption[]; citations: CompilerCitation[];
  patch: CompilerPatch; engine: EngineReport | null; canApply: boolean;
}
export type CompilationState = "dispatching" | "running" | "validating" | "completed" | "failed" | "indeterminate" | "unavailable" | "deleted";
export interface CompilationView {
  id: string; requestId: string; state: CompilationState; message: string; baseRevision: number; sourceBindings: SourceBinding[];
  createdAt: string; model: string; resolvedModel: string | null; provenance: "live_model" | "controlled_fixture";
  review: CompilerReview | null; digest: string | null; current: boolean; appliedAt: string | null; appliedRevision: number | null;
}
export interface SourceWorkspace { documents: SourceDocument[]; compilations: CompilationView[]; providerAvailable: boolean; providerMode: "live_model" | "controlled_fixture" }
export const compileSourceSchema = z.object({ requestId: z.uuid(), expectedRevision: z.number().int().positive(), sourceIds: z.array(z.uuid()).min(1).max(sourceLimits.documentsPerCompilation) }).strict();
export const applySourceSchema = z.object({ commandId: z.uuid(), compilationId: z.uuid(), compilationDigest: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: z.number().int().positive(), reviewedSourceIds: z.array(z.uuid()).min(1).max(sourceLimits.documentsPerCompilation), acceptedAssumptionIds: z.array(z.string().max(240)).max(2000), reviewed: z.literal(true) }).strict();
export const deleteSourceSchema = z.object({ sourceId: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) }).strict();
export const compilationMessages: Record<CompilationState, string> = {
  dispatching: "The original compilation request is saved.", running: "Reading the original provider response. No replacement request is sent.",
  validating: "Checking the proposed production graph and its source citations.", completed: "The source-grounded proposal is saved for your review.",
  failed: "The original compilation did not produce a usable graph. Its attempt is retained.",
  indeterminate: "The original compilation outcome is uncertain. It is held for review and has not been regenerated.",
  unavailable: "The original response could not be recovered. Its request identity is retained.", deleted: "The private input and uncommitted output were removed with their source. A redacted identity remains.",
};
export function sourceLocationLabel(locator: SourceUnit["locator"]) {
  return locator.kind === "text" ? `Line ${locator.line}` : locator.kind === "pdf" ? `Page ${locator.page}` : `${locator.sheet} · ${locator.cell}`;
}
export function graphFacts(graph: CompiledGraph): { field: string; fact: SourceFact<unknown> }[] {
  return [
    ...Object.entries(graph.production).map(([field, fact]) => ({ field: `production.${field}`, fact })),
    ...Object.entries(graph.policy).map(([field, fact]) => ({ field: `policy.${field}`, fact })),
    ...graph.resources.flatMap(resource => Object.entries(resource).filter(([field]) => !["key", "targetId"].includes(field)).map(([field, fact]) => ({ field: `resource.${resource.key}.${field}`, fact: fact as SourceFact<unknown> }))),
    ...graph.tasks.flatMap(task => Object.entries(task).filter(([field]) => !["key", "targetId"].includes(field)).map(([field, fact]) => ({ field: `task.${task.key}.${field}`, fact: fact as SourceFact<unknown> }))),
    ...graph.dependencies.map(edge => ({ field: `dependency.${edge.key}.lagMinutes`, fact: edge.lagMinutes })),
  ];
}
