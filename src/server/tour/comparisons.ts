import { randomUUID } from "node:crypto";
import { DomainError } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { CandidateInput, PlannedProduction, RouteComparison, Tour, TourCandidate, TourRecord, TourReport } from "@/domain/tour/contracts";
import { candidatePlan, evaluateTour, finding, portfolioFindings } from "@/domain/tour/constraints";
import { recordDigest } from "@/domain/tour/templates";
import { tourEngine } from "./engine";
import { active, expected, record, records, sourceState, currentRoster, type TourContext } from "./store";

export const evolve = <T extends TourRecord>(record: T, actorId: string, reason: string, at: string): T => ({ ...structuredClone(record), revision: record.revision + 1, actorId, reason, updatedAt: at, digest: "" });
export function reportStatus(report: TourReport) { report.status = report.hard.length ? "infeasible" : report.unknown.length ? "unknown" : report.approvals.length ? "needs_review" : "feasible"; return report; }
export async function evaluateWithEngine(tour: Tour, productions: PlannedProduction[], sourceCurrent = true, portfolio: TourRecord[] = []) {
  const report = evaluateTour(tour, productions);
  for (const issue of portfolioFindings(tour, productions, portfolio)) (issue.severity === "hard" ? report.hard : report.unknown).push(issue);
  report.engine = await tourEngine(productions.filter(production => tour.productionIds.includes(production.id)));
  if (report.engine.status === "rejected") report.hard.push(finding("ENGINE_REJECTED", "hard", report.engine.constraints.join(" "), tour.productionIds));
  if (report.engine.status === "unavailable") report.unknown.push(finding("ENGINE_UNAVAILABLE", "unknown", "The native engine did not finish. This comparison cannot be applied.", tour.productionIds));
  if (!sourceCurrent) report.unknown.push(finding("SOURCE_SUPERSEDED", "unknown", "A source revision changed or was removed. Retain this edition for inspection and admit a newly reviewed source graph.", tour.productionIds));
  return reportStatus(report);
}
export async function createComparison(context: TourContext, tourId: string, revision: number, alternatives: CandidateInput[], at: string): Promise<RouteComparison> {
  const { db, authority } = context, tenant = authority.actor.tenantId;
  const tour = await record(db, tenant, tourId, "tour"); active(tour); currentRoster(context, tour); expected(tour, revision);
  const portfolio = await records(db, tenant), productions = portfolio.filter((item): item is PlannedProduction => item.kind === "production" && tour.productionIds.includes(item.id));
  const sources = await sourceState(db, tenant, productions), candidates: TourCandidate[] = [];
  const seen = new Set<string>();
  for (const input of alternatives) {
    const next = candidatePlan(tour, productions, input), semantic = digest({ productions: next.productions, legs: next.tour.legs });
    if (seen.has(semantic)) throw new DomainError("TOUR_ALTERNATIVES_IDENTICAL", "Each compared alternative must change a different set of actual calls or travel inputs.", 400);
    seen.add(semantic);
    const report = await evaluateWithEngine(next.tour, next.productions, sources.current, portfolio);
    const calls = input.shifts.filter(shift => shift.minutes !== 0).map(shift => { const before = productions.find(production => production.id === shift.productionId)!.calls.find(call => call.id === shift.callId)!; const after = next.productions.find(production => production.id === shift.productionId)!.calls.find(call => call.id === shift.callId)!; return { productionId: shift.productionId, callId: shift.callId, label: before.label, before: before.start, after: after.start }; });
    for (const call of calls) report.approvals.push(finding("CALL_CHANGE_REVIEW", "approval", `Review ${call.label}: ${call.before.local} → ${call.after.local} in ${call.after.zone}.`, [call.productionId], [call.callId]));
    for (const override of input.legOverrides) report.approvals.push(finding("ROUTE_CHANGE_REVIEW", "approval", `Review ${override.leg.label}, its travel source, loading, unloading and forecast cost.`, [override.leg.fromProductionId, override.leg.toProductionId], [], override.leg.resourceIds, override.leg.sourceIds));
    reportStatus(report);
    const candidate: TourCandidate = { id: randomUUID(), name: input.name, explanation: input.explanation, changes: input, report, calls, digest: "" }; candidate.digest = recordDigest(candidate); candidates.push(candidate);
  }
  const result: RouteComparison = { id: randomUUID(), kind: "comparison", revision: 1, digest: "", archived: false, createdAt: at, updatedAt: at, actorId: authority.actor.id, reason: "Compared a bounded set of declared route alternatives; no global optimum is claimed", tourId, tourRevision: tour.revision, tourDigest: tour.digest, productionBindings: productions.map(production => ({ id: production.id, revision: production.revision, digest: production.digest })), sourceDigest: sources.digest, candidates, applied: null };
  result.digest = recordDigest(result); return result;
}
export async function applyComparison(context: TourContext, comparisonId: string, expectedDigest: string, candidateId: string, acceptedFindingIds: string[], commandId: string, at: string): Promise<TourRecord[]> {
  const { db, authority } = context, tenant = authority.actor.tenantId;
  const comparison = await record(db, tenant, comparisonId, "comparison"); active(comparison);
  if (comparison.digest !== expectedDigest || comparison.applied) throw new DomainError("TOUR_COMPARISON_CHANGED", "This comparison was changed or already applied. Read the retained result.");
  const tour = await record(db, tenant, comparison.tourId, "tour"); active(tour); currentRoster(context, tour);
  if (tour.revision !== comparison.tourRevision || tour.digest !== comparison.tourDigest) throw new DomainError("TOUR_COMPARISON_STALE", "Tour membership, resources or travel changed after this comparison. Compare the current edition.");
  const productions: PlannedProduction[] = [];
  for (const binding of [...comparison.productionBindings].sort((a, b) => a.id.localeCompare(b.id))) {
    const production = await record(db, tenant, binding.id, "production"); active(production);
    if (production.revision !== binding.revision || production.digest !== binding.digest) throw new DomainError("TOUR_COMPARISON_STALE", `${production.name} changed after this comparison. No part of the alternative was applied.`);
    productions.push(production);
  }
  const sources = await sourceState(db, tenant, productions);
  if (!sources.current || sources.digest !== comparison.sourceDigest) throw new DomainError("TOUR_SOURCE_STALE", "A source revision changed after this comparison. No part of the alternative was applied.");
  const candidate = comparison.candidates.find(candidate => candidate.id === candidateId);
  if (!candidate || candidate.digest !== recordDigest(candidate)) throw new DomainError("TOUR_CANDIDATE_MISSING", "This exact alternative is not in the retained comparison.", 404);
  if (candidate.report.hard.length || candidate.report.unknown.length || candidate.report.engine?.status !== "passed") throw new DomainError("TOUR_CANDIDATE_BLOCKED", "Hard failures and unknown requirements must be resolved before applying an alternative.");
  const required = candidate.report.approvals.map(issue => issue.id).sort();
  if (digest([...new Set(acceptedFindingIds)].sort()) !== digest(required)) throw new DomainError("TOUR_REVIEW_REQUIRED", "Review every named assumption and change in this exact alternative, without adding unrelated approvals.");
  const next = candidatePlan(tour, productions, candidate.changes);
  const currentReport = await evaluateWithEngine(next.tour, next.productions, true, await records(db, tenant));
  if (currentReport.hard.length || currentReport.unknown.length || currentReport.engine?.status !== "passed") throw new DomainError("TOUR_REVALIDATION_FAILED", "The complete tour no longer validates. No partial change was committed.");
  const changed: TourRecord[] = [];
  for (const production of next.productions) if (candidate.calls.some(call => call.productionId === production.id)) changed.push(evolve(production, authority.actor.id, `Applied reviewed route alternative: ${candidate.name}`, at));
  changed.push(evolve(next.tour, authority.actor.id, `Applied reviewed route alternative: ${candidate.name}`, at));
  const applied = evolve(comparison, authority.actor.id, "Applied one exact reviewed alternative", at); applied.applied = { candidateId, commandId, at, actorId: authority.actor.id, approvedFindingIds: required }; changed.push(applied);
  return changed;
}
