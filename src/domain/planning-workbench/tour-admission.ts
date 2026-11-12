import { z } from "zod";
import { DomainError, type ConstraintIssue, type ShowSnapshot, type Task } from "../contracts";
import type { PlannedProduction, Tour } from "../tour/contracts";
import { resourcesForCall } from "../tour/templates";
import { digest } from "../hash";
import { qualificationIssues } from "../scheduling";
import { productionInputIssues } from "../production-inputs/constraints";
import { assignmentMapSchema, type AssignmentMap } from "./options";
export { assignmentMapSchema, type AssignmentMap } from "./options";
export interface TourAssignmentState {
  version: 1; reviewId: string; digest: string; admittedAtRevision: number; admittedAt: string; actorId: string;
  target: { tenantId: string; showId: string }; tour: { id: string; revision: number; digest: string }; production: { id: string; revision: number; digest: string };
  assignments: { callId: string; taskId: string; personIds: string[]; originalTaskDigest: string }[];
}
export function assignmentProjection(show: ShowSnapshot, production: PlannedProduction, tour: Tour, mapping: AssignmentMap) {
  assignmentMapSchema.parse(mapping);
  if (production.archived || tour.archived || !tour.productionIds.includes(production.id)) throw new DomainError("TOUR_ADMISSION_SCOPE", "Choose a current production inside this current tour.");
  if (production.showDate !== show.showDate || production.venue.zone !== show.zone || production.venue.name.trim().toLocaleLowerCase() !== show.venue.trim().toLocaleLowerCase()) throw new DomainError("TOUR_ADMISSION_VENUE", "This planning leg must match this operating production's exact date, IANA zone and venue. Other legs stay planning-only until separately reviewed in their own production.");
  const tasks = structuredClone(show.tasks), differences: { callId: string; taskId: string; label: string; before: string[]; after: string[] }[] = [], assignments: TourAssignmentState["assignments"] = [];
  for (const link of mapping) {
    const call = production.calls.find(row => row.id === link.callId), task = tasks.find(row => row.id === link.taskId);
    if (!call || !task || task.state === "complete" || task.cancellation || task.lane === "commercial" || task.milestone) throw new DomainError("TOUR_ADMISSION_TASK", "Map only current uncompleted production work. Completed work, cancellation and commercial or physical milestones cannot be reassigned through a tour plan.");
    if (Date.parse(call.start.instant) !== Date.parse(task.start) || Date.parse(call.end.instant) !== Date.parse(task.end)) throw new DomainError("TOUR_ADMISSION_INTERVAL", "The planning call and target operating call must have the same current interval. Review schedule changes in the production before importing its assignment.");
    const people = resourcesForCall(production, call).map(id => tour.resources.find(row => row.id === id)).filter(resource => resource?.kind === "person");
    if (!people.length || people.some(person => !person?.personId || person.id !== person.personId)) throw new DomainError("TOUR_ADMISSION_PERSON", "Every imported person must have an exact current admitted roster identity.");
    const personIds = [...new Set(people.map(person => person!.personId!))].sort();
    for (const person of people) {
      const current = show.resources.find(row => row.id === person!.personId && row.kind === "person");
      if (!current || current.name !== person!.label || digest([...current.skills].sort()) !== digest([...person!.skills].sort()) || current.reserve) throw new DomainError("TOUR_ADMISSION_ROSTER", "A tour allocation cannot replace a current person's identity, active status or qualifications. Admit changed roster sources first.");
    }
    const before = task.resources.filter(id => show.resources.find(row => row.id === id)?.kind === "person").sort();
    assignments.push({ callId: call.id, taskId: task.id, personIds, originalTaskDigest: digest(task) });
    task.resources = [...task.resources.filter(id => show.resources.find(row => row.id === id)?.kind !== "person"), ...personIds];
    differences.push({ callId: call.id, taskId: task.id, label: task.name, before, after: personIds });
  }
  if (differences.every(row => digest(row.before) === digest(row.after))) throw new DomainError("TOUR_ADMISSION_UNCHANGED", "These exact assignments are already in the operating production. No new admission is needed.");
  const issues: ConstraintIssue[] = productionInputIssues(show, tasks);
  const add = (code: string, message: string, task: Task, person: string) => issues.push({ code, message, stage: "semantic", severity: "hard", taskId: task.id, resourceId: person, sourceId: production.id });
  for (const task of tasks.filter(row => !row.cancellation && row.state !== "complete")) {
    issues.push(...qualificationIssues(show, task));
    for (const id of task.resources) { const person = show.resources.find(row => row.id === id); if (person?.kind === "person" && (Date.parse(task.start) < Date.parse(person.availableFrom) || Date.parse(task.end) > Date.parse(person.availableUntil))) add("TOUR_OPERATING_AVAILABILITY", `${person.name} is outside their current admitted availability for ${task.name}.`, task, id); }
  }
  for (const person of show.resources.filter(row => row.kind === "person")) {
    const work = tasks.filter(task => task.resources.includes(person.id) && task.durationMinutes > 0 && task.state !== "complete" && !task.cancellation).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    for (let index = 0; index < work.length; index++) for (let next = index + 1; next < work.length && Date.parse(work[next]!.start) < Date.parse(work[index]!.end); next++) add("TOUR_OPERATING_OVERLAP", `${person.name} overlaps ${work[index]!.name} and ${work[next]!.name} in the current production.`, work[next]!, person.id);
    if (work.length) { const end = Math.max(...work.map(task => Date.parse(task.end))); const next = show.crewNextCalls?.filter(call => call.resources.includes(person.id) && Date.parse(call.start) > Date.parse(work[0]!.start)).map(call => Date.parse(call.start)) ?? []; if (!next.length && ["sam", "priya"].includes(person.id)) next.push(Date.parse(show.nextCallAt)); if (next.length && (Math.min(...next) - end) / 60000 < show.policy.minimumRestMinutes) add("TOUR_OPERATING_REST", `${person.name} has insufficient rest before the next current production call.`, work.at(-1)!, person.id); }
  }
  return { tasks, differences, assignments, issues };
}
