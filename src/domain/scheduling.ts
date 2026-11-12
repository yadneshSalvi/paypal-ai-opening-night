import type { Candidate, ConstraintIssue, ConstraintReport, Dependency, PlanPatch, ShowSnapshot, SupplierOffer, Task } from "./contracts";
import { atVenue, compareInstants, localTime, minutesBetween, plusMinutes, restLabel } from "./time";
import { digest } from "./hash";
import { effectiveDelivery, latestSupplierDisruption, supplierInterruption } from "./disruptions";
import { productionInputIssues } from "./production-inputs/constraints";

export function planningDigest(show: ShowSnapshot): string {
  return digest({ tasks: show.tasks, dependencies: show.dependencies, resources: show.resources, offers: show.offers, policy: show.policy, incidents: show.incidents, doorsAt: show.doorsAt, ...(show.supplierDisruptions?.length ? { supplierDisruptions: show.supplierDisruptions } : {}), ...(show.supplierTermRevisions?.length ? { supplierTermRevisions: show.supplierTermRevisions } : {}), ...(show.productionInputs ? { productionInputs: show.productionInputs.digest, curfewAt: show.curfewAt, accessUntil: show.accessUntil } : {}) });
}
export function topologicalOrder(tasks: Task[], dependencies: Dependency[]): { order: string[]; invalid: string[] } {
  const ids = new Set(tasks.map(t => t.id)); const degree = new Map(tasks.map(t => [t.id, 0]));
  const adjacency = new Map<string, string[]>(); const invalid: string[] = [];
  if (ids.size !== tasks.length) invalid.push("Duplicate task identity");
  if (new Set(dependencies.map(d => d.id)).size !== dependencies.length) invalid.push("Duplicate dependency identity");
  for (const edge of dependencies) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) { invalid.push(`Missing dependency ${edge.id}`); continue; }
    degree.set(edge.to, degree.get(edge.to)! + 1); adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }
  const queue = [...degree].filter(([, count]) => count === 0).map(([id]) => id); const order: string[] = [];
  while (queue.length) { const id = queue.shift()!; order.push(id); for (const to of adjacency.get(id) ?? []) { degree.set(to, degree.get(to)! - 1); if (degree.get(to) === 0) queue.push(to); } }
  if (order.length !== tasks.length) invalid.push("Dependency cycle");
  return { order, invalid };
}
export function affectedSubgraph(dependencies: Dependency[], starting: string[]): string[] {
  const affected = new Set(starting); const queue = [...starting];
  while (queue.length) { const id = queue.shift(); for (const edge of dependencies) if (edge.from === id && !affected.has(edge.to)) { affected.add(edge.to); queue.push(edge.to); } }
  return [...affected];
}
/** Shared by whole-plan validation and the AI assignment tool; one policy source. */
export function qualificationIssues(show: Pick<ShowSnapshot, "resources" | "productionInputs">, task: Task): ConstraintIssue[] {
  if (!task.requiredSkill) return [];
  return task.resources.flatMap(id => {
    const resource = show.resources.find(item => item.id === id);
    return resource?.skills.includes(task.requiredSkill!) ? [] : [{ code: "QUALIFICATION", stage: "semantic" as const, severity: "hard" as const, message: `${resource?.name ?? id} lacks ${task.requiredSkill!.replaceAll("_", " ")}.`, resourceId: id, taskId: task.id, sourceId: show.productionInputs?.roster.find(item => item.personId === id)?.sourceIds[0] ?? "crew-policy-v1" }];
  });
}
export function validatePatch(show: ShowSnapshot, patch: PlanPatch, offer: SupplierOffer): ConstraintReport {
  const issues: ConstraintIssue[] = [];
  const add = (code: string, stage: ConstraintIssue["stage"], severity: ConstraintIssue["severity"], message: string, resourceId: string | null = null, taskId: string | null = null, sourceId = "venue-policy-v1") => issues.push({ code, stage, severity, message, resourceId, taskId, sourceId });
  const rulesChecked = ["SCHEMA", "ACYCLIC_GRAPH", "DEPENDENCIES", "QUALIFICATION", "RESOURCE_EXCLUSIVITY", "CURFEW", "VENUE_ACCESS", "CREW_REST", "OFFER_FRESHNESS", "SUPPLIER_EVIDENCE", "ARTIST_ARRIVAL", "DOORS_SEQUENCE"];
  if (show.productionInputs) { issues.push(...productionInputIssues(show, patch.tasks)); rulesChecked.push("ADMITTED_ROSTER_AVAILABILITY", "ADMITTED_QUALIFICATION_EXPIRY", "ADMITTED_VENUE_POLICY"); }
  const interruption = supplierInterruption(show, offer);
  if (interruption) {
    rulesChecked.push("SUPPLIER_DISRUPTION");
    if (interruption.availability === "unavailable") add("SUPPLIER_UNAVAILABLE", "evidence", "hard", "The attributed supplier report withdraws this exact unit. A quote cannot prove available capacity.", offer.unitId, "rental-delivery", interruption.id);
    else add("SUPPLIER_TERMS_RECONFIRMATION", "evidence", "unknown", "Obtain new authenticated terms after this supplier report before approving a replacement commitment.", offer.unitId, "rental-delivery", interruption.id);
  }
  if (show.cancellationDecision?.mode === "cancel_show" || show.cancellationDecision?.mode === "support_only" && (patch.programMode !== "support_only" || patch.tasks.some(task => show.cancellationDecision!.cancelledTaskIds.includes(task.id)))) add("PROGRAM_CANCELLED", "authority", "hard", "The producer has cancelled part of this running order. A rescue proposal cannot reinstate it.", null, "headliner", show.cancellationDecision.id);
  if (!Number.isSafeInteger(offer.feeMinor) || offer.feeMinor < 0 || !Number.isSafeInteger(patch.overtimeMinor) || patch.overtimeMinor < 0) add("INVALID_MONEY", "schema", "hard", "All financial amounts must be nonnegative integer cents.");
  for (const message of topologicalOrder(patch.tasks, patch.dependencies).invalid) add("GRAPH_INVALID", "graph", "hard", message);
  const byId = new Map(patch.tasks.map(task => [task.id, task]));
  for (const dep of patch.dependencies) {
    const from = byId.get(dep.from); const to = byId.get(dep.to);
    if (from && to && compareInstants(plusMinutes(from.end, dep.lagMinutes), to.start) > 0) add("DEPENDENCY_ORDER", "temporal", "hard", `${to.name} starts before ${from.name} clears.`, null, to.id);
  }
  for (const task of patch.tasks) {
    if (minutesBetween(task.start, task.end) !== task.durationMinutes || task.durationMinutes < 0) add("DURATION_INVALID", "schema", "hard", `${task.name} has an invalid time interval.`, null, task.id);
    issues.push(...qualificationIssues(show, task));
    if (task.sourceConstraints) {
      const bounds = task.sourceConstraints;
      if (bounds.earliestStart && compareInstants(task.start, bounds.earliestStart) < 0) add("SOURCE_EARLIEST_START", "temporal", "hard", `${task.name} begins before its reviewed source window.`, null, task.id, task.sourceId);
      if (bounds.latestEnd && compareInstants(task.end, bounds.latestEnd) > 0) add("SOURCE_LATEST_END", "temporal", "hard", `${task.name} ends after its reviewed source window.`, null, task.id, task.sourceId);
      if (bounds.amplified && compareInstants(task.end, show.curfewAt) > 0) add("SOURCE_AMPLIFIED_CURFEW", "semantic", "hard", `${task.name} extends beyond the reviewed amplified audio curfew.`, null, task.id, task.sourceId);
    }
  }
  const active = patch.tasks.filter(t => t.critical && t.state !== "complete" && t.durationMinutes > 0 && (t.lane !== "people" || Boolean(t.sourceConstraints)));
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    const a = active[i], b = active[j];
    if (compareInstants(a.start, b.end) < 0 && compareInstants(b.start, a.end) < 0) for (const id of a.resources.filter(id => b.resources.includes(id))) add("RESOURCE_OVERLAP", "temporal", "hard", `${show.resources.find(r => r.id === id)?.name ?? id}: ${a.name} overlaps ${b.name}.`, id, b.id, "crew-policy-v1");
  }
  const performance = byId.get("headliner");
  if (performance && compareInstants(performance.end, show.curfewAt) > 0) add("CURFEW", "semantic", "hard", `Amplified audio ends ${localTime(performance.end)} after the hard 23:00 curfew.`, null, "headliner");
  if (compareInstants(patch.crewFinishAt, show.accessUntil) > 0) add("VENUE_ACCESS", "semantic", "hard", "Quiet strike extends beyond the authorized 00:45 access window.", null, "strike");
  const rest = minutesBetween(patch.crewFinishAt, show.nextCallAt);
  for (const id of ["sam", "priya"]) if (rest < show.policy.minimumRestMinutes) add("CREW_REST", "semantic", "hard", `${show.resources.find(r => r.id === id)?.name}: rest ${restLabel(rest)} < 10h before Sunday’s call.`, id, "strike", "crew-policy-v1");
  if (!offer.compatible) add("CONSOLE_COMPATIBILITY", "semantic", "hard", "The offered console does not meet the approved compatibility requirement.", "console");
  if (offer.qualifiedDriver !== true) add("DRIVER_UNKNOWN", "evidence", "unknown", "A qualified collection driver has not been confirmed.", null, "rental-delivery", offer.id);
  if (offer.conditionVerified !== true) add("CONDITION_UNKNOWN", "evidence", "unknown", "The loan console’s condition report is still missing.", "console", "rental-delivery", offer.id);
  if (show.commercialProtocol === 2 && !offer.serviceQuote) add("AUTHENTICATED_QUOTE_REQUIRED", "evidence", "unknown", "Request the enrolled supplier's authenticated current terms before approving this plan.", null, null, offer.id);
  if (show.commercialProtocol === 2 && offer.serviceQuote && Date.parse(offer.serviceQuote.validUntil) <= Date.now()) add("REAL_TIME_QUOTE_EXPIRED", "evidence", "hard", "The supplier quote expired in real time. Collect fresh terms and recompute.", null, null, offer.id);
  if (compareInstants(show.clock, offer.expiresAt) >= 0 || offer.status === "expired") add("QUOTE_EXPIRED", "evidence", "hard", "This quote expired or the supplier declined the current request. Obtain current terms before approval.", null, null, offer.id);
  const terms = show.supplierTermRevisions?.find(item => item.supplierId === offer.supplierId);
  if (terms && (offer.serviceQuote?.termsSource?.id !== terms.id || offer.serviceQuote.termsSource.digest !== terms.digest)) add("SUPPLIER_TERMS_CHANGED", "evidence", "hard", "This offer predates the supplier's current attributed terms. Collect and validate a fresh signed quote.", offer.unitId, null, terms.id);
  if (patch.offerRevision !== offer.revision) add("QUOTE_CHANGED", "authority", "hard", "The supplier revised this quote; generate a new candidate.", null, null, offer.id);
  if (patch.policyVersion !== show.policy.version) add("POLICY_CHANGED", "authority", "hard", "The operating policy changed after this proposal.");
  const focus = byId.get("lx-focus"); const cues = byId.get("lx-program");
  if (focus && compareInstants(focus.start, plusMinutes(effectiveDelivery(show, offer), 15)) < 0) add("DELIVERY_WINDOW", "temporal", "hard", "Lighting focus begins before the latest attributed delivery, acceptance and handover can clear.", "console", "lx-focus", latestSupplierDisruption(show, offer)?.id ?? offer.id);
  if (cues && compareInstants(plusMinutes(cues.end, 5), patch.doorsAt) > 0) add("DOORS_SEQUENCE", "temporal", "hard", `Cue validation finishes ${localTime(cues.end)}; doors need a five-minute handover.`, null, "doors");
  if (patch.programMode !== "support_only" && compareInstants(patch.headlinerAt, atVenue("19:35")) < 0) add("ARTIST_ARRIVAL", "temporal", "hard", "The headliner cannot perform before the 19:35 on-site arrival.", null, "headliner", "flight-final");
  const status = issues.some(i => i.severity === "hard") ? "infeasible" : issues.some(i => i.severity === "unknown") ? "unknown_pending_evidence" : "feasible_with_approval";
  return { status, issues, rulesChecked, engine: null };
}

