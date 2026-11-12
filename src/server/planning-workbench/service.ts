import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError, type ShowSnapshot, type EngineReport } from "@/domain/contracts";
import { appendEvent, recordRescueRun } from "@/domain/commands";
import { digest } from "@/domain/hash";
import { validatePatch } from "@/domain/scheduling";
import type { InputAuthority } from "@/domain/production-inputs/contracts";
import type { PlannedProduction, ProductionTemplate, Tour, TourRecord } from "@/domain/tour/contracts";
import { recordDigest } from "@/domain/tour/templates";
import { evaluateTour, portfolioFindings } from "@/domain/tour/constraints";
import { workbenchEnvelopeSchema, type ReviewContent, type WorkbenchEnvelope, type WorkbenchReceipt, type WorkbenchReview, type WorkbenchWorkspace } from "@/domain/planning-workbench/contracts";
import { enumerateStrategies, strategyMetrics, strategyScopeDigest } from "@/domain/planning-workbench/strategies";
import { assignmentProjection } from "@/domain/planning-workbench/tour-admission";
import { learningProposal } from "@/domain/planning-workbench/learning";
import { commitGraphEngine, evaluateCandidates } from "../engine";
import { env } from "../env";
import { inputAuthority, inputNow, inputShow, inputTransaction, inputUnexpired } from "../production-inputs/store";
import { records, sourceState, saveRecord } from "../tour/store";
import { evaluateWithEngine } from "../tour/comparisons";
import { openReview, readReceipt, reviewById, saveReceipt, saveReview, workbenchDigest } from "./store";

