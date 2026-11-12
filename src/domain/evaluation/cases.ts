import { performance } from "node:perf_hooks";
import type { Candidate, EngineReport } from "../contracts";
import { buildCandidate, candidateFunnel, enumerateCandidates, planningDigest, validatePatch } from "../scheduling";
import { applyCommand } from "../commands";
import { financialSummary } from "../finance";
import { readiness } from "../readiness";
import { digest } from "../hash";
import { atVenue, localTime, minutesBetween, plusMinutes } from "../time";
import { candidatePlan, evaluateTour } from "../tour/constraints";
import { plusMinutes as tourPlusMinutes, zoned } from "../tour/time";
import { sampleTime } from "../tour/fixture";
import { fixtureId, FIXTURE_NOW, reservedTickets, singleFixture, tourFixture } from "./fixtures";
import type { CaseContract, CaseObservation, EngineObservation, EvaluationFinding } from "./contracts";
import declaredCorpus from "./corpus-v3.json";

type Measures = CaseObservation["measurements"];
interface RawObservation { status: string; findings: EvaluationFinding[]; measurements: Measures; engine: EngineObservation | null; output: unknown }
export interface CaseExecution { observation: CaseObservation; input: unknown; output: unknown }
export function engineObservation(report: EngineReport, taskCount: number): EngineObservation {
  return { status: report.status, scope: "product_temporal", version: "8.0.0", durationMs: report.durationMs, inputDigest: report.inputDigest, resultDigest: digest([...report.dates].sort((a,b) => a.id.localeCompare(b.id))), taskCount, resourceCount: 0, assignmentCount: 0, reason: safeReason(report.reason) };
}
export function safeReason(reason: string | null): string | null {
  if (!reason) return null;
  if (/license|secret|token|credential|(?:\/Users\/|\/home\/)|[A-Za-z0-9_-]{80,}/i.test(reason)) return "Engine configuration unavailable; no proposal is qualified by this result.";
  return reason.slice(0, 300);
}
const domainCode = (error: unknown) => typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "EVALUATION_EXCEPTION";
const errorFinding = (error: unknown): EvaluationFinding => ({ code: domainCode(error), severity: "hard", message: "The actual domain boundary rejected the controlled input.", subjects: [] });

