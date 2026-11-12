import { randomUUID } from "node:crypto";
import { controlledPresentation } from "../judge/presentation";
import { DomainError } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { tourCommandSchema, type TourCommand, type TourRecord, type ProductionTemplate, type PlannedProduction, type Tour, type TourWorkspace, type PersonalTour, type TourReceipt, type PlanningSource, type TemplateSpec } from "@/domain/tour/contracts";
import { emptyStage, instantiate, obligationDigest, recordDigest, resourcesForCall, sourceTemplate, validateStage, validateTemplate, venueFromInput } from "@/domain/tour/templates";
import { evaluateTour, validateTour, finding, portfolioFindings } from "@/domain/tour/constraints";
import { touringTemplate } from "@/domain/tour/fixture";
import { fromInstant, dateAfter } from "@/domain/tour/time";
import { compilationForProductionAdmission } from "../sources/compiler";
import { env } from "../env";
import { active, acknowledgments, commandReceipt, decodeRecord, expected, openReceipt, record, records, saveRecord, sealReceipt, sourceState, tourTransaction, type TourAuthority, type TourContext } from "./store";
import { applyComparison, createComparison, evolve, reportStatus } from "./comparisons";
import { decideSwap, requestSwap } from "./swaps";

function producer(context: TourContext) { if (context.authority.actor.personId || !context.authority.actor.roles.includes("producer")) throw new DomainError("TOUR_PRODUCER_REQUIRED", "The producer reviews library changes and tour commitments.", 403); }
function fresh(actorId: string, at: string, reason: string) { return { id: randomUUID(), revision: 1, digest: "", archived: false, createdAt: at, updatedAt: at, actorId, reason }; }
const manualSource = (): PlanningSource => ({ id: "planning-brief", title: "New production planning brief", kind: "manual", status: "unknown", version: 1, contentHash: null, documentId: null, locator: null, note: "No source graph, roster, technical sign-off or commercial evidence has been admitted." });
function retainedDocumentSources(sources: PlanningSource[], retained: PlanningSource[] = []) {
  for (const source of sources) if (source.kind === "source_document" || source.documentId || source.unitId) {
    if (!retained.some(value => digest(value) === digest(source))) throw new DomainError("TOUR_SOURCE_ADMISSION_REQUIRED", "Admit document provenance through the exact reviewed compiler. Authored edits cannot invent or change an original document, version, hash or citation.", 400);
  }
}
function rootResources(context: TourContext, tour: Tour) {
  for (const resource of tour.resources) if (resource.kind === "person" && resource.personId) {
    const person = context.root.resources.find(value => value.id === resource.personId && value.kind === "person");
    if (!person || resource.id !== person.id) throw new DomainError("TOUR_ROSTER_IDENTITY", "Shared people must retain their current admitted roster identity.", 400);
    if (digest([...resource.skills].sort()) !== digest([...person.skills].sort()) || resource.label !== person.name) throw new DomainError("TOUR_ROSTER_QUALIFICATION", "A tour cannot invent a person's name or qualification. Use their current admitted roster record.", 400);
  }
}
async function compilation(context: TourContext, action: Extract<TourCommand["action"], { type: "template.from_compiler" | "production.from_compiler" }>) {
  const saved = await compilationForProductionAdmission(context.db, context.authority, action.compilationId, action.compilationDigest);
  if (digest([...new Set(action.reviewedSourceIds)].sort()) !== digest(saved.documents.map(doc => doc.id).sort()) || digest([...new Set(action.acceptedAssumptionIds)].sort()) !== digest(saved.review.assumptions.map(assumption => assumption.id).sort())) throw new DomainError("TOUR_SOURCE_REVIEW_REQUIRED", "Review all exact source editions and every named assumption in this compiler result.");
  return { ...saved, spec: sourceTemplate(saved.review, saved.documents, saved.binding) };
}
async function mutate(context: TourContext, command: TourCommand, at: string): Promise<{ values: TourRecord[]; acknowledgmentId?: string }> {
  const { db, authority } = context, tenant = authority.actor.tenantId, action = command.action;
  if (action.type === "swap.request") return { values: [await requestSwap(context, action, at)] };
  if (action.type === "swap.decide") return { values: await decideSwap(context, action, at) };
  if (action.type === "personal.acknowledge") {
    if (!authority.actor.personId) throw new DomainError("TOUR_PERSON_REQUIRED", "Only the assigned person's own capability records a readback.", 403);
    const production = await record(db, tenant, action.productionId, "production"); active(production);
    const call = production.calls.find(call => call.id === action.callId), all = await records(db, tenant);
    const resourceIds = all.filter((value): value is Tour => value.kind === "tour" && !value.archived && value.productionIds.includes(production.id)).flatMap(value => value.resources.filter(resource => resource.personId === authority.actor.personId).map(resource => resource.id));
    const assigned = call && resourcesForCall(production, call).find(id => resourceIds.includes(id));
    if (!call || !assigned) throw new DomainError("TOUR_PERSON_ASSIGNMENT", "This call is not currently assigned to you.", 403);
    if (obligationDigest(production, call, assigned) !== action.obligationDigest) throw new DomainError("TOUR_READBACK_STALE", "This call or assignment changed. Read the current instruction before acknowledging it.");
    const acknowledgmentId = randomUUID();
    await db.query("INSERT INTO on_tour_acknowledgments(tenant_id,id,person_id,production_id,call_id,obligation_digest,actor_id,command_id,at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [tenant, acknowledgmentId, authority.actor.personId, production.id, call.id, action.obligationDigest, authority.actor.id, command.commandId, at]);
    return { values: [], acknowledgmentId };
  }
  if (action.type !== "comparison.create") producer(context);
  if (action.type === "template.create") { retainedDocumentSources(action.spec.sources); return { values: [{ ...fresh(authority.actor.id, at, "Created a reviewed reusable requirements graph"), kind: "template", spec: validateTemplate(action.spec), origin: action.spec.sources.every(source => source.kind === "fixture") ? "synthetic_fixture" : "authored", compilerBinding: null }] }; }
  if (action.type === "template.revise") { const value = await record(db, tenant, action.id, "template"); active(value); expected(value, action.expectedRevision); retainedDocumentSources(action.spec.sources, value.spec.sources); return { values: [{ ...evolve(value, authority.actor.id, action.reason, at), spec: validateTemplate(action.spec) }] }; }
  if (action.type === "template.from_compiler" || action.type === "production.from_compiler") {
    const saved = await compilation(context, action), template: ProductionTemplate = { ...fresh(authority.actor.id, at, "Admitted the exact reviewed compiler graph as reusable requirements"), kind: "template", spec: saved.spec, origin: "reviewed_compiler", compilerBinding: saved.binding }; template.digest = recordDigest(template);
    if (action.type === "template.from_compiler") return { values: [template] };
    const graph = saved.review.graph;
    if (!graph.production.title.value || !graph.production.venue.value || !graph.production.zone.value || !graph.production.showDate.value) throw new DomainError("TOUR_PRODUCTION_IDENTITY_UNKNOWN", "Confirm the production title, venue, IANA zone and show date in the source graph before admission.");
    const zone = graph.production.zone.value;
    const value = instantiate(template, randomUUID(), graph.production.title.value, graph.production.showDate.value, { name: graph.production.venue.value, city: "Not supplied", zone, access: null, curfew: graph.policy.curfewAt.value ? fromInstant(graph.policy.curfewAt.value, zone) : null, accessUntil: graph.policy.accessUntil.value ? fromInstant(graph.policy.accessUntil.value, zone) : null, sourceIds: saved.documents.map(doc => doc.id) }, authority.actor.id, at);
    value.origin = "source_imported"; value.template = null; value.reason = "Created a distinct source-imported production with empty operational and commercial evidence";
    return { values: [value] };
  }
  if (action.type === "production.instantiate") {
    const template = await record(db, tenant, action.templateId, "template"); active(template); expected(template, action.templateRevision);
    if (template.digest !== action.templateDigest) throw new DomainError("TOUR_TEMPLATE_CHANGED", "This template digest changed. Inspect its current frozen edition.");
    if (!(await sourceState(db, tenant, [template])).current) throw new DomainError("TOUR_SOURCE_STALE", "The source behind this template changed. Review a new template edition before instantiating it.");
    return { values: [instantiate(template, randomUUID(), action.name, action.showDate, action.venue, authority.actor.id, at, action.foldChoice)] };
  }
  if (action.type === "production.demo") {
    const template: ProductionTemplate = { ...fresh(authority.actor.id, at, "Explicit fictional production example"), kind: "template", spec: touringTemplate(), origin: "synthetic_fixture", compilerBinding: null }; template.digest = recordDigest(template);
    const value = instantiate(template, randomUUID(), action.name, action.showDate, action.venue, authority.actor.id, at, action.foldChoice); value.origin = "demo"; value.template = null; value.reason = "Created an explicitly fictional sample production with unassigned roles and empty operational and commercial evidence"; return { values: [value] };
  }
  if (action.type === "production.create") {
    dateAfter(action.showDate, 0);
    return { values: [{ ...fresh(authority.actor.id, at, "Created an empty planning production; no prior show authority was copied"), kind: "production", name: action.name, origin: "blank", showDate: action.showDate, venue: venueFromInput(action.venue), template: null, compilerBinding: null, slots: [], calls: [], dependencies: [], allocations: {}, assignmentOverrides: {}, minimumRestMinutes: null, maxDutyMinutes: null, sources: [manualSource()], unknowns: [{ id: "source-graph-required", label: "Admit a source graph or author the production requirements before comparing routes.", hard: true, sourceIds: ["planning-brief"] }], stage: emptyStage(), operationalEvidence: [], commercialEvidence: [] }] };
  }
  if (action.type === "production.revise") {
    const value = await record(db, tenant, action.id, "production"); active(value); expected(value, action.expectedRevision);
    const spec = validateTemplate(action.spec);
    retainedDocumentSources(spec.sources, value.sources);
    if (value.minimumRestMinutes != null && (spec.minimumRestMinutes == null || spec.minimumRestMinutes < value.minimumRestMinutes) || value.maxDutyMinutes != null && (spec.maxDutyMinutes == null || spec.maxDutyMinutes > value.maxDutyMinutes)) throw new DomainError("TOUR_HARD_POLICY_RELAXATION", "This planning edit cannot quietly relax established rest or duty limits. Preserve the hard policy in a new reviewed graph.");
    const temporary: ProductionTemplate = { ...fresh(authority.actor.id, at, action.reason), kind: "template", spec, origin: "authored", compilerBinding: null };
    const changed = instantiate(temporary, value.id, value.name, value.showDate, action.venue, authority.actor.id, at, action.foldChoice);
    for (const prior of value.calls) { const next = changed.calls.find(call => call.id === prior.id); if (next && (prior.earliest && (!next.earliest || Date.parse(next.earliest.instant) < Date.parse(prior.earliest.instant)) || prior.latest && (!next.latest || Date.parse(next.latest.instant) > Date.parse(prior.latest.instant)))) throw new DomainError("TOUR_HARD_POLICY_RELAXATION", "Retain the source-defined earliest and latest call windows when reviewing this production."); }
    if (value.venue.curfew && (!changed.venue.curfew || Date.parse(changed.venue.curfew.instant) > Date.parse(value.venue.curfew.instant)) || value.venue.accessUntil && (!changed.venue.accessUntil || Date.parse(changed.venue.accessUntil.instant) > Date.parse(value.venue.accessUntil.instant)) || value.venue.access && (!changed.venue.access || Date.parse(changed.venue.access.instant) < Date.parse(value.venue.access.instant))) throw new DomainError("TOUR_HARD_POLICY_RELAXATION", "An established venue curfew or final access limit cannot become a preference in this edit.");
    return { values: [{ ...evolve(value, authority.actor.id, action.reason, at), venue: changed.venue, slots: changed.slots, calls: changed.calls, dependencies: changed.dependencies, minimumRestMinutes: changed.minimumRestMinutes, maxDutyMinutes: changed.maxDutyMinutes, sources: changed.sources, unknowns: changed.unknowns, stage: changed.stage, allocations: Object.fromEntries(Object.entries(value.allocations).filter(([slot]) => spec.slots.some(value => value.id === slot))), assignmentOverrides: Object.fromEntries(Object.entries(value.assignmentOverrides).filter(([call]) => spec.calls.some(value => value.id === call))) }] };
  }
  if (action.type === "production.allocate") {
    const value = await record(db, tenant, action.id, "production"); active(value); expected(value, action.expectedRevision);
    const all = await records(db, tenant), tours = all.filter((record): record is Tour => record.kind === "tour" && !record.archived && record.productionIds.includes(value.id));
    for (const [slotId, resourceId] of Object.entries(action.allocations)) if (!value.slots.some(slot => slot.id === slotId) || !tours.some(tour => tour.resources.some(resource => resource.id === resourceId))) throw new DomainError("TOUR_ALLOCATION_SCOPE", "Allocate retained slots only to resources in this production's active tour.", 400);
    return { values: [{ ...evolve(value, authority.actor.id, action.reason, at), allocations: action.allocations }] };
  }
  if (action.type === "production.stage") {
    const value = await record(db, tenant, action.id, "production"); active(value); expected(value, action.expectedRevision); validateStage(action.stage, value.slots.map(slot => slot.id), value.calls.map(call => call.id), value.sources.map(source => source.id));
    if (action.stage.status === "reviewed_source" && action.stage.sourceIds.some(id => value.sources.find(source => source.id === id)?.status !== "reviewed")) throw new DomainError("TOUR_STAGE_SOURCE_UNREVIEWED", "Measured dimensions require reviewed source evidence. Keep the stage marked illustrative or needing review while its source is assumed or unknown.");
    return { values: [{ ...evolve(value, authority.actor.id, action.reason, at), stage: action.stage }] };
  }
  if (action.type === "tour.create" || action.type === "tour.revise") {
    const all = await records(db, tenant), productions = all.filter((value): value is PlannedProduction => value.kind === "production");
    retainedDocumentSources(action.draft.sources, all.flatMap(value => value.kind === "template" ? value.spec.sources : value.kind === "production" ? value.sources : []));
    validateTour(action.draft, productions);
    let tour: Tour;
    if (action.type === "tour.revise") { const prior = await record(db, tenant, action.id, "tour"); active(prior); expected(prior, action.expectedRevision); if (action.draft.minimumRestMinutes < prior.minimumRestMinutes || action.draft.maxDutyMinutes > prior.maxDutyMinutes) throw new DomainError("TOUR_HARD_POLICY_RELAXATION", "Route revisions preserve established hard rest and duty limits."); tour = { ...evolve(prior, authority.actor.id, action.reason, at), ...action.draft }; }
    else tour = { ...fresh(authority.actor.id, at, "Created an explicit tour with source-labelled travel inputs"), kind: "tour", ...action.draft };
    rootResources(context, tour); return { values: [tour] };
  }
  if (action.type === "record.archive") {
    const value = (await records(db, tenant)).find(value => value.id === action.id);
    if (!value) throw new DomainError("TOUR_RECORD_NOT_FOUND", "This planning record is not in your library.", 404); expected(value, action.expectedRevision);
    if (value.kind === "comparison" || value.kind === "swap") throw new DomainError("TOUR_HISTORY_REQUIRED", "Comparisons and crew decisions remain visible in retained history.");
    if (value.kind === "production" && action.archived && (await records(db, tenant)).some(item => item.kind === "tour" && !item.archived && item.productionIds.includes(value.id))) throw new DomainError("TOUR_MEMBERSHIP_ACTIVE", "Remove this show from its active tour before archiving it. Existing editions will remain available.");
    return { values: [{ ...evolve(value, authority.actor.id, action.reason, at), archived: action.archived }] };
  }
  if (action.type === "comparison.create") return { values: [await createComparison(context, action.tourId, action.expectedRevision, action.alternatives, at)] };
  if (action.type === "comparison.apply") return { values: await applyComparison(context, action.comparisonId, action.comparisonDigest, action.candidateId, action.acceptedFindingIds, command.commandId, at) };
  throw new DomainError("TOUR_COMMAND_UNKNOWN", "This planning action is unavailable.", 400);
}
export async function executeTour(authority: TourAuthority, raw: unknown) {
  const parsed = tourCommandSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError("TOUR_COMMAND_INVALID", "The planning instruction is incomplete or includes unsupported authority. Review its required fields.", 400);
  const command = parsed.data, personal = Boolean(authority.actor.personId), payloadHash = digest({ actor: authority.actor, sessionHash: authority.sessionHash, command });
  return tourTransaction(authority, personal, true, async context => {
    const previous = (await context.db.query("SELECT * FROM on_tour_commands WHERE tenant_id=$1 AND command_id=$2", [authority.actor.tenantId, command.commandId])).rows[0];
    if (previous) {
      if (previous.payload_hash !== payloadHash || previous.actor_id !== authority.actor.id || previous.session_hash !== authority.sessionHash) throw new DomainError("TOUR_COMMAND_CHANGED", "This command identity is already bound to different content or another session. Recover its original result.");
      return { receipt: openReceipt(authority.actor.tenantId, command.commandId, previous.receipt_cipher), replayed: true };
    }
    const at = new Date().toISOString(), result = await mutate(context, command, at);
    for (const value of result.values) await saveRecord(context.db, authority.actor.tenantId, value, command.commandId);
    const receipt: TourReceipt = { commandId: command.commandId, action: command.action.type, actorId: authority.actor.id, at, records: result.values.map(value => ({ id: value.id, kind: value.kind, revision: value.revision, digest: value.digest })), ...(result.acknowledgmentId ? { acknowledgmentId: result.acknowledgmentId } : {}) };
    await context.db.query("INSERT INTO on_tour_commands(tenant_id,command_id,actor_id,session_hash,payload_hash,action,receipt_cipher) VALUES($1,$2,$3,$4,$5,$6,$7)", [authority.actor.tenantId, command.commandId, authority.actor.id, authority.sessionHash, payloadHash, command.action.type, sealReceipt(authority.actor.tenantId, receipt)]);
    return { receipt, replayed: false };
  });
}
export async function readTourWorkspace(authority: TourAuthority): Promise<TourWorkspace> {
  return tourTransaction(authority, false, false, async context => {
    const all = await records(context.db, authority.actor.tenantId), readbacks: TourWorkspace["readbacks"] = [], savedAcks = await acknowledgments(context.db, authority.actor.tenantId);
    for (const tour of all.filter((value): value is Tour => value.kind === "tour" && !value.archived)) for (const production of all.filter((value): value is PlannedProduction => value.kind === "production" && !value.archived && tour.productionIds.includes(value.id))) for (const call of production.calls) for (const resourceId of resourcesForCall(production, call)) { const personId = tour.resources.find(resource => resource.id === resourceId)?.personId; if (personId) { const obligation = obligationDigest(production, call, resourceId); readbacks.push({ productionId: production.id, callId: call.id, resourceId, personId, obligationDigest: obligation, current: savedAcks.some(ack => ack.personId === personId && ack.productionId === production.id && ack.callId === call.id && ack.obligationDigest === obligation) }); } }
    const history = await context.db.query("SELECT command_id,receipt_cipher FROM on_tour_commands WHERE tenant_id=$1 ORDER BY created_at DESC,command_id LIMIT 100", [authority.actor.tenantId]);
    return { tenantId: authority.actor.tenantId, actorId: authority.actor.id, sessionFingerprint: digest(authority.sessionHash), expiresAt: context.expiresAt, templates: all.filter((value): value is ProductionTemplate => value.kind === "template"), productions: all.filter((value): value is PlannedProduction => value.kind === "production"), tours: all.filter((value): value is Tour => value.kind === "tour"), readbacks, reports: Object.fromEntries(all.filter((value): value is Tour => value.kind === "tour" && !value.archived).map(tour => { const productions = all.filter((value): value is PlannedProduction => value.kind === "production"); const report = evaluateTour(tour, productions); for (const issue of portfolioFindings(tour, productions.filter(value => tour.productionIds.includes(value.id)), all)) (issue.severity === "hard" ? report.hard : report.unknown).push(issue); return [tour.id, reportStatus(report)]; })), comparisons: all.filter((value): value is Extract<TourRecord, { kind: "comparison" }> => value.kind === "comparison"), swaps: all.filter((value): value is Extract<TourRecord, { kind: "swap" }> => value.kind === "swap"), acknowledgments: await acknowledgments(context.db, authority.actor.tenantId), roster: context.root.resources.filter(resource => resource.kind === "person").map(resource => ({ id: resource.id, name: resource.name, skills: resource.skills })), history: history.rows.map(row => openReceipt(authority.actor.tenantId, row.command_id, row.receipt_cipher)), controlled: controlledPresentation(context.root) };
  });
}
export async function readTourEdition(authority: TourAuthority, id: string, revision: number) {
  return tourTransaction(authority, false, false, async context => { const row = (await context.db.query("SELECT * FROM on_tour_editions WHERE tenant_id=$1 AND record_id=$2 AND revision=$3", [authority.actor.tenantId, id, revision])).rows[0]; if (!row) throw new DomainError("TOUR_EDITION_NOT_FOUND", "This retained edition is not in your current library.", 404); return decodeRecord(authority.actor.tenantId, row); });
}
export async function recoverTourCommand(authority: TourAuthority, id: string) { return tourTransaction(authority, Boolean(authority.actor.personId), false, async context => (await commandReceipt(context, id)).receipt); }
export async function readPersonalTour(authority: TourAuthority): Promise<PersonalTour> {
  return tourTransaction(authority, true, false, async context => {
    const all = await records(context.db, authority.actor.tenantId), personId = authority.actor.personId!, person = context.root.resources.find(value => value.id === personId)!;
    const tours = all.filter((value): value is Tour => value.kind === "tour" && !value.archived && value.resources.some(resource => resource.personId === personId)), productions = all.filter((value): value is PlannedProduction => value.kind === "production" && !value.archived), acks = (await acknowledgments(context.db, authority.actor.tenantId)).filter(ack => ack.personId === personId);
    const calls: PersonalTour["calls"] = [], rests: PersonalTour["rests"] = [], colleagues: PersonalTour["colleagues"] = [];
    for (const tour of tours) {
      const resource = tour.resources.find(resource => resource.personId === personId)!;
      for (const production of productions.filter(production => tour.productionIds.includes(production.id))) for (const call of production.calls.filter(call => resourcesForCall(production, call).includes(resource.id))) {
        const obligation = obligationDigest(production, call, resource.id);
        calls.push({ productionId: production.id, productionName: production.name, venue: production.venue.name, zone: production.venue.zone, productionRevision: production.revision, call: { id: call.id, label: call.label, start: call.start, end: call.end, lane: call.lane }, obligationDigest: obligation, acknowledged: acks.some(ack => ack.productionId === production.id && ack.callId === call.id && ack.obligationDigest === obligation), resourceId: resource.id, tourId: tour.id, tourRevision: tour.revision });
      }
      rests.push(...evaluateTour(tour, productions).rests.filter(rest => rest.resourceId === resource.id));
      colleagues.push(...tour.resources.filter(resource => resource.personId && resource.personId !== personId).map(resource => ({ id: resource.id, name: resource.label, tourId: tour.id })));
    }
    const swaps = all.filter((value): value is Extract<TourRecord, { kind: "swap" }> => value.kind === "swap" && (value.requesterPersonId === personId || value.recipientPersonId === personId)).map(swap => { const production = productions.find(value => value.id === swap.productionId); return { id: swap.id, revision: swap.revision, state: swap.state, tourId: swap.tourId, productionId: swap.productionId, callId: swap.callId, fromResourceId: swap.fromResourceId, toResourceId: swap.toResourceId, reverseOf: swap.reverseOf, productionName: production?.name ?? "Archived production", callLabel: production?.calls.find(call => call.id === swap.callId)?.label ?? "Retained call", requester: context.root.resources.find(person => person.id === swap.requesterPersonId)?.name ?? "Original requester", recipient: context.root.resources.find(person => person.id === swap.recipientPersonId)?.name ?? "Original recipient", isRequester: swap.requesterPersonId === personId, isRecipient: swap.recipientPersonId === personId, decisions: swap.decisions, issues: [...swap.report.hard, ...swap.report.unknown].map(issue => issue.resourceIds.includes(personId) || issue.productionIds.length && issue.productionIds.every(id => id === swap.productionId) && (!issue.resourceIds.length || issue.resourceIds.every(id => id === swap.fromResourceId || id === swap.toResourceId)) ? { ...issue, resourceIds: issue.resourceIds.filter(id => id === personId), productionIds: issue.productionIds.filter(id => id === swap.productionId), sourceIds: [] } : finding("OTHER_TOUR_REQUIREMENT", issue.severity, "Another bound tour requirement needs production review before this swap can proceed.", [], [], [], [])).filter((issue, index, values) => values.findIndex(value => value.id === issue.id) === index) }; });
    return { tenantId: authority.actor.tenantId, sessionFingerprint: digest(authority.sessionHash), person: { id: personId, name: person.name }, actorId: authority.actor.id, expiresAt: context.expiresAt, calls: [...new Map(calls.map(call => [`${call.productionId}:${call.call.id}`, call])).values()].sort((a, b) => a.call.start.instant.localeCompare(b.call.start.instant)), rests, swaps, colleagues, history: acks.map(ack => ({ id: ack.id, at: ack.at, productionId: ack.productionId, callId: ack.callId, current: calls.some(call => call.productionId === ack.productionId && call.call.id === ack.callId && call.obligationDigest === ack.obligationDigest) })), controlled: controlledPresentation(context.root) };
  });
}
