import type { Dependency, EngineReport, ShowSnapshot, Task } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { qualificationIssues, topologicalOrder } from "@/domain/scheduling";
import { retainedCompiledGraphSchema, graphFacts, type CompiledGraph, type CompilerAssumption, type CompilerIssue, type CompilerReview, type SourceCitation, type SourceDocument, type SourceFact } from "@/domain/sources";
import { commitGraphEngine } from "../engine";
import { sourceBaselineRetention } from "./retention";

const text = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
const sameName = (a: string, b: string) => text(a).toLocaleLowerCase("en") === text(b).toLocaleLowerCase("en");
const sameValue = (a: unknown, b: unknown) => digest(a) === digest(b);
const at = (value: string) => Date.parse(value);
const endOf = (start: string, minutes: number) => new Date(at(start) + minutes * 60_000).toISOString();

export function sourceApplicationBlock(show: ShowSnapshot): string | null {
  if (show.settlementVersion) return "This production has retained crew settlement records. Source proposals cannot replace the production or roster behind reported work and approved liabilities.";
  if (show.approvedPlan || show.planVersion > 1 || show.sheets.some(sheet => sheet.candidateId || sheet.version > 1) || show.acknowledgments.length || show.financialEvidence.length || show.facts.length || show.rentalExecutions?.length || show.crewAttestations?.length || show.crewCues?.length || show.state !== "standby" || show.goReportId) return "This production already has approved or operational work. Its source proposals remain reviewable; create a fresh rehearsal to import planning changes without rewriting that history.";
  if (show.incidents.length) return "Resolve this production's live disruption through its recovery review. Source imports cannot bypass incident and supplier checks.";
  return null;
}