async function candidates(show: ReturnType<typeof singleFixture>["show"], engine: boolean) {
  return engine ? (await import("../../server/engine")).generateCandidates(show) : enumerateCandidates(show);
}
async function singleCase(contract: CaseContract, useEngine: boolean, capture: (input: unknown) => void): Promise<RawObservation> {
  const { show, actor } = singleFixture(), name = contract.scenario;
  if (name === "all_incompatible" || name === "all_evidence_unknown") {
    for (const offer of show.offers) if (name === "all_incompatible") offer.compatible = false; else { offer.qualifiedDriver = null; offer.conditionVerified = null; }
    capture(show);
    const generated = await candidates(show, useEngine), funnel = candidateFunnel(generated);
    const findings = generated.flatMap(candidate => candidate.report.issues.map(issue => ({ code: issue.code, severity: issue.severity, message: issue.message, subjects: [candidate.id, issue.resourceId, issue.taskId].filter((id): id is string => Boolean(id)) })));
    return { status: funnel.approvable === 0 ? "no_approvable" : "approvable", findings, measurements: { generated: generated.length, approvable: funnel.approvable, unresolved: generated.filter(candidate => candidate.report.status === "unknown_pending_evidence").length, engineUnavailable: generated.filter(candidate => candidate.report.engine?.status === "unavailable").length }, engine: null, output: { generated, funnel } };
  }
  const family = name === "northside_budget" ? "budget" : name === "artist_rest" ? "artist" : name === "direct_skill" ? "direct" : "doors";
  const offer = show.offers.find(offer => offer.supplierId === (name === "northside_budget" ? "northside" : name === "sister_unknown" ? "sister" : "brightline"))!;
  const candidate = buildCandidate(show, offer, family, FIXTURE_NOW), patch = candidate.patch;
  switch (name) {
    case "expired_offer": show.clock = atVenue("16:46"); break;
    case "quote_revision": offer.revision++; break;
    case "policy_revision": show.policy.version++; break;
    case "tight_curfew": show.curfewAt = atVenue("22:00"); break;
    case "tight_access": show.accessUntil = atVenue("23:00"); break;
    case "twelve_hour_rest": show.policy.minimumRestMinutes = 720; break;
    case "incompatible_console": offer.compatible = false; break;
    case "unknown_driver": offer.qualifiedDriver = null; break;
    case "unknown_condition": offer.conditionVerified = null; break;
    case "source_earliest": patch.tasks.find(task => task.id === "lx-focus")!.sourceConstraints = { amplified: false, earliestStart: atVenue("18:00"), latestEnd: null, compilationId: "controlled-computational-source" }; break;
    case "source_latest": patch.tasks.find(task => task.id === "lx-program")!.sourceConstraints = { amplified: false, earliestStart: null, latestEnd: atVenue("18:20"), compilationId: "controlled-computational-source" }; break;
    case "source_amplified": show.curfewAt = atVenue("22:00"); patch.tasks.find(task => task.id === "headliner")!.sourceConstraints = { amplified: true, earliestStart: null, latestEnd: null, compilationId: "controlled-computational-source" }; break;
    case "resource_overlap": patch.tasks.push({ ...structuredClone(patch.tasks.find(task => task.id === "lx-focus")!), id: "computational-second-focus" }); break;
    case "lost_skill": show.resources.find(resource => resource.id === "priya")!.skills = ["lx_focus", "rigging"]; break;
    case "duration_mismatch": { const task = patch.tasks.find(task => task.id === "lx-program")!; task.end = plusMinutes(task.end, 1); break; }
    case "duplicate_task": patch.tasks.push(structuredClone(patch.tasks[0]!)); break;
    case "dependency_cycle": { const edge = patch.dependencies[0]!; patch.dependencies.push({ id: "computational-cycle", from: edge.to, to: edge.from, lagMinutes: 0, financial: false }); break; }
    case "missing_endpoint": patch.dependencies.push({ id: "computational-missing", from: "not-a-canonical-task", to: "doors", lagMinutes: 0, financial: false }); break;
    case "duplicate_dependency": patch.dependencies.push(structuredClone(patch.dependencies[0]!)); break;
    case "negative_fee": offer.feeMinor = -1; break;
    case "negative_overtime": patch.overtimeMinor = -1; break;
    case "authenticated_quote_absent": show.commercialProtocol = 2; break;
    case "delivery_slip": offer.deliveryAt = atVenue("18:45"); break;
  }
  if (["stale_source_command", "expired_command", "wrong_role_command"].includes(name)) {
    // A missing engine proof must not be an alternative explanation for S32's refusal.
    // Obtain a genuine successful temporal proof before expiring its current offer.
    let commandEngine:EngineObservation|null=null;
    if(name==="expired_command"&&useEngine){candidate.report.engine=await(await import("../../server/engine")).commitEngine(candidate);commandEngine=engineObservation(candidate.report.engine,candidate.patch.tasks.length);}
    show.runs.push({ id: fixtureId(500), baseRevision: show.revision, createdAt: FIXTURE_NOW, completedAt: FIXTURE_NOW, candidates: [candidate], source: "modelled", strategySource: "deterministic_enumerator" });
    if (name === "stale_source_command") offer.feeMinor -= 1000;
    if (name === "expired_command") show.clock = atVenue("16:46");
    const caller = name === "wrong_role_command" ? { ...actor, roles: [] } : actor;
    capture({ show, caller, command: { type: "approve", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: [] } });
    try {
      // Negative boundaries only. No positive approval,forged consent or engine double is supplied.
      const result = applyCommand(show, caller, { type: "approve", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: [] }, FIXTURE_NOW);
      return { status: "unexpected_acceptance", findings: [], measurements: { approved: Boolean(result.approvedPlan) }, engine: commandEngine, output: result };
    } catch (error) {const currentValidation=validatePatch(show,patch,offer);return { status: "rejected", findings: [errorFinding(error),...currentValidation.issues.map(issue=>({code:issue.code,severity:issue.severity,message:issue.message,subjects:[issue.taskId,issue.resourceId].filter((id):id is string=>Boolean(id))}))], measurements: { approved: Boolean(show.approvedPlan), sourceStillCurrent: candidate.sourceDigest === planningDigest(show),engineProofPassed:commandEngine?.status==="passed" }, engine: commandEngine, output: { rejectedCode: domainCode(error),currentValidation,engine:commandEngine } }; }
  }
  capture({ show, patch, offer });
  const report = validatePatch(show, patch, offer);
  let engine: EngineObservation | null = null;
  if (useEngine && !report.issues.some(issue => issue.code === "GRAPH_INVALID")) engine = engineObservation(await (await import("../../server/engine")).commitEngine(candidate), patch.tasks.length);
  const measurements: Measures = { costMinor: candidate.cost.totalMinor, doorsLocal: localTime(patch.doorsAt), crewRestMinutes: minutesBetween(patch.crewFinishAt, show.nextCallAt), artistApprovalRequired: candidate.approvals.some(approval => approval.role === "artist_representative"), approvalsGranted: candidate.approvals.filter(approval => approval.grantedBy !== null).length, changedPeople: patch.changedPeople.length };
  return { status: report.status, findings: report.issues.map(issue => ({ code: issue.code, severity: issue.severity, message: issue.message, subjects: [issue.resourceId, issue.taskId, issue.sourceId].filter((id): id is string => Boolean(id)) })), measurements, engine, output: { report, candidate, engine } };
}

