import { DomainError, type Resource, type ShowSnapshot } from "../contracts";
import { digest } from "../hash";
import type { InputCitation, InputDifference, InputDraft, InputSource, ProductionInputState, RosterChange } from "./contracts";

export function inputFacts(draft: InputDraft) {
  const facts: { field: string; value: unknown; citations: InputCitation[] }[] = [];
  draft.roster.forEach((row, index) => {
    const fields = row.kind === "add" ? Object.fromEntries(Object.entries(row).filter(([key]) => !["kind", "key"].includes(key))) : row.changes;
    for (const [field, raw] of Object.entries(fields)) { const value = raw as { value: unknown; citations: InputCitation[] }; facts.push({ field: `roster.${index}.${field}`, ...value }); }
  });
  for (const [field, value] of Object.entries(draft.venue)) if (value) facts.push({ field: `venue.${field}`, ...value });
  return facts;
}
export function validateInputCitations(draft: InputDraft, sources: readonly InputSource[]) {
  for (const fact of inputFacts(draft)) for (const citation of fact.citations) {
    const source = sources.find(item => item.id === citation.sourceId), unit = source?.units.find(item => item.id === citation.unitId);
    if (!unit || !unit.text.includes(citation.quote)) throw new DomainError("INPUT_CITATION_INVALID", `The quotation for ${fact.field} is absent from its exact retained source unit.`, 422);
  }
}
const display = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
export function applyInputDraft(input: ShowSnapshot, draft: InputDraft, proposalId: string, editionId: string, admittedAt: string) {
  const show = structuredClone(input), differences: InputDifference[] = [];
  const state: ProductionInputState = structuredClone(show.productionInputs ?? { version: 1, editionId, revision: 0, digest: "", admittedAtRevision: input.revision + 1, admittedAt, sourceIds: [], roster: [], venue: { sourceIds: [] } });
  const ids = new Set<string>();
  const difference = (field: string, before: unknown, after: unknown, citations: InputCitation[]) => { if (digest(before) !== digest(after)) differences.push({ field, before: display(before), after: display(after), citations }); };
  for (const row of draft.roster) {
    const id = row.kind === "add" ? `input-${proposalId}-${row.key}` : row.personId;
    if (ids.has(id)) throw new DomainError("INPUT_DUPLICATE_PERSON", "Propose each roster identity once.", 422);
    ids.add(id);
    let person = show.resources.find(resource => resource.id === id);
    if (row.kind === "update" && (!person || person.kind !== "person")) throw new DomainError("INPUT_PERSON_NOT_FOUND", "A changed person must belong to this exact current roster.", 422);
    if (row.kind === "add") {
      if (person || show.resources.some(resource => resource.kind === "person" && resource.name.normalize("NFKC").toLowerCase() === row.name.value.normalize("NFKC").toLowerCase())) throw new DomainError("INPUT_PERSON_EXISTS", "This identity or name is already rostered. Review an update to the original person.", 422);
      person = { id, name: row.name.value, role: row.role.value, initials: row.name.value.split(/\s+/).map(part => part[0]).join("").slice(0, 3), kind: "person", department: row.department.value, skills: [], critical: row.status.value === "active", reserve: row.status.value === "reserve", color: "#bfa47b", availableFrom: row.availability.value.from, availableUntil: row.availability.value.until, rateMinor: 0 } satisfies Resource;
      show.resources.push(person);
      difference(`person.${id}.name`, "Not on this roster", row.name.value, row.name.citations);
    }
    const fields = row.kind === "add" ? row : row.changes;
    const sourceIds = [...new Set(inputFacts({ title: draft.title, rationale: draft.rationale, roster: [row], venue: {} }).flatMap(fact => fact.citations.map(cite => cite.sourceId)))];
    const previous = state.roster.find(item => item.personId === id);
    const retained = { personId: id, ...previous, sourceIds: [...new Set([...(previous?.sourceIds ?? []), ...sourceIds])], provenance: "declared_planning_input" as const };
    if (fields.role) { difference(`person.${id}.role`, person!.role, fields.role.value, fields.role.citations); person!.role = fields.role.value; }
    if (fields.department) { difference(`person.${id}.department`, person!.department, fields.department.value, fields.department.citations); person!.department = fields.department.value; }
    if (fields.qualifications) { difference(`person.${id}.qualifications`, person!.skills, fields.qualifications.value, fields.qualifications.citations); retained.qualifications = structuredClone(fields.qualifications.value); person!.skills = fields.qualifications.value.map(item => item.skill); }
    if (fields.availability) { difference(`person.${id}.availability`, { from: person!.availableFrom, until: person!.availableUntil }, fields.availability.value, fields.availability.citations); person!.availableFrom = fields.availability.value.from; person!.availableUntil = fields.availability.value.until; }
    if (fields.status) { difference(`person.${id}.status`, person!.reserve ? "reserve" : "active", fields.status.value, fields.status.citations); person!.reserve = fields.status.value === "reserve"; person!.critical = !person!.reserve; }
    if (fields.assignments) {
      const old = show.tasks.filter(task => task.resources.includes(id)).map(task => task.id);
      for (const taskId of fields.assignments.value) if (!show.tasks.some(task => task.id === taskId)) throw new DomainError("INPUT_TASK_NOT_FOUND", "A roster assignment refers to a task outside this current production.", 422);
      difference(`person.${id}.assignments`, old, fields.assignments.value, fields.assignments.citations);
      for (const task of show.tasks) { task.resources = task.resources.filter(resourceId => resourceId !== id); if (fields.assignments.value.includes(task.id)) task.resources.push(id); }
    }
    state.roster = [...state.roster.filter(item => item.personId !== id), retained];
  }
  if (show.resources.length > 160) throw new DomainError("INPUT_ROSTER_LIMIT", "This production supports at most 160 retained resources.", 422);
  const venue = draft.venue;
  if (venue.accessWindow) { difference("venue.accessWindow", { from: state.venue.accessFrom ?? null, until: show.accessUntil }, venue.accessWindow.value, venue.accessWindow.citations); state.venue.accessFrom = venue.accessWindow.value.from; show.accessUntil = venue.accessWindow.value.until; }
  if (venue.amplifiedCurfew) { difference("venue.amplifiedCurfew", show.curfewAt, venue.amplifiedCurfew.value, venue.amplifiedCurfew.citations); show.curfewAt = venue.amplifiedCurfew.value; }
  if (venue.minimumRestMinutes) { difference("venue.minimumRestMinutes", show.policy.minimumRestMinutes, venue.minimumRestMinutes.value, venue.minimumRestMinutes.citations); show.policy.minimumRestMinutes = venue.minimumRestMinutes.value; }
  if (venue.maximumShiftMinutes) { difference("venue.maximumShiftMinutes", state.venue.maximumShiftMinutes ?? `No source-admitted hard planning cap; actual-hours review setting ${show.policy.maxShiftMinutes} minutes`, venue.maximumShiftMinutes.value, venue.maximumShiftMinutes.citations); show.policy.maxShiftMinutes = venue.maximumShiftMinutes.value; state.venue.maximumShiftMinutes = venue.maximumShiftMinutes.value; }
  if (!differences.length) throw new DomainError("INPUT_NO_CHANGE", "These facts reproduce the current inputs. Preserve their sources without creating another edition.", 422);
  state.venue.sourceIds = [...new Set([...state.venue.sourceIds, ...Object.values(venue).flatMap(fact => fact?.citations.map(cite => cite.sourceId) ?? [])])];
  state.sourceIds = [...new Set([...state.sourceIds, ...inputFacts(draft).flatMap(fact => fact.citations.map(cite => cite.sourceId))])];
  state.editionId = editionId; state.revision++; state.admittedAtRevision = input.revision + 1; state.admittedAt = admittedAt;
  state.digest = digest({ version: state.version, editionId, revision: state.revision, sourceIds: state.sourceIds, roster: state.roster, venue: state.venue, resources: show.resources, tasks: show.tasks, curfewAt: show.curfewAt, accessUntil: show.accessUntil, minimumRestMinutes: show.policy.minimumRestMinutes, maximumShiftMinutes: show.policy.maxShiftMinutes });
  show.productionInputs = state; show.policy.version++; show.policy.criticalCrewCount = show.resources.filter(person => person.kind === "person" && person.critical && !person.reserve).length;
  return { show, differences, state };
}