/** The compiler proposes. This deterministic check binds every quote to private original bytes and every change to a reviewable graph. */
export async function validateSourceGraph(show: ShowSnapshot, raw: CompiledGraph, sources: SourceDocument[], compilationId: string, engine: typeof commitGraphEngine = commitGraphEngine): Promise<CompilerReview> {
  const graph = retainedCompiledGraphSchema.parse(raw), issues: CompilerIssue[] = [], assumptions: CompilerAssumption[] = [], citations: CompilerReview["citations"] = [];
  const issue = (code: string, field: string, message: string, refs: SourceCitation[] = [], severity: CompilerIssue["severity"] = "hard", blocking = true) => { issues.push({ code, field, message, citations: refs, severity, blocking }); };
  const assume = (field: string, statement: string, value: unknown) => { const id = `assumption:${field}:${digest({ statement, value }).slice(0, 16)}`; if (!assumptions.some(item => item.id === id)) assumptions.push({ id, field, statement, value }); };
  const selected = new Map(sources.map(source => [source.id, source]));
  const verify = (field: string, refs: SourceCitation[]) => {
    for (const reference of refs) {
      const source = selected.get(reference.sourceId), unit = source?.extraction?.units.find(item => item.id === reference.unitId);
      const valid = Boolean(unit && text(unit.text).includes(text(reference.quote)));
      citations.push({ field, citation: reference, valid, locator: valid ? unit!.locator : null, title: source?.title ?? "Unselected source" });
      if (!valid) issue("CITATION_NOT_IN_SOURCE", field, "This quotation does not occur in the selected immutable source location.", [reference]);
      else if (unit!.caution) issue("SOURCE_CELL_NEEDS_REVIEW", field, unit!.caution!, [reference], "unknown");
    }
  };
  for (const { field, fact } of graphFacts(graph)) {
    verify(field, fact.citations);
    if (fact.value !== null && !fact.citations.length && !fact.assumption) issue("UNSUPPORTED_FACT", field, "A proposed value needs an exact source quotation or an explicit assumption.");
    if (fact.assumption) assume(field, fact.assumption, fact.value);
  }
  for (const source of sources) {
    if (!source.current || !source.extraction || !["ready", "needs_attention"].includes(source.state)) issue("SOURCE_NOT_EXTRACTED", `source.${source.id}`, "This source version is not current and completely extracted.");
    for (const notice of source.extraction?.notices ?? []) issue(notice.code, `source.${source.id}`, `${source.title}: ${notice.message}`, [], "unknown", notice.blocking);
  }
  for (const entry of graph.unknowns) issue("SOURCE_UNKNOWN", entry.field, entry.message, [], "unknown", entry.blocking);
  for (const entry of graph.conflicts) { verify(entry.field, entry.citations); issue("SOURCE_CONFLICT", entry.field, entry.message, entry.citations); }
  for (const entry of graph.unsupportedRequirements) { verify("unsupported", entry.citations); issue("SOURCE_UNSUPPORTED_REQUIREMENT", "unsupported", entry.message, entry.citations, "unknown"); }

  let baselineRetention: CompilerReview["baselineRetention"];
  if (graph.schemaVersion === 2) {
    const expected = sourceBaselineRetention(show), matches = sameValue(graph.baselineRetention, expected);
    baselineRetention = { ...expected, matches };
    if (!matches) issue("BASELINE_RETENTION_CHANGED", "baselineRetention", "The proposed retention values do not match the exact selected production. Maximum-shift, remedy cohort and critical crew settings stay unchanged; changing them needs a separate supported policy review.");
  }

  const productionFields = ["title", "venue", "zone", "showDate"] as const;
  for (const field of productionFields) {
    const fact = graph.production[field], value = show[field];
    if (fact.value === null) assume(`production.${field}`, `Keep the selected production's ${field}: ${value}. The source does not supply it.`, value);
    else if (!sameName(fact.value, value)) issue("DIFFERENT_PRODUCTION", `production.${field}`, `The source names ${fact.value}; the selected production uses ${value}. This graph stays uncommitted until it has a matching production.`, fact.citations);
  }
  const applicationBlock = sourceApplicationBlock(show);
  if (applicationBlock) issue("OPERATIONAL_HISTORY_EXISTS", "production", applicationBlock);
  const patch: CompilerReview["patch"] = { tasks: structuredClone(show.tasks), dependencies: structuredClone(show.dependencies), resources: structuredClone(show.resources), curfewAt: show.curfewAt, accessUntil: show.accessUntil, minimumRestMinutes: show.policy.minimumRestMinutes, importedTaskIds: [], importedResourceIds: [] };
  for (const field of ["curfewAt", "accessUntil"] as const) {
    const fact = graph.policy[field];
    if (fact.value === null) assume(`policy.${field}`, `Retain the existing hard ${field === "curfewAt" ? "amplified audio curfew" : "venue access limit"}.`, show[field]);
    else if (at(fact.value) > at(show[field])) issue("HARD_POLICY_RELAXED", `policy.${field}`, "A source proposal cannot relax the production's existing hard policy.", fact.citations);
    else patch[field] = fact.value;
  }
  const rest = graph.policy.minimumRestMinutes;
  if (rest.value === null) assume("policy.minimumRestMinutes", "Retain the production's existing minimum crew rest requirement.", show.policy.minimumRestMinutes);
  else if (rest.value < show.policy.minimumRestMinutes) issue("HARD_POLICY_RELAXED", "policy.minimumRestMinutes", "A source proposal cannot shorten the required crew rest.", rest.citations);
  else patch.minimumRestMinutes = rest.value;

  const resourceKeys = new Map<string, string>(), targetedResources = new Set<string>();
  for (const resource of graph.resources) {
    const field = `resource.${resource.key}`;
    if (resourceKeys.has(resource.key)) { issue("DUPLICATE_RESOURCE_KEY", field, "Each resource needs a unique graph key."); continue; }
    const existing = show.resources.find(item => item.id === resource.targetId);
    if (!existing) { issue("ROSTER_ADMISSION_REQUIRED", field, "This resource has no existing production roster identity. Its sourced details remain in the proposal; separate roster admission is required before its calls can enter this production.", resource.name.citations, "unknown"); continue; }
    if (targetedResources.has(existing.id)) issue("DUPLICATE_RESOURCE_TARGET", field, "Two source resources point to the same production roster identity.");
    targetedResources.add(existing.id); resourceKeys.set(resource.key, existing.id);
    if (resource.name.value === null || !sameName(resource.name.value, existing.name)) issue("ROSTER_IDENTITY_MISMATCH", `${field}.name`, `Review the resource identity. ${existing.id} belongs to ${existing.name}.`, resource.name.citations);
    const checks: [string, SourceFact<unknown>, unknown][] = [["kind", resource.kind, existing.kind], ["department", resource.department, existing.department], ["skills", resource.skills, existing.skills], ["availableFrom", resource.availableFrom, existing.availableFrom], ["availableUntil", resource.availableUntil, existing.availableUntil], ["hourlyRateMinor", resource.hourlyRateMinor, existing.rateMinor], ["capacity", resource.capacity, 1]];
    for (const [name, fact, current] of checks) {
      if (fact.value === null) assume(`${field}.${name}`, "Use the existing production roster value; this source does not establish a replacement.", current);
      else {
        const agrees = name === "skills" ? sameValue([...(fact.value as string[])].sort(), [...existing.skills].sort()) : ["availableFrom", "availableUntil"].includes(name) ? at(fact.value as string) === at(current as string) : sameValue(fact.value, current);
        if (!agrees) issue("ROSTER_FACT_CONFLICT", `${field}.${name}`, "This source disagrees with the existing roster. Qualifications, availability, capacity and rates need their own roster review; this compiler cannot silently change them.", fact.citations, "unknown");
      }
    }
  }

  const taskKeys = new Map<string, string>(), targetedTasks = new Set<string>();
  for (const proposal of graph.tasks) {
    const field = `task.${proposal.key}`;
    if (taskKeys.has(proposal.key)) { issue("DUPLICATE_TASK_KEY", field, "Each call needs a unique graph key."); continue; }
    const existing = proposal.targetId ? show.tasks.find(task => task.id === proposal.targetId) : undefined;
    if (proposal.targetId && !existing) { issue("TASK_TARGET_MISSING", field, "The proposed target call does not exist in this production."); continue; }
    const id = existing?.id ?? `source-${compilationId}-${proposal.key}`;
    taskKeys.set(proposal.key, id);
    if (targetedTasks.has(id)) { issue("DUPLICATE_TASK_TARGET", field, "Two proposed calls point to the same current call."); continue; }
    targetedTasks.add(id);
    const required = <T>(name: string, fact: SourceFact<T>, current: T | undefined): T | null => {
      if (fact.value !== null) return fact.value;
      if (current !== undefined) { assume(`${field}.${name}`, "Retain the current call's value; the source does not replace it.", current); return current; }
      issue("CALL_DETAIL_UNKNOWN", `${field}.${name}`, `This new call needs a concrete ${name} before it can be applied.`, fact.citations, "unknown"); return null;
    };
    const name = required("name", proposal.name, existing?.name), lane = required("lane", proposal.lane, existing?.lane), start = required("start", proposal.start, existing?.start), duration = required("durationMinutes", proposal.durationMinutes, existing?.durationMinutes);
    let resources: string[] = [];
    if (proposal.resources.value === null && existing) { resources = [...existing.resources]; assume(`${field}.resources`, "Retain the existing assignments; no replacement assignment is established by the source.", resources); }
    else if (proposal.resources.value === null) issue("CALL_DETAIL_UNKNOWN", `${field}.resources`, "Establish the new call's resource assignments, including an explicit empty list if none are required.", [], "unknown");
    else for (const key of proposal.resources.value) { const resourceId = resourceKeys.get(key); if (!resourceId) issue("UNKNOWN_RESOURCE", `${field}.resources`, `The ${key} assignment has no admitted production roster identity.`); else resources.push(resourceId); }
    if (new Set(resources).size !== resources.length) issue("DUPLICATE_ASSIGNMENT", `${field}.resources`, "A call cannot assign the same resource more than once.");
    if (name === null || lane === null || start === null || duration === null) continue;
    const end = endOf(start, duration);
    if (existing && (!sameName(name, existing.name) || lane !== existing.lane)) issue("CALL_IDENTITY_MISMATCH", field, "The source mapping changes the name or department of an existing call. Add a separate new call or correct the mapping.", proposal.name.citations);
    if (!existing && at(start) < at(show.clock)) issue("PAST_CALL", `${field}.start`, "A new source call cannot be backdated before the production's scenario clock.", proposal.start.citations);
    let requiredSkill = proposal.requiredSkill.value ?? existing?.requiredSkill ?? null;
    if (existing?.requiredSkill && requiredSkill !== existing.requiredSkill) { issue("QUALIFICATION_RULE_CHANGED", `${field}.requiredSkill`, "The existing call's required qualification cannot be replaced by a source import.", proposal.requiredSkill.citations); requiredSkill = existing.requiredSkill; }
    if (!existing && proposal.requiredSkill.value === null) assume(`${field}.requiredSkill`, "The source does not identify a special qualification for this new call. Confirm that no qualification is missing.", null);
    const currentBounds = existing?.sourceConstraints;
    const amplified = proposal.amplified.value ?? currentBounds?.amplified ?? ["support", "headliner", "headliner-check", "support-check"].includes(id);
    if (proposal.amplified.value === null) assume(`${field}.amplified`, "Review whether this call uses amplified audio; the source leaves that classification unstated.", amplified);
    if ((currentBounds?.amplified || ["support", "headliner", "headliner-check", "support-check"].includes(id)) && !amplified) issue("AMPLIFIED_RULE_REMOVED", `${field}.amplified`, "The source cannot remove an existing amplified audio restriction.", proposal.amplified.citations);
    const earliestStart = proposal.earliestStart.value ?? currentBounds?.earliestStart ?? null, latestEnd = proposal.latestEnd.value ?? currentBounds?.latestEnd ?? null;
    if (currentBounds?.earliestStart && earliestStart && at(earliestStart) < at(currentBounds.earliestStart) || currentBounds?.latestEnd && latestEnd && at(latestEnd) > at(currentBounds.latestEnd)) issue("SOURCE_WINDOW_RELAXED", field, "This source proposal relaxes an already reviewed call window.");
    const task: Task = { id, name, lane, start, end, durationMinutes: duration, baselineStart: existing?.baselineStart ?? start, baselineEnd: existing?.baselineEnd ?? end, resources, requiredSkill, state: existing?.state ?? "planned", critical: existing?.critical ?? true, affected: existing ? !sameValue({ start, end, resources }, { start: existing.start, end: existing.end, resources: existing.resources }) : true, milestone: existing?.milestone ?? null, sourceId: `source-compilation:${compilationId}`, sourceConstraints: { amplified, earliestStart, latestEnd, compilationId } };
    if (existing?.milestone || existing?.state === "complete") {
      if (!sameValue({ name, lane, start: at(start), duration, resources, requiredSkill }, { name: existing.name, lane: existing.lane, start: at(existing.start), duration: existing.durationMinutes, resources: existing.resources, requiredSkill: existing.requiredSkill })) issue("OPERATIONAL_CALL_PROTECTED", field, "Completed calls and operational milestones cannot be rewritten by source compilation.");
      continue;
    }
    if (existing) patch.tasks[patch.tasks.findIndex(item => item.id === id)] = task; else patch.tasks.push(task);
    patch.importedTaskIds.push(id);
  }
  const dependencyKeys = new Set<string>();
  for (const entry of graph.dependencies) {
    const field = `dependency.${entry.key}`;
    if (dependencyKeys.has(entry.key)) { issue("DUPLICATE_DEPENDENCY_KEY", field, "Each dependency needs a unique graph key."); continue; }
    dependencyKeys.add(entry.key);
    const from = taskKeys.get(entry.from), to = taskKeys.get(entry.to);
    if (!from || !to || !patch.tasks.some(task => task.id === from) || !patch.tasks.some(task => task.id === to)) { issue("DEPENDENCY_TARGET_MISSING", field, "Both dependency endpoints must be usable proposed calls."); continue; }
    let lag = entry.lagMinutes.value;
    if (lag === null) { lag = 0; assume(`${field}.lagMinutes`, "Assume no additional lag between these calls; the source does not specify one.", 0); }
    const current = patch.dependencies.find(edge => edge.from === from && edge.to === to);
    if (current && lag < current.lagMinutes) issue("DEPENDENCY_LAG_RELAXED", field, "A source proposal cannot shorten an existing required dependency lag.", entry.lagMinutes.citations);
    else if (current) current.lagMinutes = lag;
    else patch.dependencies.push({ id: `source-${compilationId}-${entry.key}`, from, to, lagMinutes: lag, financial: false } satisfies Dependency);
  }
  for (const message of topologicalOrder(patch.tasks, patch.dependencies).invalid) issue("GRAPH_INVALID", "graph", message);
  const byId = new Map(patch.tasks.map(task => [task.id, task]));
  for (const edge of patch.dependencies) {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (from && to && at(from.end) + edge.lagMinutes * 60_000 > at(to.start)) issue("DEPENDENCY_ORDER", `task.${to.id}`, `${to.name} starts before ${from.name} and its required lag clear.`);
  }
  for (const task of patch.tasks.filter(item => item.state !== "complete")) {
    const field = `task.${task.id}`;
    if (at(task.end) - at(task.start) !== task.durationMinutes * 60_000) issue("DURATION_INVALID", field, "The call's interval does not match its duration.");
    for (const item of qualificationIssues(show, task)) issue(item.code, field, item.message);
    if (task.requiredSkill && !task.resources.length) issue("QUALIFIED_RESOURCE_REQUIRED", field, `${task.name} requires a qualified assigned resource.`);
    for (const resourceId of task.resources) {
      const resource = show.resources.find(item => item.id === resourceId);
      if (!resource) issue("UNKNOWN_RESOURCE", field, "A call refers to an unknown roster identity.");
      else if (at(task.start) < at(resource.availableFrom) || at(task.end) > at(resource.availableUntil)) issue("RESOURCE_UNAVAILABLE", field, `${resource.name} is outside their current availability for ${task.name}.`);
    }
    const bounds = task.sourceConstraints;
    if (bounds?.earliestStart && at(task.start) < at(bounds.earliestStart)) issue("EARLIEST_START", field, `${task.name} begins before its source window.`);
    if (bounds?.latestEnd && at(task.end) > at(bounds.latestEnd)) issue("LATEST_END", field, `${task.name} finishes after its source window.`);
    if ((bounds?.amplified || ["support", "headliner", "headliner-check", "support-check"].includes(task.id)) && at(task.end) > at(patch.curfewAt)) issue("AMPLIFIED_CURFEW", field, `${task.name} extends beyond the amplified audio curfew.`);
    if (at(task.end) > at(patch.accessUntil)) issue("VENUE_ACCESS", field, `${task.name} extends beyond authorized venue access.`);
  }
  const active = patch.tasks.filter(task => task.state !== "complete" && task.durationMinutes > 0);
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    const a = active[i]!, b = active[j]!;
    if (at(a.start) < at(b.end) && at(b.start) < at(a.end)) for (const id of a.resources.filter(id => b.resources.includes(id))) issue("RESOURCE_OVERLAP", `task.${b.id}`, `${show.resources.find(item => item.id === id)?.name ?? id}: ${a.name} overlaps ${b.name}.`);
  }
  for (const id of ["sam", "priya"]) {
    const finish = patch.tasks.filter(task => task.resources.includes(id)).reduce((latest, task) => Math.max(latest, at(task.end)), 0);
    if ((at(show.nextCallAt) - finish) / 60_000 < patch.minimumRestMinutes) issue("CREW_REST", `resource.${id}`, "The proposed call leaves less than the required rest before the next confirmed call.");
  }
  let engineReport: EngineReport | null = null;
  if (!issues.some(item => ["GRAPH_INVALID", "DURATION_INVALID", "DEPENDENCY_TARGET_MISSING"].includes(item.code))) {
    engineReport = await engine(patch.tasks, patch.dependencies, show.zone);
    if (engineReport.status !== "passed") issue("ENGINE_NOT_PASSED", "graph", engineReport.reason ?? "The scheduling engine did not validate these exact dates.", [], engineReport.status === "unavailable" ? "unknown" : "hard");
  }
  return { graph, issues, assumptions, citations, ...(baselineRetention ? { baselineRetention } : {}), patch, engine: engineReport, canApply: Boolean(engineReport?.status === "passed" && !issues.some(item => item.blocking) && patch.importedTaskIds.length) };
}