async function tourCase(contract: CaseContract, useEngine: boolean, capture: (input: unknown) => void): Promise<RawObservation> {
  const name = contract.scenario, alternative = name === "tour_early" ? "early" : name === "tour_transfer" ? "transfer" : name === "tour_rail_unknown" ? "rail" : "morning";
  const { tour, productions } = tourFixture(alternative), first = productions[0]!, call = first.calls[0]!;
  switch (name) {
    case "tour_missing_path": tour.legs = []; break;
    case "tour_skill": first.allocations["lighting-programmer"] = "tom"; break;
    case "tour_overlap": { const overlapping = structuredClone(first); overlapping.id = fixtureId(99); productions.push(overlapping); tour.productionIds.push(overlapping.id); break; }
    case "tour_capacity": first.slots.find(slot => slot.id === "console")!.capacity = 2; break;
    case "tour_kind": first.allocations["lighting-tech"] = "tour-console"; break;
    case "tour_availability_unknown": tour.resources.find(resource => resource.id === "priya")!.availabilityStatus = "unknown"; break;
    case "tour_availability_assumption": tour.resources.find(resource => resource.id === "priya")!.availabilityStatus = "assumption"; break;
    case "tour_availability_window": tour.resources.find(resource => resource.id === "sam")!.availability[0]!.end = sampleTime("2026-11-20", "11:00", "America/Denver"); break;
    case "tour_duty": tour.maxDutyMinutes = 300; break;
    case "tour_curfew": first.venue.curfew = zoned(sampleTime(first.showDate, "18:30", first.venue.zone)); break;
    case "tour_access": first.venue.access = zoned(sampleTime(first.showDate, "11:00", first.venue.zone)); break;
    case "tour_earliest": call.earliest = tourPlusMinutes(call.start, 30); break;
    case "tour_latest": call.latest = tourPlusMinutes(call.start, 30); break;
    case "tour_dependency": first.dependencies[0]!.lagMinutes = 300; break;
    case "tour_source_unknown": first.sources[0]!.status = "unknown"; break;
    case "tour_source_assumption": first.sources[0]!.status = "assumption"; break;
    case "tour_unassigned": delete first.allocations.console; break;
    case "tour_policy_unknown": first.minimumRestMinutes = null; break;
    case "tour_ambiguous_path": tour.legs.push({ ...structuredClone(tour.legs[0]!), id: "computational-second-onward", toProductionId: productions[2]!.id }); break;
  }
  const foreignAlternative={ name: "Foreign computational target", explanation: "A rejected scope attack,not an approved change", shifts: [{ productionId: fixtureId(999), callId: "load-in", minutes: 60 }], legOverrides: [] };
  capture(name==="tour_foreign_scope"?{tour,productions,requestedAlternative:foreignAlternative}:{ tour, productions });
  try {
    if (name === "tour_foreign_scope") candidatePlan(tour, productions,foreignAlternative);
    const report = evaluateTour(tour, productions), proof = useEngine ? await (await import("../../server/tour/engine")).tourEngine(productions) : null;
    const engine: EngineObservation | null = proof ? { status: proof.status, scope: "product_temporal", version: "8.0.0", durationMs: proof.elapsedMs, inputDigest: proof.inputDigest, resultDigest: proof.resultDigest, taskCount: proof.tasks, resourceCount: 0, assignmentCount: 0, reason: null } : null;
    return { status: report.status, findings: [...report.hard, ...report.unknown, ...report.approvals].map(issue => ({ code: issue.code, severity: issue.severity, message: issue.message, subjects: [...issue.productionIds, ...issue.callIds, ...issue.resourceIds, ...issue.sourceIds] })), measurements: { samRestMinutes: report.rests.find(rest => rest.resourceId === "sam" && rest.toProductionId === productions[2]!.id)?.restMinutes ?? null, travelMinutes: report.travelMinutes, travelForecastMinor: report.forecast.travelMinor, productionCount: productions.length, taskCount: productions.reduce((sum, production) => sum + production.calls.length, 0), resourceCount: tour.resources.length, approvalsGranted: 0 }, engine, output: { report, engine } };
  } catch (error) { return { status: "rejected", findings: [errorFinding(error)], measurements: {}, engine: null, output: { rejectedCode: domainCode(error) } }; }
}
function timeCase(contract: CaseContract, capture: (input: unknown) => void): RawObservation {
  const name = contract.scenario;
  const timeInputs:Record<string,unknown>={dst_gap:["reject","earlier","later"].map(disambiguation=>({local:"2026-03-08T02:30",zone:"America/Chicago",disambiguation})),dst_fold_reject:{local:"2026-11-01T01:30",zone:"America/Chicago",disambiguation:"reject"},dst_fold_choices:["earlier","later"].map(disambiguation=>({local:"2026-11-01T01:30",zone:"America/Chicago",disambiguation})),cross_zone:[sampleTime("2026-11-20","21:00","America/Denver"),sampleTime("2026-11-20","22:00","America/Chicago")],dst_elapsed:{start:sampleTime("2026-11-01","00:30","America/Chicago"),elapsedMinutes:180},midnight:{start:sampleTime("2026-11-14","23:30","America/Chicago"),elapsedMinutes:90}};
  capture({ scenario: name, timeInputs:timeInputs[name],clockLibrary: "@js-temporal/polyfill@0.5.1", fictional: true });
  let measurements: Measures = {};
  try {
    if (name === "dst_gap") { for (const disambiguation of ["reject", "earlier", "later"] as const) { try { zoned({ local: "2026-03-08T02:30", zone: "America/Chicago", disambiguation }); return { status: "unexpected_acceptance", findings: [], measurements: { acceptedGap: disambiguation }, engine: null, output: {} }; } catch (error) { if (domainCode(error) !== "TOUR_DST_GAP") throw error; } } return { status: "rejected", findings: [{ code: "TOUR_DST_GAP", severity: "hard", message: "All three offset choices reject the nonexistent local clock.", subjects: [] }], measurements: { choicesRejected: 3 }, engine: null, output: { choicesRejected: 3 } }; }
    if (name === "dst_fold_reject") zoned({ local: "2026-11-01T01:30", zone: "America/Chicago", disambiguation: "reject" });
    if (name === "dst_fold_choices") { const earlier = zoned({ local: "2026-11-01T01:30", zone: "America/Chicago", disambiguation: "earlier" }), later = zoned({ local: "2026-11-01T01:30", zone: "America/Chicago", disambiguation: "later" }); measurements = { differenceMinutes: minutesBetween(earlier.instant, later.instant), earlier: earlier.instant, later: later.instant }; }
    if (name === "cross_zone") { const a = zoned(sampleTime("2026-11-20", "21:00", "America/Denver")), b = zoned(sampleTime("2026-11-20", "22:00", "America/Chicago")); measurements = { sameInstant: a.instant === b.instant, denverOffset: a.offset, chicagoOffset: b.offset }; }
    if (name === "dst_elapsed") { const start = zoned(sampleTime("2026-11-01", "00:30", "America/Chicago")), end = tourPlusMinutes(start, 180); measurements = { elapsedMinutes: minutesBetween(start.instant, end.instant), endLocal: end.local }; }
    if (name === "midnight") { const start = zoned(sampleTime("2026-11-14", "23:30", "America/Chicago")), end = tourPlusMinutes(start, 90); measurements = { endLocal: end.local, elapsedMinutes: minutesBetween(start.instant, end.instant) }; }
    return { status: "accepted", findings: [], measurements, engine: null, output: measurements };
  } catch (error) { return { status: "rejected", findings: [errorFinding(error)], measurements, engine: null, output: { rejectedCode: domainCode(error) } }; }
}
async function readinessCase(contract: CaseContract, useEngine: boolean, capture: (input: unknown) => void): Promise<RawObservation> {
  const { show } = singleFixture();
  show.clock = atVenue("19:00");
  if (contract.scenario === "pending_tickets") show.tickets = reservedTickets();
  // The planner needs the earlier offer clock; advancing time cannot manufacture a fresh offer.
  if (contract.scenario === "proposal_not_approval") { const originalClock = show.clock; show.clock = atVenue("15:25"); const proposals = await candidates(show, useEngine); show.clock = originalClock; show.runs.push({ id: fixtureId(600), baseRevision: show.revision, createdAt: FIXTURE_NOW, completedAt: FIXTURE_NOW, candidates: proposals, source: "modelled", strategySource: "deterministic_enumerator" }); }
  capture(show);
  const report = readiness(show, "DOORS", FIXTURE_NOW), finance = financialSummary(show);
  return { status: report.ready ? "ready" : "blocked", findings: report.gates.filter(gate => !gate.complete).map(gate => ({ code: gate.id, severity: "unknown", message: gate.reason, subjects: [] })), measurements: { ready: report.ready, approved: Boolean(show.approvedPlan), acknowledgments: show.acknowledgments.length, ticketRows: show.tickets.length, providerEvidence: show.financialEvidence.length, capturedTickets: finance.capturedTickets, grossCapturedMinor: finance.grossCapturedMinor }, engine: null, output: { report, finance } };
}
export function compareExpectation(contract: CaseContract, raw: Pick<RawObservation, "status" | "findings" | "measurements" | "engine">): string[] {
  const failures: string[] = [], expected = contract.expectation;
  if (raw.status !== expected.status) failures.push(`Expected status ${expected.status}; observed ${raw.status}.`);
  for (const code of expected.requiredCodes) if (!raw.findings.some(finding => finding.code === code)) failures.push(`Missing required finding ${code}.`);
  for (const [name, value] of Object.entries(expected.measurements ?? {})) if (raw.measurements[name] !== value) failures.push(`Expected ${name}=${JSON.stringify(value)}; observed ${JSON.stringify(raw.measurements[name] ?? null)}.`);
  if (expected.engine && raw.engine?.status !== expected.engine) failures.push(`Expected actual engine ${expected.engine}; observed ${raw.engine?.status ?? "not_run"}.`);
  return failures;
}
export async function executeCase(contract: CaseContract, options: { engine: boolean } = { engine: true }): Promise<CaseExecution> {
  const started = performance.now(), heapBefore = process.memoryUsage().heapUsed;
  let input: unknown = { scenario: contract.scenario }, before = digest(input), raw: RawObservation;
  const capture = (value: unknown) => { input = value; before = digest(input); };
  try {
    if (!declaredCorpus.cases.some(item => item.id === contract.id && item.scenario === contract.scenario && item.group === contract.group)) throw Object.assign(new Error("Outside frozen corpus"),{code:"OUTSIDE_FROZEN_CORPUS"});
    raw = contract.group === "single_show" ? await singleCase(contract, options.engine, capture) : contract.group === "tour" ? await tourCase(contract, options.engine, capture) : contract.group === "time" ? timeCase(contract, capture) : await readinessCase(contract, options.engine, capture);
  } catch (error) { raw = { status: "execution_error", findings: [errorFinding(error)], measurements: {}, engine: null, output: { errorCode: domainCode(error) } }; }
  const unchanged = before === digest(input), mismatches = compareExpectation(contract, raw);
  if (!unchanged) mismatches.push("The evaluator mutated its retained input.");
  const engineUnavailable = raw.engine?.status === "unavailable" || typeof raw.measurements.engineUnavailable === "number" && raw.measurements.engineUnavailable > 0;
  const requiresUnrunEngine = Boolean(contract.expectation.engine && !options.engine);
  const { engine: _engineExpectation, ...domainExpectation } = contract.expectation;
  const domainMismatches = compareExpectation({...contract,expectation:domainExpectation},raw);
  const state = !unchanged || domainMismatches.length ? "fail" : engineUnavailable || requiresUnrunEngine ? "unsupported" : mismatches.length ? "fail" : "pass";
  return { input, output: raw.output, observation: { id: contract.id, state, observedStatus: raw.status, findings: raw.findings, measurements: raw.measurements, mismatches, engine: raw.engine, durationMs: Math.round((performance.now() - started) * 100) / 100, heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore, inputDigest: before, outputDigest: digest(raw.output), inputUnchanged: unchanged, artifact: `cases/${contract.id}.json` } };
}
