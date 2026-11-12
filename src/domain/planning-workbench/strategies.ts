import { DomainError, type Candidate, type ShowSnapshot, type SupplierOffer, type Task } from "../contracts";
import { buildCandidate, planningDigest, validatePatch } from "../scheduling";
import { digest } from "../hash";
import { atVenue, minutesBetween, plusMinutes } from "../time";

import { strategyKinds, strategyRequestSchema, type StrategyRequest } from "./options";
export { strategyKinds, strategyRequestSchema, type StrategyRequest } from "./options";
export const strategyScopeDigest = (show: ShowSnapshot) => digest({ planning: planningDigest(show), curfew: show.curfewAt, access: show.accessUntil, clock: show.clock, nextCall: show.nextCallAt, nextCalls: show.crewNextCalls ?? [] });
export interface StrategyProvenance { version: 1; kind: typeof strategyKinds[number]; parameters: Record<string, string | number>; sourceDigest: string; semanticDigest: string; policyVersion: number; rateDigest: string; costBasis: string; generator?: StrategyGenerator }
/** Present only on a model-proposed candidate. Absent means one of the deterministic families. Model text here is untrusted commentary and grants nothing. */
export interface StrategyGenerator { provenance: "model" | "recorded_model"; model: string; responseId: string | null; outputDigest: string; promptVersion: string; generatedAt: string; recordedAt: string | null; index: number; protects: "doors" | "budget" | "artist" | "crew" | "audience"; rationale: string; assumptions: string[] }
const latest = (...dates: string[]) => dates.reduce((a, b) => Date.parse(a) > Date.parse(b) ? a : b);
const update = (tasks: Task[], id: string, start: string, duration?: number) => { const task = tasks.find(row => row.id === id); if (task) { task.start = start; task.durationMinutes = duration ?? task.durationMinutes; task.end = plusMinutes(start, task.durationMinutes); } };
const approval = (candidate: Candidate, id: string, label: string, role: Candidate["approvals"][number]["role"]) => { if (!candidate.approvals.some(row => row.id === id)) candidate.approvals.push({ id, label, role, grantedBy: null }); };
function scheduleProgramme(candidate: Candidate, doors: string, duration = 90) {
  const patch = candidate.patch, tasks = patch.tasks;
  patch.doorsAt = doors; patch.supportAt = latest(atVenue("20:00"), plusMinutes(doors, 20)); patch.headlinerAt = plusMinutes(patch.supportAt, 45);
  update(tasks, "doors", doors, 0); update(tasks, "support", patch.supportAt, 25); update(tasks, "changeover", plusMinutes(patch.supportAt, 25), 15); update(tasks, "headliner", patch.headlinerAt, duration);
  const end = plusMinutes(patch.headlinerAt, duration), strike = tasks.find(row => row.id === "strike");
  // Preserve the original proposed strike duration; never shorten work to hide a late finish.
  if (strike) { update(tasks, "strike", end, strike.durationMinutes); patch.crewFinishAt = strike.end; }
  if (doors !== atVenue("19:00")) approval(candidate, "strategy-doors", "Review the exact revised public doors time", "producer");
  if (duration !== 90) approval(candidate, "artist-set", `Headliner set ${duration} minutes instead of 90`, "artist_representative");
}
/** One typed bounded variation. Deterministic families and model proposals share this exact construction and every rule below. */
export function strategyCandidate(show: ShowSnapshot, offer: SupplierOffer, kind: StrategyProvenance["kind"], parameters: StrategyProvenance["parameters"], now = new Date().toISOString(), generator?: StrategyGenerator): Candidate {
  if (show.cancellationDecision) throw new DomainError("STRATEGY_CANCELLED_PROGRAMME", "A cancelled programme stays cancelled. Use its retained support-only recovery or cancellation workflow.");
  const minutes = Number(parameters.minutes), candidate = buildCandidate(show, offer, "doors", now);
  let name: string;
  if (kind === "doors_window") { name = `Doors +${minutes} min · ${offer.supplier}`; scheduleProgramme(candidate, plusMinutes(latest(atVenue("19:00"), candidate.patch.tasks.find(task => task.id === "readiness")!.start), minutes)); }
  else if (kind === "set_length") { name = `${minutes}-minute set · ${offer.supplier}`; scheduleProgramme(candidate, latest(atVenue("19:00"), candidate.patch.tasks.find(task => task.id === "readiness")!.start), minutes); }
  else if (kind === "quiet_preparation") { name = `Quiet prep ${minutes} min · ${offer.supplier}`; update(candidate.patch.tasks, "quiet-prep", atVenue("19:40"), minutes); approval(candidate, "quiet-prep-duration", `Department review of ${minutes}-minute isolated quiet preparation`, "department_lead"); }
  else if (kind === "stage_soundcheck") {
    name = `Stage check ${minutes} min · ${offer.supplier}`;
    const original = show.tasks.find(task => task.id === "headliner-check") ?? show.sheets[0]?.tasks.find(task => task.id === "headliner-check");
    if (!original) throw new DomainError("STRATEGY_SOURCE_CHECK_MISSING", "The original soundcheck requirements are unavailable; no replacement technical task can be invented.");
    const tasks = candidate.patch.tasks; candidate.patch.tasks = tasks.filter(task => task.id !== "quiet-prep"); candidate.patch.dependencies = candidate.patch.dependencies.filter(edge => edge.from !== "quiet-prep" && edge.to !== "quiet-prep");
    const start = latest(atVenue("19:40"), tasks.find(task => task.id === "readiness")!.start), check = structuredClone(original);
    Object.assign(check, { start, end: plusMinutes(start, minutes), durationMinutes: minutes, state: "planned", affected: true });
    check.sourceConstraints = { ...(check.sourceConstraints ?? { earliestStart: null, latestEnd: null, compilationId: "retained-original-soundcheck" }), amplified: true };
    candidate.patch.tasks.push(check); candidate.patch.dependencies.push({ id: "strategy-arrival-check", from: "headliner-arrival", to: check.id, lagMinutes: 0, financial: false }, { id: "strategy-check-doors", from: check.id, to: "doors", lagMinutes: 5, financial: false });
    candidate.approvals = candidate.approvals.filter(row => row.id !== "quiet-prep-protocol"); approval(candidate, "stage-check-duration", `Department review of ${minutes}-minute amplified stage check`, "department_lead"); approval(candidate, "artist-check", "Artist review of the revised soundcheck", "artist_representative"); scheduleProgramme(candidate, plusMinutes(check.end, 5));
  } else if (kind === "running_order") {
    name = `Headliner first · ${offer.supplier}`;
    const tasks = candidate.patch.tasks, start = latest(atVenue("20:15"), plusMinutes(tasks.find(task => task.id === "readiness")!.start, 20));
    candidate.patch.headlinerAt = start; candidate.patch.supportAt = plusMinutes(start, 105); update(tasks, "headliner", start, 90); update(tasks, "changeover", plusMinutes(start, 90), 15); update(tasks, "support", candidate.patch.supportAt, 25);
    const strike = tasks.find(task => task.id === "strike")!; update(tasks, "strike", plusMinutes(candidate.patch.supportAt, 25), strike.durationMinutes); candidate.patch.crewFinishAt = strike.end;
    const programme = new Set(["support", "changeover", "headliner", "strike"]); candidate.patch.dependencies = candidate.patch.dependencies.filter(edge => !(programme.has(edge.from) && programme.has(edge.to)));
    for (const [from, to] of [["headliner", "changeover"], ["changeover", "support"], ["support", "strike"]]) candidate.patch.dependencies.push({ id: `strategy-${from}-${to}`, from: from!, to: to!, lagMinutes: 0, financial: false });
    candidate.approvals = candidate.approvals.filter(row => row.id !== "support-first"); approval(candidate, "headliner-first", "Producer review of headliner-first public order", "producer"); approval(candidate, "artist-order", "Artist consent to headliner-first order", "artist_representative");
  } else {
    name = `Crew alternative · ${offer.supplier}`;
    const substitution = parameters, task = candidate.patch.tasks.find(task => task.id === substitution.taskId), person = show.resources.find(row => row.id === substitution.personId && row.kind === "person"), previous = show.resources.find(row => row.id === substitution.replacesPersonId && row.kind === "person");
    if (!task || !person || !previous || !task.resources.includes(previous.id) || task.resources.includes(person.id) || task.cancellation || task.state === "complete" || task.milestone || task.lane === "commercial" || Date.parse(task.start) < Date.parse(show.clock)) throw new DomainError("STRATEGY_ASSIGNMENT_MISSING", "Choose one original assigned person on a future uncompleted work task and a distinct current admitted replacement.");
    task.resources = task.resources.map(id => id === previous.id ? person.id : id); approval(candidate, "crew-substitution", "Review the exact changed person and call", "producer");
  }
  const original = buildCandidate(show, offer, "doors", now), additionalMinutes = Math.max(0, minutesBetween(original.patch.crewFinishAt, candidate.patch.crewFinishAt));
  const affected = show.resources.filter(person => person.kind === "person" && candidate.patch.tasks.some(task => task.critical && task.resources.includes(person.id)));
  const additionalMinor = Math.ceil(additionalMinutes * affected.reduce((sum, person) => sum + person.rateMinor, 0) / 60);
  candidate.patch.overtimeMinor = original.patch.overtimeMinor + additionalMinor;
  candidate.patch.changedPeople = show.resources.filter(person => person.kind === "person" && candidate.patch.tasks.some(task => { const old = show.tasks.find(row => row.id === task.id); return (task.resources.includes(person.id) || old?.resources.includes(person.id)) && (!old || old.start !== task.start || old.end !== task.end || digest(old.resources) !== digest(task.resources)); })).map(person => person.id);
  candidate.cost.overtimeMinor = candidate.patch.overtimeMinor; candidate.cost.totalMinor = candidate.cost.rentalMinor + candidate.cost.overtimeMinor + candidate.cost.remedyMinor;
  candidate.name = name; candidate.summary = generator ? "Model-proposed typed variation, constructed and checked by the same bounded rules as the deterministic families. The model's rationale is untrusted commentary; original source, technical duties, artist consent, supplier evidence and current publication remain separate requirements." : "Typed bounded variation. Original source, technical duties, artist consent, supplier evidence and current publication remain separate requirements.";
  const semanticDigest = digest({ tasks: candidate.patch.tasks, dependencies: candidate.patch.dependencies, doorsAt: candidate.patch.doorsAt, offer: [offer.id, offer.revision] });
  candidate.strategy = { version: 1, kind, parameters, sourceDigest: strategyScopeDigest(show), semanticDigest, policyVersion: show.policy.version, rateDigest: digest(show.resources.map(({ id, rateMinor }) => ({ id, rateMinor }))), costBasis: "Existing recovery overtime plus additional proposed call minutes at retained roster rates. Forecast only; approved hours and payment remain separate.", ...(generator ? { generator } : {}) };
  candidate.id = generator ? `model-${kind}-${digest({ offer: offer.id, parameters, run: show.runs.length, output: generator.outputDigest, index: generator.index }).slice(0, 20)}` : `strategy-${kind}-${digest({ offer: offer.id, parameters, run: show.runs.length }).slice(0, 20)}`;
  candidate.digest = digest({ patch: candidate.patch, approvals: candidate.approvals, cost: candidate.cost, strategy: candidate.strategy });
  candidate.report = validatePatch(show, candidate.patch, offer);
  for (const task of candidate.patch.tasks.filter(task => !task.cancellation && task.state !== "complete")) {
    if ((task.sourceConstraints?.amplified || ["support", "headliner", "headliner-check", "support-check"].includes(task.id)) && Date.parse(task.end) > Date.parse(show.curfewAt)) candidate.report.issues.push({ code: "STRATEGY_AMPLIFIED_CURFEW", stage: "semantic", severity: "hard", message: `${task.name} exceeds the retained amplified curfew.`, taskId: task.id, resourceId: null, sourceId: task.sourceId });
    for (const id of task.resources) { const person = show.resources.find(row => row.id === id); if (person?.kind === "person" && (Date.parse(task.start) < Date.parse(person.availableFrom) || Date.parse(task.end) > Date.parse(person.availableUntil) || person.reserve && task.critical)) candidate.report.issues.push({ code: "STRATEGY_CREW_WINDOW", stage: "semantic", severity: "hard", message: `${person.name} is outside their current active availability.`, taskId: task.id, resourceId: id, sourceId: task.sourceId }); }
  }
  if (kind === "running_order") candidate.report.issues.push({ code: "RUNNING_ORDER_CUE_POLICY", stage: "authority", severity: "unknown", message: "Headliner-first requires a separately sourced current cue policy; this diagnostic proposal cannot reuse the support-first cue gates.", taskId: "headliner", resourceId: null, sourceId: "crew-policy-v1" });
  if (kind === "crew_substitution") {
    const previous = show.resources.find(row => row.id === parameters.replacesPersonId), replacement = show.resources.find(row => row.id === parameters.personId);
    if (previous && replacement && previous.skills.some(skill => !replacement.skills.includes(skill))) candidate.report.issues.push({ code: "STRATEGY_CREW_COMPLEMENT", stage: "semantic", severity: "hard", message: "The proposed person does not cover the replaced person's current declared qualifications. Admit separately reviewed requirements before changing the crew complement.", taskId: String(parameters.taskId), resourceId: replacement.id, sourceId: "crew-policy-v1" });
  }
  candidate.report.status = candidate.report.issues.some(issue => issue.severity === "hard") ? "infeasible" : candidate.report.issues.some(issue => issue.severity === "unknown") ? "unknown_pending_evidence" : "feasible_with_approval";
  return candidate;
}
export function enumerateStrategies(show: ShowSnapshot, request: StrategyRequest, now = new Date().toISOString()): Candidate[] {
  strategyRequestSchema.parse(request);
  if (show.cancellationDecision) throw new DomainError("STRATEGY_CANCELLED_PROGRAMME", "A cancelled programme stays cancelled. Use its retained support-only recovery or cancellation workflow.");
  const offers = request.offerIds.map(id => { const offer = show.offers.find(row => row.id === id); if (!offer) throw new DomainError("STRATEGY_OFFER_CHANGED", "A selected current supplier offer is unavailable."); return offer; });
  const rows: Candidate[] = [];
  for (const offer of offers) for (const kind of request.kinds) {
    const grid: StrategyProvenance["parameters"][] = kind === "doors_window" ? [15, 30, 45].map(minutes => ({ minutes })) : kind === "set_length" ? [60, 75].map(minutes => ({ minutes })) : kind === "quiet_preparation" ? [30, 45, 60].map(minutes => ({ minutes })) : kind === "stage_soundcheck" ? [20, 40, 60].map(minutes => ({ minutes })) : kind === "running_order" ? [{ order: "headliner_first" }] : request.substitutions;
    for (const parameters of grid) rows.push(strategyCandidate(show, offer, kind, parameters, now));
  }
  if (!rows.length || rows.length > 128) throw new DomainError("STRATEGY_BOUND", "Choose a nonempty bounded set of typed alternatives.", 400);
  return rows;
}
export function strategyMetrics(candidates: Candidate[], doorsAt: string) {
  const comparable = candidates.filter(candidate => ["feasible", "feasible_with_approval"].includes(candidate.report.status) && candidate.report.engine?.status === "passed");
  const vector = (candidate: Candidate) => [Math.abs(minutesBetween(doorsAt, candidate.patch.doorsAt)), candidate.cost.totalMinor, candidate.patch.changedPeople.length, candidate.approvals.length];
  const pareto = comparable.filter(candidate => !comparable.some(other => { if (other === candidate) return false; const a = vector(other), b = vector(candidate); return a.every((value, i) => value <= b[i]!) && a.some((value, i) => value < b[i]!); })).map(candidate => candidate.id);
  return { attempts: candidates.length, uniquePatches: new Set(candidates.map(candidate => candidate.strategy?.semanticDigest ?? candidate.digest)).size, feasible: comparable.length, rejected: candidates.filter(candidate => candidate.report.status === "infeasible").length, unknown: candidates.filter(candidate => candidate.report.status === "unknown_pending_evidence").length, pareto, basis: "Non-dominated among this bounded evaluated set only: doors deviation, forecast incremental cost, changed people and named approvals. No global optimum or actual cost is claimed." };
}
