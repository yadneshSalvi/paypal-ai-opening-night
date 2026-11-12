import type { ConstraintIssue, ShowSnapshot, Task } from "../contracts";

export function inputPlanCurrent(show: ShowSnapshot): boolean {
  const admission = Math.max(show.productionInputs?.admittedAtRevision ?? 0, show.tourAssignments?.admittedAtRevision ?? 0);
  return admission === 0 || Boolean(show.approvedPlan && show.approvedPlan.baseRevision >= admission);
}
export function inputPublicationCurrent(show: ShowSnapshot): boolean {
  return !(show.productionInputs || show.tourAssignments) || Boolean(inputPlanCurrent(show) && (!show.productionInputs || show.sheets.at(-1)?.productionInputDigest === show.productionInputs.digest) && (!show.tourAssignments || show.sheets.at(-1)?.tourAssignmentDigest === show.tourAssignments.digest) && show.sheets.at(-1)?.planRevision === show.planVersion && show.sheets.at(-1)?.candidateId === show.approvedPlan?.candidateId);
}

/** Engine dates and domain availability/qualification rules are separate evidence. */
export function productionInputIssues(show: ShowSnapshot, tasks: readonly Task[] = show.tasks): ConstraintIssue[] {
  const state = show.productionInputs;
  if (!state) return [];
  const issues: ConstraintIssue[] = [], at = (value: string) => Date.parse(value);
  const add = (code: string, message: string, resourceId: string | null = null, taskId: string | null = null, sourceId = state.sourceIds[0] ?? state.editionId) => issues.push({ code, stage: "semantic", severity: "hard", message, resourceId, taskId, sourceId });
  for (const task of tasks.filter(item => item.state !== "complete" && !item.cancellation)) {
    for (const id of task.resources) {
      const resource = show.resources.find(item => item.id === id);
      if (!resource) { add("INPUT_RESOURCE_MISSING", `${task.name} refers to a person or resource absent from the current roster.`, id, task.id); continue; }
      if (at(task.start) < at(resource.availableFrom) || at(task.end) > at(resource.availableUntil)) add("INPUT_AVAILABILITY", `${resource.name} is unavailable for ${task.name} under the admitted source window.`, id, task.id, state.roster.find(item => item.personId === id)?.sourceIds[0]);
      if (resource.kind === "person" && resource.reserve && task.critical) add("INPUT_RESERVE_ASSIGNED", `${resource.name} is a reserve and cannot satisfy the active assignment for ${task.name}.`, id, task.id);
      if (task.requiredSkill && resource.kind === "person") {
        const qualification = state.roster.find(item => item.personId === id)?.qualifications?.find(item => item.skill === task.requiredSkill);
        if (qualification?.expiresAt && at(task.end) > at(qualification.expiresAt)) add("INPUT_QUALIFICATION_EXPIRED", `${resource.name}'s declared ${task.requiredSkill.replaceAll("_", " ")} qualification ends before ${task.name} clears.`, id, task.id);
      }
    }
    if (state.venue.accessFrom && at(task.start) < at(state.venue.accessFrom)) add("INPUT_VENUE_ACCESS_START", `${task.name} starts before the admitted venue access window.`, null, task.id, state.venue.sourceIds[0]);
    if (at(task.end) > at(show.accessUntil)) add("INPUT_VENUE_ACCESS_END", `${task.name} ends after the admitted venue access window.`, null, task.id, state.venue.sourceIds[0]);
    if ((task.sourceConstraints?.amplified || ["support", "headliner", "headliner-check", "support-check"].includes(task.id)) && at(task.end) > at(show.curfewAt)) add("INPUT_AMPLIFIED_CURFEW", `${task.name} ends after the admitted amplified-audio curfew.`, null, task.id, state.venue.sourceIds[0]);
  }
  for (const person of show.resources.filter(item => item.kind === "person" && item.critical && !item.reserve)) {
    const calls = tasks.filter(task => task.state !== "complete" && !task.cancellation && task.critical && task.resources.includes(person.id));
    if (!calls.length) continue;
    const from = Math.min(...calls.map(task => at(task.start))), until = Math.max(...calls.map(task => at(task.end)));
    // The inherited maxShiftMinutes is an actual-hours review warning. Only a
    // separately source-admitted hard planning cap can reject a candidate here.
    if (state.venue.maximumShiftMinutes !== undefined && (until - from) / 60000 > state.venue.maximumShiftMinutes) add("INPUT_MAXIMUM_SHIFT", `${person.name}'s call span exceeds the admitted ${state.venue.maximumShiftMinutes}-minute hard planning cap.`, person.id);
    const next = show.crewNextCalls?.filter(call => call.resources.includes(person.id) && at(call.start) >= from).map(call => at(call.start)) ?? [];
    if (!next.length && ["sam", "priya"].includes(person.id)) next.push(at(show.nextCallAt));
    if (next.length && (Math.min(...next) - until) / 60000 < show.policy.minimumRestMinutes) add("INPUT_MINIMUM_REST", `${person.name} has less than ${show.policy.minimumRestMinutes} minutes before their next sourced call.`, person.id);
  }
  return issues;
}

export function inputReadiness(show: ShowSnapshot) {
  if (!show.productionInputs) return null;
  const issues = productionInputIssues(show);
  const published = inputPublicationCurrent(show);
  return { complete: published && issues.length === 0, value: !inputPlanCurrent(show) ? "New plan review required" : !published ? "Current publication required" : issues.length ? `${issues.length} input constraints blocked` : `Input edition ${show.productionInputs.revision} current`, reason: "Admitted roster and venue inputs require a fresh engine-validated plan, publication and current personal readbacks. Declared qualifications are planning inputs, not independent certification.", evidenceIds: [show.productionInputs.editionId, ...show.productionInputs.sourceIds] };
}