export function buildCandidate(show: ShowSnapshot, offer: SupplierOffer, family: Candidate["family"], now = new Date().toISOString()): Candidate {
  const supportOnly = show.cancellationDecision?.mode === "support_only";
  const deliveryAt = effectiveDelivery(show, offer);
  let focusStart = plusMinutes(deliveryAt, 15);
  if (family === "direct") focusStart = atVenue("15:30");
  const cueStart = plusMinutes(focusStart, 45); const cueEnd = plusMinutes(cueStart, 20); const earliestDoors = plusMinutes(cueEnd, 5);
  const doorsAt = family === "doors" || family === "direct" ? atVenue("19:00") : family === "artist" ? atVenue("20:35") : compareInstants(earliestDoors, atVenue("19:00")) > 0 ? earliestDoors : atVenue("19:00");
  const late = compareInstants(doorsAt, atVenue("19:00")) > 0;
  const supportAt = family === "artist" ? atVenue("20:40") : late ? plusMinutes(doorsAt, 20) : atVenue("20:00");
  const headlinerAt = family === "artist" ? atVenue("21:25") : late ? plusMinutes(supportAt, 45) : atVenue("20:45");
  const crewFinishAt = supportOnly ? show.tasks.find(task => task.id === "strike")?.end ?? atVenue("23:30") : family === "artist" ? atVenue("00:30", "2026-11-15") : atVenue("23:30");
  const headlinerDuration = family === "budget" && late ? 75 : 90;
  const overtimeMinor = family === "artist" ? 36000 : late ? 24000 : 18000;
  const tasks = structuredClone(show.tasks).filter(t => !["headliner-check", "vip", "rental-authorized", "rental-delivery", "rental-captured", "quiet-prep"].includes(t.id) && !(supportOnly && show.cancellationDecision!.cancelledTaskIds.includes(t.id)));
  const update = (id: string, start: string, duration: number, resources?: string[]) => { const t = tasks.find(t => t.id === id); if (t) Object.assign(t, { start, end: plusMinutes(start, duration), durationMinutes: duration, state: "planned", affected: start !== t.baselineStart, ...(resources ? { resources } : {}) }); };
  update("headliner-arrival", atVenue("19:35"), 0); update("lx-focus", focusStart, 45); update("lx-program", cueStart, 20, family === "direct" ? ["tom"] : show.productionInputs ? show.tasks.find(task => task.id === "lx-program")?.resources ?? [] : ["priya"]);
  const readinessAt = compareInstants(plusMinutes(doorsAt, -15), cueEnd) >= 0 ? plusMinutes(doorsAt, -15) : cueEnd;
  update("readiness", readinessAt, 0); update("doors", doorsAt, 0); update("support", supportAt, 25); update("changeover", plusMinutes(supportAt, 25), late && family !== "artist" ? 20 : 15); update("headliner", headlinerAt, headlinerDuration);
  const supportEnd = plusMinutes(supportAt, 25), retainedStrikeStart = show.tasks.find(task => task.id === "strike")?.start ?? supportEnd;
  const performanceEnd = supportOnly ? compareInstants(retainedStrikeStart, supportEnd) > 0 ? retainedStrikeStart : supportEnd : plusMinutes(headlinerAt, headlinerDuration); update("strike", performanceEnd, minutesBetween(performanceEnd, crewFinishAt));
  const newTask = (id: string, name: string, lane: Task["lane"], start: string, duration: number, resources: string[] = []): Task => ({ id, name, lane, start, end: plusMinutes(start, duration), durationMinutes: duration, baselineStart: start, baselineEnd: plusMinutes(start, duration), resources, requiredSkill: null, state: "blocked", critical: true, affected: true, milestone: id, sourceId: offer.id });
  const authorizationAt = compareInstants(show.clock, atVenue("16:10")) > 0 ? show.clock : atVenue("16:10");
  tasks.push(newTask("rental-authorized", "Rental authorized · PayPal", "commercial", authorizationAt, 0), newTask("rental-delivery", "Console delivered & accepted", "commercial", deliveryAt, 0), newTask("rental-captured", "Rental fee captured · PayPal", "commercial", plusMinutes(deliveryAt, 5), 0));
  if (!supportOnly) tasks.push(newTask("quiet-prep", "Artist quiet preparation · sound lead sign-off required", "audio", atVenue("19:40"), 30, ["backstage"]));
  const ids = new Set(tasks.map(t => t.id));
  const dependencies = [...new Map(show.dependencies.filter(d => ids.has(d.from) && ids.has(d.to) && !(d.from === "console-test" && d.to === "lx-focus")).map(d => [d.id, { ...d }])).values()];
  const addEdge = (from: string, to: string, financial = false) => { const edge = { id: `${from}:${to}`, from, to, lagMinutes: 0, financial }; const existing = dependencies.findIndex(d => d.id === edge.id); if (existing < 0) dependencies.push(edge); else dependencies[existing] = edge; };
  addEdge("rental-authorized", "rental-delivery", true); addEdge("rental-delivery", "rental-captured", true); addEdge("rental-captured", "lx-focus", true); if (!supportOnly) addEdge("headliner-arrival", "quiet-prep");
  const patch: PlanPatch = { baseRevision: show.revision, offerId: offer.id, offerRevision: offer.revision, policyVersion: show.policy.version, tasks, dependencies, doorsAt, supportAt, headlinerAt, crewFinishAt, overtimeMinor, canceledPerk: true, changedPeople: late ? ["sam", "priya", "tom", "dana", "lee", "avery"] : ["priya", "tom", "dana", "lee"], ...(supportOnly ? { programMode: "support_only" as const } : {}) };
  const approvals: Candidate["approvals"] = supportOnly ? [{ id: "support-only", label: "Support-only plan; headliner remains cancelled", role: "producer", grantedBy: null }, { id: "retained-crew-calls", label: "Retain existing crew finish and separate compensation", role: "producer", grantedBy: null }] : [{ id: "vip-cancellation", label: "VIP soundcheck canceled", role: "producer", grantedBy: null }, { id: "support-first", label: "Support-first running order", role: "producer", grantedBy: null }, { id: "quiet-prep-protocol", label: "Quiet preparation protocol", role: "department_lead", grantedBy: null }];
  if (late) approvals.push({ id: "doors-delay", label: `Doors ${localTime(doorsAt)}`, role: "producer", grantedBy: null });
  if (!supportOnly && headlinerDuration === 75) approvals.push({ id: "artist-set", label: "Headliner set −15 min", role: "artist_representative", grantedBy: null });
  const names = { doors: "Protect doors", budget: "Protect budget", artist: "Protect artist", direct: "Keep original calls" };
  const summaries = { doors: "Keep the house opening at 19:00. A faster console, support first, and a precise VIP remedy.", budget: "Trade a later opening for a lower rental fee. The shorter artist set needs separate approval.", artist: "Preserve a longer artist preparation window. Sunday’s crew rest makes this a diagnostic plan.", direct: "Keep original calls and move programming to Tom. Validation must establish delivery and qualifications." };
  const remedyMinor = supportOnly ? show.cancellationDecision!.targets.reduce((sum, target) => sum + target.admissionMinor + target.perkMinor, 0) : 57000;
  const cost = { rentalMinor: offer.feeMinor, overtimeMinor, remedyMinor, totalMinor: offer.feeMinor + overtimeMinor + remedyMinor };
  return { id: `${family}-${offer.supplierId}-${show.runs.length + 1}`, family, name: supportOnly ? "Support only · " + names[family] : names[family], summary: supportOnly ? "Keep the headliner cancelled. Revalidate the support program with current supplier terms, retained crew calls and the separately approved ticket remedy." : summaries[family], digest: digest({ patch, approvals, cost }), sourceDigest: planningDigest(show), generatedAt: now, patch, approvals, report: validatePatch(show, patch, offer), cost };
}
export function enumerateCandidates(show: ShowSnapshot, now = new Date().toISOString()): Candidate[] { return show.offers.flatMap(offer => (["doors", "budget", "artist", "direct"] as const).map(family => buildCandidate(show, offer, family, now))); }
export function candidateFunnel(candidates: Candidate[]) {
  const rejected = candidates.filter(c => c.report.status === "infeasible"); const reasons: Record<string, number> = {};
  for (const c of rejected) for (const code of new Set(c.report.issues.filter(i => i.severity === "hard").map(i => i.code))) reasons[code] = (reasons[code] ?? 0) + 1;
  const passed = (c: Candidate, stages: string[]) => !c.report.issues.some(i => i.severity !== "approval" && stages.includes(i.stage));
  return { generated: candidates.length, schemaValid: candidates.filter(c => passed(c, ["schema", "graph"])).length, temporalValid: candidates.filter(c => passed(c, ["schema", "graph", "temporal"])).length, evidenceValid: candidates.filter(c => passed(c, ["schema", "graph", "temporal", "semantic", "evidence", "authority"])).length, approvable: candidates.filter(c => c.report.status === "feasible" || c.report.status === "feasible_with_approval").length, rejected: rejected.length, pending: candidates.filter(c => c.report.status === "unknown_pending_evidence").length, reasons };
}
export function namedCandidates(candidates: Candidate[]): Candidate[] { return [candidates.find(c => c.family === "doors" && c.patch.offerId.includes("brightline")), candidates.find(c => c.family === "budget" && c.patch.offerId.includes("northside")), candidates.find(c => c.family === "artist" && c.patch.offerId.includes("brightline"))].filter((c): c is Candidate => Boolean(c)); }
