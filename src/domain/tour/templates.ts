import { DomainError } from "../contracts";
import { digest } from "../hash";
import type { CompilerReview, SourceDocument } from "../sources";
import { templateSpecSchema, type TemplateSpec, type ProductionTemplate, type PlannedProduction, type VenueInput, type PlanningVenue, type StagePlan, type PlanningSource, type CompilerBinding, type ProductionCall } from "./contracts";
import { dateAfter, zoned, plusMinutes } from "./time";

export const emptyStage = (): StagePlan => ({ width: null, depth: null, units: "normalized", status: "illustrative", sourceIds: [], pins: [] });
export function assertUnique(values: string[], description: string) { if (new Set(values).size !== values.length) throw new DomainError("TOUR_DUPLICATE_REFERENCE", `Use each ${description} once.`, 400); }
export function validateTemplate(raw: TemplateSpec): TemplateSpec {
  const spec = templateSpecSchema.parse(raw);
  assertUnique(spec.slots.map(slot => slot.id), "resource slot"); assertUnique(spec.calls.map(call => call.id), "call"); assertUnique(spec.dependencies.map(edge => edge.id), "dependency"); assertUnique(spec.sources.map(source => source.id), "source"); assertUnique(spec.unknowns.map(issue => issue.id), "unknown requirement");
  const sources = new Set(spec.sources.map(source => source.id)), slots = new Set(spec.slots.map(slot => slot.id)), calls = new Set(spec.calls.map(call => call.id));
  for (const item of [...spec.slots, ...spec.calls, ...spec.dependencies, ...spec.unknowns, spec.stage, ...spec.stage.pins]) for (const sourceId of item.sourceIds) if (!sources.has(sourceId)) throw new DomainError("TOUR_SOURCE_REFERENCE", "A planning requirement names a source outside this frozen edition.", 400);
  for (const call of spec.calls) { assertUnique(call.slotIds, "call resource slot"); if (call.slotIds.some(slot => !slots.has(slot))) throw new DomainError("TOUR_SLOT_REFERENCE", "Every call resource must refer to a retained slot.", 400); }
  for (const edge of spec.dependencies) if (!calls.has(edge.from) || !calls.has(edge.to) || edge.from === edge.to) throw new DomainError("TOUR_DEPENDENCY_REFERENCE", "Every dependency must connect two different retained calls.", 400);
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string) { if (visiting.has(id)) throw new DomainError("TOUR_DEPENDENCY_CYCLE", "The planning graph contains a dependency cycle.", 400); if (visited.has(id)) return; visiting.add(id); for (const edge of spec.dependencies.filter(edge => edge.from === id)) visit(edge.to); visiting.delete(id); visited.add(id); }
  for (const call of spec.calls) visit(call.id);
  validateStage(spec.stage, spec.slots.map(s => s.id), spec.calls.map(c => c.id), [...sources]);
  return spec;
}
export function validateStage(stage: StagePlan, slots: string[], calls: string[], sources: string[]) {
  assertUnique(stage.pins.map(pin => pin.id), "stage pin");
  if (stage.sourceIds.some(id => !sources.includes(id))) throw new DomainError("TOUR_SOURCE_REFERENCE", "Stage dimensions must refer to a retained source.", 400);
  for (const pin of stage.pins) {
    if (pin.slotId && !slots.includes(pin.slotId) || pin.callId && !calls.includes(pin.callId)) throw new DomainError("TOUR_STAGE_REFERENCE", "Stage pins must select a retained canonical call or resource.", 400);
    if ((pin.x == null) !== (pin.y == null)) throw new DomainError("TOUR_STAGE_COORDINATES", "A pin needs both coordinates or an explicitly unknown location.", 400);
    if (pin.sourceIds.some(id => !sources.includes(id))) throw new DomainError("TOUR_SOURCE_REFERENCE", "A stage pin names an unavailable source.", 400);
    if (stage.units === "normalized" && (pin.x != null && pin.x > 1 || pin.y != null && pin.y > 1)) throw new DomainError("TOUR_STAGE_COORDINATES", "Illustrative normalized coordinates must be between zero and one.", 400);
    if (stage.units !== "normalized" && (stage.width != null && pin.x != null && pin.x > stage.width || stage.depth != null && pin.y != null && pin.y > stage.depth)) throw new DomainError("TOUR_STAGE_BOUNDS", "A pin lies outside the reviewed stage dimensions.", 400);
  }
  if (stage.status === "reviewed_source" && (stage.width == null || stage.depth == null || stage.units === "normalized" || !stage.sourceIds.length)) throw new DomainError("TOUR_STAGE_REVIEW", "A measured plan needs explicit dimensions, physical units and a retained source.", 400);
}
export function venueFromInput(value: VenueInput): PlanningVenue {
  // Validate the zone even when all venue windows are unknown.
  zoned({ local: "2026-01-01T12:00", zone: value.zone, disambiguation: "reject" });
  const venue = { ...value, access: value.access && zoned(value.access), curfew: value.curfew && zoned(value.curfew), accessUntil: value.accessUntil && zoned(value.accessUntil) };
  for (const time of [venue.access, venue.curfew, venue.accessUntil]) if (time && time.zone !== venue.zone) throw new DomainError("TOUR_VENUE_ZONE", "Venue windows must use the venue's own IANA zone.", 400);
  if (venue.access && venue.accessUntil && Date.parse(venue.access.instant) >= Date.parse(venue.accessUntil.instant)) throw new DomainError("TOUR_VENUE_WINDOW", "Access must begin before the final access window closes.", 400);
  return venue;
}
export function instantiate(template: ProductionTemplate, id: string, name: string, showDate: string, venueInput: VenueInput, actorId: string, at: string, foldChoice: "reject" | "earlier" | "later" = "reject"): PlannedProduction {
  if (template.archived) throw new DomainError("TOUR_TEMPLATE_ARCHIVED", "Restore this template before creating a new production.");
  const spec = validateTemplate(template.spec), venue = venueFromInput(venueInput);
  const relative = (value: { dayOffset: number; localTime: string }) => zoned({ local: `${dateAfter(showDate, value.dayOffset)}T${value.localTime}`, zone: venue.zone, disambiguation: foldChoice });
  const calls = spec.calls.map(({ dayOffset, localTime, earliest, latest, ...call }) => { const start = relative({ dayOffset, localTime }); return { ...structuredClone(call), start, end: plusMinutes(start, call.durationMinutes), earliest: earliest ? relative(earliest) : null, latest: latest ? relative(latest) : null }; });
  const result: PlannedProduction = { id, kind: "production", revision: 1, digest: "", archived: false, createdAt: at, updatedAt: at, actorId, reason: "Instantiated the reviewed template with empty operational and commercial evidence", name, origin: "template_derived", showDate, venue, template: { id: template.id, revision: template.revision, digest: template.digest }, compilerBinding: template.compilerBinding, slots: structuredClone(spec.slots), calls, dependencies: structuredClone(spec.dependencies), allocations: {}, assignmentOverrides: {}, minimumRestMinutes: spec.minimumRestMinutes, maxDutyMinutes: spec.maxDutyMinutes, sources: structuredClone(spec.sources), unknowns: structuredClone(spec.unknowns), stage: structuredClone(spec.stage), operationalEvidence: [], commercialEvidence: [] };
  result.digest = recordDigest(result); return result;
}
export const recordDigest = (record: object) => digest(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "digest")));
export function resourcesForCall(production: PlannedProduction, call: ProductionCall) { return call.slotIds.flatMap(slot => { const id = production.assignmentOverrides[call.id]?.[slot] ?? production.allocations[slot]; return id ? [id] : []; }); }
export function obligationDigest(production: PlannedProduction, call: ProductionCall, resourceId: string) { return digest({ productionId: production.id, call: { id: call.id, label: call.label, start: call.start, end: call.end, requiredSkills: call.requiredSkills, sources: call.sourceIds }, resourceId, assignedSlots: call.slotIds.filter(slot => (production.assignmentOverrides[call.id]?.[slot] ?? production.allocations[slot]) === resourceId).sort() }); }
export function sourceTemplate(review: CompilerReview, documents: SourceDocument[], binding: CompilerBinding): TemplateSpec {
  const graph = review.graph;
  const names = graph.resources.filter(r => r.kind.value === "person").flatMap(r => r.name.value ? [r.name.value] : []);
  const sanitize = (value: string) => names.reduce((text, name) => text.split(name).join("crew role"), value);
  const sources: PlanningSource[] = documents.map(document => ({ id: document.id, title: sanitize(document.title), kind: "source_document", status: "reviewed", version: document.version, contentHash: document.contentHash, documentId: document.id, locator: null, note: `Reviewed immutable source revision ${document.version}; the original remains accessible only through its existing production authority.` }));
  const citationSources = new Map<string, string>();
  for (const citation of review.citations.filter(value => value.valid)) {
    const key = `${citation.citation.sourceId}:${citation.citation.unitId}`; if (citationSources.has(key)) continue;
    const document = documents.find(value => value.id === citation.citation.sourceId); if (!document) continue;
    const unit = document.extraction?.units.find(value => value.id === citation.citation.unitId); if (!unit) continue;
    const id = `citation-${digest(key).slice(0, 32)}`; citationSources.set(key, id);
    const locator = unit.locator.kind === "text" ? `Line ${unit.locator.line}` : unit.locator.kind === "pdf" ? `Page ${unit.locator.page}` : `${unit.locator.sheet} · ${unit.locator.cell}`;
    sources.push({ id, title: `${sanitize(document.title).slice(0, 155)} · ${locator.slice(0, 35)}`, kind: "source_document", status: "reviewed", version: document.version, contentHash: document.contentHash, documentId: document.id, locator, unitId: unit.id, note: "Exact reviewed source locator. Its original bytes and extraction stay under the existing document authority; no personal rates or credentials are copied into these requirements." });
  }
  const assumptionSource: PlanningSource = { id: "compiler-assumptions", title: "Reviewed planning assumptions", kind: "manual", status: "assumption", version: 1, contentHash: binding.digest, documentId: null, locator: null, note: "Explicitly reviewed assumptions retained from this compiler result. They do not establish operational or commercial evidence." };
  if (review.assumptions.length) sources.push(assumptionSource);
  const sourceIds = (facts: { citations: { sourceId: string; unitId: string }[]; assumption: string | null }[]) => [...new Set(facts.flatMap(fact => [...fact.citations.map(citation => citationSources.get(`${citation.sourceId}:${citation.unitId}`) ?? citation.sourceId), ...(fact.assumption ? [assumptionSource.id] : [])]))];
  const unknowns = graph.unknowns.map((issue, index) => ({ id: `source-unknown-${index}`, label: sanitize(`${issue.field}: ${issue.message}`), hard: issue.blocking, sourceIds: [] as string[] }));
  for (const [index, issue] of graph.unsupportedRequirements.entries()) unknowns.push({ id: `source-unsupported-${index}`, label: sanitize(issue.message), hard: true, sourceIds: [...new Set(issue.citations.map(citation => citation.sourceId))] });
  for (const [index, issue] of graph.conflicts.entries()) unknowns.push({ id: `source-conflict-${index}`, label: sanitize(issue.message), hard: true, sourceIds: [...new Set(issue.citations.map(citation => citation.sourceId))] });
  const roleIds = new Map(graph.resources.map((resource, index) => [resource.key, `source-role-${index + 1}`]));
  const slots = graph.resources.flatMap((resource, index) => {
    if (!resource.kind.value) { unknowns.push({ id: `resource-unknown-${index}`, label: `Resource requirement ${index + 1} has no reviewed type. It remains unallocated.`, hard: true, sourceIds: [] }); return []; }
    if (resource.skills.value == null || resource.capacity.value == null) unknowns.push({ id: `resource-requirements-${index}`, label: `Resource requirement ${index + 1} needs reviewed qualifications and capacity. Placeholder capacity cannot establish sufficiency.`, hard: true, sourceIds: sourceIds([resource.skills, resource.capacity]) });
    const department = resource.department.value ?? "stage";
    return [{ id: roleIds.get(resource.key)!, label: resource.kind.value === "person" ? `${department[0]!.toUpperCase()}${department.slice(1)} role ${index + 1}` : sanitize(resource.name.value ?? `Equipment requirement ${index + 1}`), kind: resource.kind.value, skills: resource.skills.value ?? [], capacity: resource.capacity.value ?? 1, sourceIds: sourceIds([resource.kind, resource.skills, resource.capacity]) }];
  });
  const anchor = graph.production.showDate.value;
  const relative = (value: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: graph.production.zone.value!, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
    const part = (name: string) => parts.find(p => p.type === name)!.value;
    return { dayOffset: Math.round((Date.parse(`${part("year")}-${part("month")}-${part("day")}T12:00Z`) - Date.parse(anchor + "T12:00Z")) / 86400000), localTime: `${part("hour")}:${part("minute")}` };
  };
  const calls = graph.tasks.flatMap((task, index) => {
    if (!task.start.value || task.durationMinutes.value == null || !anchor || !graph.production.zone.value) { unknowns.push({ id: `call-unknown-${index}`, label: `Call ${task.key} has incomplete date, zone, start or duration. No time was invented.`, hard: true, sourceIds: sourceIds([task.start, task.durationMinutes]) }); return []; }
    if (task.resources.value == null || task.amplified.value == null || task.lane.value == null || (task.resources.value ?? []).some(id => !slots.some(slot => slot.id === roleIds.get(id)))) unknowns.push({ id: `call-requirements-${index}`, label: `Call ${task.key} has unresolved resources, department or amplified-audio requirements. Conservative placeholders do not qualify it.`, hard: true, sourceIds: sourceIds([task.resources, task.amplified, task.lane]) });
    const instant = new Date(task.start.value), zone = graph.production.zone.value;
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant);
    const part = (name: string) => parts.find(p => p.type === name)!.value;
    const date = `${part("year")}-${part("month")}-${part("day")}`;
    return [{ id: task.key, label: sanitize(task.name.value ?? task.key), lane: task.lane.value === "commercial" ? "people" as const : task.lane.value ?? "stage" as const, dayOffset: Math.round((Date.parse(date + "T12:00Z") - Date.parse(anchor + "T12:00Z")) / 86400000), localTime: `${part("hour")}:${part("minute")}`, durationMinutes: task.durationMinutes.value, slotIds: (task.resources.value ?? []).map(id => roleIds.get(id)!).filter(id => slots.some(slot => slot.id === id)), requiredSkills: task.requiredSkill.value ? [task.requiredSkill.value] : [], amplified: task.amplified.value ?? true, earliest: task.earliestStart.value ? relative(task.earliestStart.value) : null, latest: task.latestEnd.value ? relative(task.latestEnd.value) : null, sourceIds: sourceIds([task.start, task.durationMinutes, task.resources, task.requiredSkill, task.amplified, task.earliestStart, task.latestEnd]) }];
  });
  const dependencies = graph.dependencies.flatMap(edge => calls.some(c => c.id === edge.from) && calls.some(c => c.id === edge.to) ? [{ id: edge.key, from: edge.from, to: edge.to, lagMinutes: edge.lagMinutes.value ?? 0, sourceIds: sourceIds([edge.lagMinutes]) }] : []);
  if (dependencies.length !== graph.dependencies.length) unknowns.push({ id: "incomplete-dependencies", label: "Some dependencies reference unscheduled source requirements. Complete them before qualifying a route.", hard: true, sourceIds: [] });
  return validateTemplate({ name: sanitize(graph.production.title.value ?? "Reviewed source production"), description: sanitize(graph.summary), zonePolicy: "venue_wall_clock", slots, calls, dependencies, minimumRestMinutes: graph.policy.minimumRestMinutes.value, maxDutyMinutes: null, sources, unknowns, stage: emptyStage() });
}
