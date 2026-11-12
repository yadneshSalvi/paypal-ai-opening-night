import { performance } from "node:perf_hooks";
import type { Task, Dependency } from "../contracts";
import { digest } from "../hash";
import { candidateFunnel } from "../scheduling";
import { financialSummary } from "../finance";
import { readiness } from "../readiness";
import { evaluateTour } from "../tour/constraints";
import { FIXTURE_NOW, reservedTickets, scalingTour, singleFixture } from "./fixtures";
import type { BenchmarkObservation, BenchmarkSample, EngineObservation } from "./contracts";

export const BENCHMARK_TITLES: Record<string, string> = { B01: "Twelve-candidate rescue planner", B02: "Native tasks and resource assignments", B03: "Cross-zone tour portfolio", B04: "Reserved-only ticket computation" };
export function percentile(samples: number[], fraction: number): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a,b) => a-b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}
export function nativeFixture(size: number) {
  if (![120, 500].includes(size)) throw new Error("Only frozen native benchmark sizes are supported");
  const base = Date.parse("2026-11-20T08:00:00Z");
  const resources = Array.from({ length: 100 }, (_, index) => ({ id: `resource-${index}`, name: `Computational resource ${index + 1}` }));
  const tasks: Task[] = Array.from({ length: size }, (_, index) => {
    const start = new Date(base + (Math.floor(index / 100) * 60 + index % 4 * 5) * 60000).toISOString();
    return { id: `task-${index}`, name: `Computational task ${index + 1}`, lane: "stage", start, end: new Date(Date.parse(start) + 20 * 60000).toISOString(), durationMinutes: 20, baselineStart: start, baselineEnd: new Date(Date.parse(start) + 20 * 60000).toISOString(), resources: [`resource-${index % 100}`], requiredSkill: null, state: "planned", critical: true, affected: false, milestone: null, sourceId: "controlled-computational-scaling" };
  });
  const dependencies: Dependency[] = tasks.slice(100).map((task,index) => ({ id: `edge-${index}`, from: tasks[index]!.id, to: task.id, lagMinutes: 5, financial: false }));
  const assignments = tasks.map((task, index) => ({ id: `assignment-${index}`, eventId: task.id, resourceId: task.resources[0]!, units: 100 }));
  return { tasks, dependencies, resources, assignments };
}
export async function commitNativeResources(input: ReturnType<typeof nativeFixture>): Promise<{ engine: EngineObservation; result: unknown }> {
  const start = performance.now();
  const root = globalThis as typeof globalThis & { bryntum?: { licenseKey?: string } };
  root.bryntum ??= {}; root.bryntum.licenseKey = process.env.BRYNTUM_LICENSE_KEY ?? "";
  const { ProjectModel } = await import("@bryntum/gantt-node-enterprise");
  const project = new ProjectModel({ timeZone: "UTC", startDate: input.tasks[0]!.start, autoLoad: false, autoSync: false, hoursPerDay: 24, daysPerWeek: 7, calendar: "all-hours", calendars: [{ id: "all-hours", name: "Controlled all-hours computational calendar", unspecifiedTimeIsWorking: true }], tasks: input.tasks.map(task => ({ id: task.id, name: task.name, startDate: task.start, duration: task.durationMinutes, durationUnit: "minute", constraintType: "startnoearlierthan", constraintDate: task.start })), dependencies: input.dependencies.map(edge => ({ id: edge.id, from: edge.from, to: edge.to, type: 2, lag: edge.lagMinutes, lagUnit: "minute" })), resources: structuredClone(input.resources), assignments: structuredClone(input.assignments) });
  try {
    const propagation = await project.commitAsync() as unknown as { rejectedWith?: unknown } | undefined;
    const dates = (project.taskStore.records as import("@bryntum/gantt-node-enterprise").TaskModel[]).map(task => ({ id: String(task.id), start: task.startDate?.toISOString() ?? null, end: task.endDate?.toISOString() ?? null })).sort((a,b) => a.id.localeCompare(b.id));
    const resources = project.resourceStore.records.map(resource => String(resource.id)).sort();
    const assignments = (project.assignmentStore.records as import("@bryntum/gantt-node-enterprise").AssignmentModel[]).map(assignment => ({ id: String(assignment.id), eventId: String(assignment.eventId), resourceId: String(assignment.resourceId), units: assignment.units })).sort((a,b) => a.id.localeCompare(b.id));
    const exact = dates.length === input.tasks.length && input.tasks.every(task => dates.some(date => date.id === task.id && Date.parse(date.start ?? "") === Date.parse(task.start) && Date.parse(date.end ?? "") === Date.parse(task.end))) && resources.length === 100 && assignments.length === input.tasks.length && input.assignments.every(expected => assignments.some(actual => actual.id === expected.id && actual.eventId === expected.eventId && actual.resourceId === expected.resourceId && actual.units === expected.units));
    const result = { dates, resources, assignments };
    return { result, engine: { status: propagation?.rejectedWith || !exact ? "rejected" : "passed", scope: "native_resources", version: "8.0.0", durationMs: Math.round((performance.now() - start) * 100) / 100, inputDigest: digest(input), resultDigest: digest(result), taskCount: dates.length, resourceCount: resources.length, assignmentCount: assignments.length, reason: exact && !propagation?.rejectedWith ? null : "Native propagation or retained task/resource/assignment identities did not match the frozen computational input." } };
  } finally { project.destroy(); }
}
interface SampleOutput { input: unknown; result: unknown; sample: BenchmarkSample; successful: boolean }
async function sample(id: string, size: number, repetition: number): Promise<SampleOutput> {
  const started = performance.now(), heapBeforeBytes = process.memoryUsage().heapUsed;
  let input: unknown, result: unknown, successful = false, status = "unknown", engine: EngineObservation | null = null, measurements: BenchmarkSample["measurements"] = {}, before = "";
  if (id === "B01") {
    const { show } = singleFixture(); input = show; before = digest(input);
    const generated = await (await import("../../server/engine")).generateCandidates(show), funnel = candidateFunnel(generated);
    const operationalDigests = generated.map(candidate => digest({ patch: candidate.patch, cost: candidate.cost, approvals: candidate.approvals.map(approval => ({ id: approval.id, role: approval.role })) }));
    // Ignore wall-clock report fields while checking repeated semantic results.
    result = generated.map((candidate,index) => ({ id: candidate.id, status: candidate.report.status, issues: candidate.report.issues.map(issue => issue.code).sort(), engineStatus: candidate.report.engine?.status ?? "not_run", operationalDigest: operationalDigests[index] }));
    const unavailable = generated.filter(candidate => candidate.report.engine?.status === "unavailable").length;
    status = unavailable ? "unavailable" : "completed";
    measurements = { generated: generated.length, approvable: funnel.approvable, rejected: funnel.rejected, pending: funnel.pending, operationallyDistinct: new Set(operationalDigests).size, familyLabels: new Set(generated.map(candidate => candidate.family)).size, engineUnavailable: unavailable, approvalsGranted: generated.reduce((sum,candidate) => sum + candidate.approvals.filter(approval => approval.grantedBy !== null).length, 0), usefulBatchReadyUpperBoundMs: funnel.approvable ? Math.round((performance.now() - started) * 100) / 100 : null };
    successful = generated.length === 12 && unavailable === 0 && funnel.approvable > 0 && measurements.approvalsGranted === 0;
  } else if (id === "B02") {
    const native = nativeFixture(size); input = native; before = digest(input);
    const commit = await commitNativeResources(native); engine = commit.engine; result = commit.result; status = engine.status;
    measurements = { tasks: engine.taskCount, resources: engine.resourceCount, assignments: engine.assignmentCount, dependencies: native.dependencies.length, automaticLevelingProven: false };
    successful = engine.status === "passed" && engine.taskCount === size && engine.resourceCount === 100 && engine.assignmentCount === size;
  } else if (id === "B03") {
    const tourInput = scalingTour(size); input = tourInput; before = digest(input);
    const report = evaluateTour(tourInput.tour, tourInput.productions), proof = await (await import("../../server/tour/engine")).tourEngine(tourInput.productions);
    engine = { status: proof.status, scope: "product_temporal", version: "8.0.0", durationMs: proof.elapsedMs, inputDigest: proof.inputDigest, resultDigest: proof.resultDigest, taskCount: proof.tasks, resourceCount: 0, assignmentCount: 0, reason: null };
    result = { report, temporalResultDigest: proof.resultDigest, temporalStatus: proof.status };
    status = proof.status === "unavailable" ? "unavailable" : report.status;
    measurements = { productions: size, calls: size * 30, modeledResources: tourInput.tour.resources.length, travelLegs: tourInput.tour.legs.length, hardFindings: report.hard.length, unknownFindings: report.unknown.length, restComparisons: report.rests.length, forecastTotalMinor: report.forecast.totalMinor, forecastIsActualSpend: false };
    successful = report.status === "feasible" && report.hard.length === 0 && report.unknown.length === 0 && proof.status === "passed";
  } else if (id === "B04") {
    const { show } = singleFixture(); show.tickets = reservedTickets(size); input = show; before = digest(input);
    const finance = financialSummary(show), report = readiness(show, "DOORS", FIXTURE_NOW); result = { finance, readiness: report };
    status = "blocked"; measurements = { ticketRows: show.tickets.length, capturedTickets: finance.capturedTickets, capturedMinor: finance.grossCapturedMinor, refundedMinor: finance.settledTicketRefundMinor, providerEvidence: show.financialEvidence.length, ready: report.ready };
    successful = show.tickets.length === 400 && show.tickets.every(ticket => ticket.status === "reserved" && ticket.captureId === null) && finance.capturedTickets === 0 && finance.grossCapturedMinor === 0 && finance.settledTicketRefundMinor === 0 && !report.ready;
  } else throw new Error("Unknown frozen benchmark");
  const memory = process.memoryUsage(), inputUnchanged = before === digest(input);
  return { input, result, successful: successful && inputUnchanged, sample: { repetition, durationMs: Math.round((performance.now() - started) * 100) / 100, heapBeforeBytes, heapAfterBytes: memory.heapUsed, rssAfterBytes: memory.rss, inputUnchanged, inputDigest: before, resultDigest: digest(result), status, measurements, engine } };
}
export async function executeBenchmark(id: string, size: number) {
  const allowed: Record<string, number[]> = { B01: [12], B02: [120,500], B03: [3,10,30], B04: [400] };
  if (!allowed[id]?.includes(size)) throw new Error("Benchmark is outside the frozen contract");
  const outputs: SampleOutput[] = [];
  for (let repetition = 1; repetition <= 3; repetition++) outputs.push(await sample(id,size,repetition));
  const samples = outputs.map(output => output.sample), stable = new Set(samples.map(result => result.resultDigest)).size === 1, unavailable = samples.some(result => result.status === "unavailable");
  const observation: BenchmarkObservation = { id, title: BENCHMARK_TITLES[id]!, size, state: unavailable ? "unsupported" : outputs.every(output => output.successful) && stable ? "pass" : "fail", samples, medianMs: percentile(samples.map(result => result.durationMs), 0.5), p95Ms: percentile(samples.map(result => result.durationMs), 0.95), peakObservedHeapBytes: Math.max(...samples.flatMap(result => [result.heapBeforeBytes,result.heapAfterBytes])), reason: unavailable ? "The actual engine was unavailable;this size is not qualified." : !stable ? "Repeated semantic output digests changed;all samples are retained." : outputs.some(output => !output.successful) ? "A frozen invariant failed;inspect each retained sample." : "All three measured repetitions met the frozen invariants. First repetition includes cold module loading;later repetitions reuse this worker's module cache. Heap values are pre/post observations,not transient peak allocation.", artifact: `benchmarks/${id}-${size}.json` };
  return { observation, input: outputs[0]!.input, outputs: outputs.map(output => ({ result: output.result, sample: output.sample })) };
}
