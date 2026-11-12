import { performance } from "node:perf_hooks";
import type { Candidate, Dependency, EngineReport, ShowSnapshot, Task } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { enumerateCandidates } from "@/domain/scheduling";
import { env } from "./env";

export async function commitEngine(candidate: Candidate): Promise<EngineReport> {
  return commitGraphEngine(candidate.patch.tasks, candidate.patch.dependencies);
}
export async function commitGraphEngine(tasks: Task[], dependencies: Dependency[], zone = "America/Chicago"): Promise<EngineReport> {
  const started = performance.now();
  const input = { tasks, dependencies };
  const base = { engine: "bryntum-gantt-enterprise" as const, version: "8.0.0" as const, computedAt: new Date().toISOString(), inputDigest: digest(input) };
  let project: InstanceType<(typeof import("@bryntum/gantt-node-enterprise"))["ProjectModel"]> | undefined;
  try {
    const root = globalThis as typeof globalThis & { bryntum?: { licenseKey?: string } };
    root.bryntum ??= {}; root.bryntum.licenseKey = env.bryntumLicense;
    const { ProjectModel } = await import("@bryntum/gantt-node-enterprise");
    project = new ProjectModel({
      timeZone: zone, startDate: tasks.reduce((first, task) => Date.parse(task.start) < Date.parse(first) ? task.start : first, tasks[0]?.start ?? "2026-11-14T16:00:00Z"), hoursPerDay: 24, daysPerWeek: 7,
      calendar: "all-hours", calendars: [{ id: "all-hours", name: "Explicit production windows", unspecifiedTimeIsWorking: true }],
      tasks: tasks.map(t => ({ id: t.id, name: t.name, startDate: t.start, duration: t.durationMinutes, durationUnit: "minute", constraintType: "startnoearlierthan", constraintDate: t.start })),
      dependencies: dependencies.map(d => ({ id: d.id, from: d.from, to: d.to, type: 2, lag: d.lagMinutes, lagUnit: "minute", lineStyle: d.financial ? "dashed" : "solid", strokeColor: d.financial ? "#9bbce2" : "#ffb000" })),
    });
    // 8.0.0 declares Promise<void>, but the engine returns a propagation result at runtime.
    const result = await project.commitAsync() as unknown as { rejectedWith?: unknown } | undefined;
    const records = project.taskStore.records as import("@bryntum/gantt-node-enterprise").TaskModel[];
    const dates = records.filter(t => t.startDate && t.endDate).map(t => ({ id: String(t.id), start: t.startDate.toISOString(), end: t.endDate.toISOString() }));
    const rejected = Boolean(result?.rejectedWith);
    const incomplete = dates.length !== tasks.length || new Set(dates.map(date => date.id)).size !== tasks.length || tasks.some(task => !dates.some(date => date.id === task.id));
    const shifted = dates.filter(d => { const task = tasks.find(t => t.id === d.id); return task && (Date.parse(task.start) !== Date.parse(d.start) || Date.parse(task.end) !== Date.parse(d.end)); });
    return { ...base, status: rejected || incomplete || shifted.length ? "rejected" : "passed", durationMs: Math.round(performance.now() - started), reason: rejected ? "The scheduling engine rejected this graph." : incomplete ? "The scheduling engine did not return one complete interval for every proposed task." : shifted.length ? `The engine moved ${shifted.length} constrained tasks; the proposed times are inconsistent.` : null, dates };
  } catch (error) {
    const safe = error instanceof Error && !/secret|token|credential/i.test(error.message) ? error.message.slice(0, 300) : "The scheduling engine could not complete.";
    return { ...base, status: "unavailable", durationMs: Math.round(performance.now() - started), reason: safe, dates: [] };
  } finally { project?.destroy(); }
}
export async function generateCandidates(show: ShowSnapshot) {
  const candidates = enumerateCandidates(show);
  return evaluateCandidates(candidates);
}
export async function evaluateCandidates(candidates: Candidate[]) {
  // Independent cloned projects; bounded to avoid a burst of CPU and no write access to the live plan.
  for (let i = 0; i < candidates.length; i += 3) await Promise.all(candidates.slice(i, i + 3).map(async candidate => {
    candidate.report.engine = await commitEngine(candidate);
    if (candidate.report.engine.status === "rejected") {
      candidate.report.issues.push({ code: "ENGINE_REJECTED", stage: "temporal", severity: "hard", message: candidate.report.engine.reason!, resourceId: null, taskId: null, sourceId: candidate.report.engine.inputDigest }); candidate.report.status = "infeasible";
    } else if (candidate.report.engine.status === "unavailable" && candidate.report.status !== "infeasible") {
      candidate.report.issues.push({ code: "ENGINE_UNAVAILABLE", stage: "evidence", severity: "unknown", message: "Engine validation is unavailable. This proposal cannot be approved.", resourceId: null, taskId: null, sourceId: candidate.report.engine.inputDigest }); candidate.report.status = "unknown_pending_evidence";
    }
  }));
  return candidates;
}
