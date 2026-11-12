import { digest } from "@/domain/hash";
import type { Task, Dependency } from "@/domain/contracts";
import type { EngineProof, PlannedProduction } from "@/domain/tour/contracts";
import { resourcesForCall } from "@/domain/tour/templates";
import { commitGraphEngine } from "../engine";
export async function tourEngine(productions: PlannedProduction[]): Promise<EngineProof> {
  const tasks: Task[] = productions.flatMap(production => production.calls.map(call => ({ id: `${production.id}:${call.id}`, name: call.label, lane: call.lane, start: call.start.instant, end: call.end.instant, durationMinutes: call.durationMinutes, baselineStart: call.start.instant, baselineEnd: call.end.instant, resources: resourcesForCall(production, call), requiredSkill: call.requiredSkills[0] ?? null, state: "planned", critical: true, affected: false, milestone: null, sourceId: call.sourceIds[0] ?? "unknown" })));
  const dependencies: Dependency[] = productions.flatMap(production => production.dependencies.map(edge => ({ id: `${production.id}:${edge.id}`, from: `${production.id}:${edge.from}`, to: `${production.id}:${edge.to}`, lagMinutes: edge.lagMinutes, financial: false })));
  const result = await commitGraphEngine(tasks, dependencies, "UTC");
  return { vendor: "Bryntum Gantt Enterprise", version: "8.0.0", status: result.status, tasks: tasks.length, dependencies: dependencies.length, elapsedMs: result.durationMs, inputDigest: result.inputDigest, resultDigest: result.status === "unavailable" ? null : digest(result.dates), constraints: result.reason ? [result.reason] : [] };
}