const binding = (record: TourRecord) => ({ id: record.id, revision: record.revision, digest: record.digest });
async function portfolioLock(db: PoolClient, tenant: string) { await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,4548))", [tenant]); return records(db, tenant); }
function exact<T extends "production" | "tour">(all: TourRecord[], id: string, kind: T, expectedDigest?: string): Extract<TourRecord, { kind: T }> {
 const value = all.find(row => row.id === id && row.kind === kind && !row.archived);
 if (!value || expectedDigest && value.digest !== expectedDigest) throw new DomainError("WORKBENCH_LIBRARY_CHANGED", "The selected source edition changed or was archived. Review its current exact edition.");
 return value as Extract<TourRecord, { kind: T }>;
}
async function sourceCurrent(db: PoolClient, tenant: string, review: WorkbenchReview, all: TourRecord[]) {
 const content = review.content;
 if (content.kind === "tour") {
  if (digest(all.map(binding)) !== digest(content.portfolio)) return false;
  const productions = all.filter((row): row is PlannedProduction => row.kind === "production");
  const state = await sourceState(db, tenant, productions.filter(row => content.tour.productionIds.includes(row.id)));
  return state.current && state.digest === content.sourceDigest;
 }
 if (content.kind === "learning") {
  const values: PlannedProduction[] = [];
  for (const expected of content.proposal.lineage) { const value = all.find(row => row.id === expected.id && row.kind === "production"); if (!value || value.revision !== expected.revision || value.digest !== expected.digest) return false; values.push(value as PlannedProduction); }
  const state = await sourceState(db, tenant, values); return state.current && state.digest === content.sourceStateDigest;
 }
 return true;
}
async function writeShow(db: PoolClient, before: ShowSnapshot, next: ShowSnapshot) {
 if (before.tenantId !== next.tenantId || before.revision + 1 !== next.revision) throw new Error("Invalid planning admission transition");
 await db.query("UPDATE on_shows SET snapshot=$2,revision=$3,updated_at=clock_timestamp() WHERE tenant_id=$1", [next.tenantId, next, next.revision]);
 for (const event of next.events.filter(event => !before.events.some(old => old.id === event.id))) await db.query("INSERT INTO on_events(id,tenant_id,revision,event) VALUES($1,$2,$3,$4)", [event.id, next.tenantId, event.revision, event]);
}
function validGraphProof(engine: EngineReport, tasks: ShowSnapshot["tasks"], dependencies: ShowSnapshot["dependencies"]) {
 return engine.status === "passed" && engine.inputDigest === digest({ tasks, dependencies }) && engine.dates.length === tasks.length && tasks.every(task => engine.dates.some(date => date.id === task.id && Date.parse(date.start) === Date.parse(task.start) && Date.parse(date.end) === Date.parse(task.end)));
}
export async function planningWorkbench(authority: InputAuthority): Promise<WorkbenchWorkspace> {
 return inputTransaction(async db => {
  const show = await inputShow(db, authority.actor.tenantId, true), scope = await inputAuthority(db, authority), all = await portfolioLock(db, show.tenantId), now = await inputNow(db);
  const saved = (await db.query("SELECT * FROM on_planning_workbench_reviews WHERE tenant_id=$1 ORDER BY created_at DESC,id", [show.tenantId])).rows;
  const reviews: WorkbenchWorkspace["reviews"] = [];
  for (const row of saved) {
   const review = openReview(show.tenantId, row), admitted = (await db.query("SELECT command_id FROM on_planning_workbench_admissions WHERE tenant_id=$1 AND review_id=$2", [show.tenantId, row.id])).rows[0];
   // Historical reviews remain inspectable by this production's producer; only the original access can recover or admit its command.
   const sameAccess = digest(scope) === digest(review.scope) && row.session_hash === authority.sessionHash;
   const receipt = admitted && sameAccess ? (await readReceipt(db, authority, scope, admitted.command_id))?.receipt ?? null : null;
   const expired = !await inputUnexpired(db, review.expiresAt), current = sameAccess && show.revision === review.baseRevision && workbenchDigest(show) === review.sourceDigest && await sourceCurrent(db, show.tenantId, review, all);
   reviews.push({ review, state: admitted ? "admitted" : expired ? "expired" : current ? "current" : "stale", reason: admitted ? "Separate admission saved. Its downstream approvals and execution stay in their own histories." : expired ? "Original fixed access ended." : current ? null : "The original access, production or source edition changed; this retained review cannot be admitted.", receipt });
  }
  await inputAuthority(db, authority, scope);
  return { version: 1, scope, revision: show.revision, serverAt: now, sourceDigest: workbenchDigest(show), production: { id: show.id, title: show.title, venue: show.venue, showDate: show.showDate, zone: show.zone }, offers: show.offers.map(({ id, supplier, revision, source }) => ({ id, supplier, revision, source })), tasks: show.tasks.map(({ id, name, start, end, resources, requiredSkill, state, cancellation, lane, milestone }) => ({ id, name, start, end, resources, requiredSkill, mutable: state !== "complete" && !cancellation && lane !== "commercial" && !milestone })), people: show.resources.filter(row => row.kind === "person").map(({ id, name, skills }) => ({ id, name, skills })), productions: all.filter((row): row is PlannedProduction => row.kind === "production"), tours: all.filter((row): row is Tour => row.kind === "tour"), templates: all.filter((row): row is ProductionTemplate => row.kind === "template"), reviews, currentTourAdmission: show.tourAssignments ?? null, controlled: env.controlledQa };
 });
}
export async function recoverWorkbench(authority: InputAuthority, id: string) {
 return inputTransaction(async db => { await inputShow(db, authority.actor.tenantId, true); const scope = await inputAuthority(db, authority), result = await readReceipt(db, authority, scope, id); if (!result) throw new DomainError("WORKBENCH_COMMAND_MISSING", "No receipt exists for this exact original command and access.", 404); return result; });
}
export async function executeWorkbench(authority: InputAuthority, raw: unknown) {
 const parsed = workbenchEnvelopeSchema.safeParse(raw); if (!parsed.success) throw new DomainError("WORKBENCH_COMMAND_INVALID", "Review the supported typed instruction and its exact access before sending.", 400);
 const envelope: WorkbenchEnvelope = parsed.data;
 return inputTransaction(async db => {
  const show = await inputShow(db, authority.actor.tenantId, true); await inputAuthority(db, authority, envelope.scope);
  const replay = await readReceipt(db, authority, envelope.scope, envelope.commandId, digest(envelope)); if (replay) return replay;
  if (show.revision !== envelope.expectedRevision) throw new DomainError("WORKBENCH_REVISION_CHANGED", "The production changed. Review current sources before a new instruction.");
  const command = envelope.command, all = await portfolioLock(db, show.tenantId); let review: WorkbenchReview, result: WorkbenchReceipt["result"];
  if (command.type.endsWith(".preview")) {
   let content: ReviewContent;
   if (command.type === "strategies.preview") {
    if (!show.incidents.length) throw new DomainError("STRATEGY_INCIDENT_REQUIRED", "Review the incident sources before comparing recovery strategies.");
    const candidates = await evaluateCandidates(enumerateStrategies(show, command.request)); content = { kind: "strategies", request: command.request, candidates, metrics: strategyMetrics(candidates, show.doorsAt) };
   } else if (command.type === "tour.preview") {
    const tour = exact(all, command.tourId, "tour", command.tourDigest), production = exact(all, command.productionId, "production", command.productionDigest);
    const productions = all.filter((row): row is PlannedProduction => row.kind === "production"), source = await sourceState(db, show.tenantId, productions.filter(row => tour.productionIds.includes(row.id)));
    const projection = assignmentProjection(show, production, tour, command.mapping), report = await evaluateWithEngine(tour, productions, source.current, all), engine = await commitGraphEngine(projection.tasks, show.dependencies, show.zone);
    content = { kind: "tour", tour, production, portfolio: all.map(binding), mapping: command.mapping, sourceDigest: source.digest, report, ...projection, beforeTasks: structuredClone(show.tasks), engine };
   } else if (command.type === "learning.preview") {
    const productions = command.productions.map(row => exact(all, row.id, "production", row.digest));
    const state = await sourceState(db, show.tenantId, productions); if (!state.current) throw new DomainError("WORKBENCH_SOURCE_CHANGED", "Review the current source editions before preparing reusable requirements.");
    content = { kind: "learning", proposal: learningProposal(productions, command.name), sourceStateDigest: state.digest };
   } else throw new DomainError("WORKBENCH_COMMAND_INVALID", "Unsupported preview.", 400);
   review = await saveReview(db, authority, envelope, show, content);
   result = { reviewId: review.id, digest: review.digest, revision: show.revision, admitted: false, message: "The exact preview is retained. Review its differences, uncertainty and source lineage before a separate admission." };
  } else {
   if (!("reviewId" in command)) throw new DomainError("WORKBENCH_COMMAND_INVALID", "A retained review is required.", 400);
   const saved = await reviewById(db, show.tenantId, command.reviewId); review = saved.review;
   if (review.digest !== command.reviewDigest || digest(review.scope) !== digest(envelope.scope) || saved.row.session_hash !== authority.sessionHash || review.baseRevision !== show.revision || review.sourceDigest !== workbenchDigest(show) || !await inputUnexpired(db, review.expiresAt) || !await sourceCurrent(db, show.tenantId, review, all)) throw new DomainError("WORKBENCH_REVIEW_CHANGED", "This exact review, fixed original authority or its source edition is no longer current.");
   if ((await db.query("SELECT 1 FROM on_planning_workbench_admissions WHERE tenant_id=$1 AND review_id=$2", [show.tenantId, review.id])).rowCount) throw new DomainError("WORKBENCH_ALREADY_ADMITTED", "That exact review already has an admission. Read its retained original receipt.");
   result = { reviewId: review.id, digest: review.digest, revision: show.revision, admitted: true, message: "" };
   if (command.type === "strategies.admit" && review.content.kind === "strategies") {
    const candidates = review.content.candidates;
    if (candidates.some(candidate => candidate.strategy?.sourceDigest !== strategyScopeDigest(show))) throw new DomainError("WORKBENCH_SOURCE_CHANGED", "The strategy's exact source constraints changed.");
    // Revalidate real-time quote expiry without repeating unchanged native engine work.
    const current = candidates.map(candidate => { const next = structuredClone(candidate), offer = show.offers.find(row => row.id === candidate.patch.offerId)!; const checked = validatePatch(show, candidate.patch, offer); for (const issue of checked.issues) if (!next.report.issues.some(row => row.code === issue.code && row.taskId === issue.taskId && row.resourceId === issue.resourceId)) next.report.issues.push(issue); if (next.report.issues.some(row => row.severity === "hard")) next.report.status = "infeasible"; else if (next.report.issues.some(row => row.severity === "unknown")) next.report.status = "unknown_pending_evidence"; return next; });
    const next = recordRescueRun(show, authority.actor, current, await inputNow(db)); await writeShow(db, show, next); result.revision = next.revision; result.message = "The reviewed alternatives are in Recovery studio. Every rejection and unknown is retained; plan approval, artist consent and commitments remain separate.";
   } else if (command.type === "tour.admit" && review.content.kind === "tour") {
    const content = review.content, projection = assignmentProjection(show, content.production, content.tour, content.mapping), productions = all.filter((row): row is PlannedProduction => row.kind === "production"), report = evaluateTour(content.tour, productions), other = portfolioFindings(content.tour, productions.filter(row => content.tour.productionIds.includes(row.id)), all);
    if (content.report.hard.length || content.report.unknown.length || content.report.engine?.status !== "passed" || report.hard.length || report.unknown.length || other.some(row => row.severity !== "approval") || projection.issues.length || digest(projection.tasks) !== digest(content.tasks) || !validGraphProof(content.engine, content.tasks, show.dependencies)) throw new DomainError("TOUR_ADMISSION_BLOCKED", "Both the complete current tour and this operating assignment must have clear hard constraints, source evidence and matching real engine proofs.");
    if (digest([...new Set(command.acceptedFindingIds)].sort()) !== digest(content.report.approvals.map(row => row.id).sort())) throw new DomainError("TOUR_ADMISSION_REVIEW", "Review every exact named tour assumption and change before assignment admission.");
    const at = await inputNow(db), next = structuredClone(show), state = { version: 1 as const, reviewId: review.id, admittedAtRevision: show.revision + 1, admittedAt: at, actorId: authority.actor.id, target: { tenantId: show.tenantId, showId: show.id }, tour: binding(content.tour), production: binding(content.production), assignments: content.assignments };
    next.tasks = projection.tasks; next.tourAssignments = { ...state, digest: digest(state) }; next.state = "standby"; next.goReportId = null;
    appendEvent(next, authority.actor, "tour.assignments_admitted", "Admitted exact source-reviewed tour assignments into this production. The previous plan and crew publication remain historical; fresh plan review, publication and personal readbacks are required.", at); next.revision++; next.updatedAt = at; await writeShow(db, show, next); result.revision = next.revision; result.message = "Assignments admitted to this explicitly bound production. Review a fresh plan and publish current calls before crew readback or GO; other tour legs remain unchanged.";
   } else if (command.type === "learning.admit" && review.content.kind === "learning") {
    const at = await inputNow(db), proposal = review.content.proposal, template: ProductionTemplate = { id: randomUUID(), kind: "template", revision: 1, digest: "", archived: false, createdAt: at, updatedAt: at, actorId: authority.actor.id, reason: "Reviewed source-bound planning observations as new reusable requirements; no operational authority inherited", spec: proposal.spec, origin: "authored", compilerBinding: null, learningLineage: { reviewId: review.id, reviewDigest: review.digest, productions: proposal.lineage, basis: proposal.basis } };
    template.digest = recordDigest(template); await saveRecord(db, show.tenantId, template, envelope.commandId); result.templateId = template.id; result.message = "New requirements template saved with its exact learning lineage. Instantiation starts with unassigned roles and empty operating and commercial evidence.";
   } else throw new DomainError("WORKBENCH_REVIEW_KIND", "The admission must match the kind of its exact retained preview.");
  }
  const receipt = await saveReceipt(db, authority, envelope, result);
  // Check PostgreSQL's current clock after every possible lock wait and write, before commit.
  await inputAuthority(db, authority, envelope.scope); return receipt;
 });
}
