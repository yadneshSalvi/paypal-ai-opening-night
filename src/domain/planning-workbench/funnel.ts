import type { Candidate, ConstraintStage, RescueRun, ShowSnapshot } from "../contracts";
import type { StrategyGeneration } from "./model-strategies";

/**
 * Candidate funnel counts by provenance, derived only from stored attempts. Pure: safe in the browser and on the server.
 *
 * - deterministic: the fixed families and the original enumerator.
 * - model: proposed by a live model call in this production, then validated here.
 * - recorded_model: a checked-in recorded model response, validated live in this production.
 * - assistant_proposal: a single alternative prepared through the native planning assistant's reviewed proposal tool.
 */
export type StrategyProvenanceKind = "deterministic" | "model" | "recorded_model" | "assistant_proposal";
export const strategyProvenanceLabel: Record<StrategyProvenanceKind, string> = { deterministic: "DETERMINISTIC", model: "MODEL", recorded_model: "RECORDED MODEL OUTPUT", assistant_proposal: "ASSISTANT PROPOSAL" };
export interface StrategyFunnel {
  provenance: StrategyProvenanceKind;
  /** Stored generation attempts that contributed, and how many of those ended in a stored failure. */
  runs: number; failedRuns: number;
  generated: number;
  schemaRejected: number; schemaValid: number;
  temporalRejected: number; temporallyValid: number;
  semanticRejected: number; semanticEvidenceValid: number;
  /** Not rejected, but an unknown remains or the engine proof is missing. Cannot be approved. */
  evidencePending: number;
  approvable: number;
  /** Per-rule counts: each rule is counted once per attempt it rejected (hard) or left unresolved (unknown). */
  rejections: { code: string; stage: ConstraintStage; count: number }[];
  pending: { code: string; stage: ConstraintStage; count: number }[];
}
export interface StrategyAttempts { candidates: Candidate[]; generation?: StrategyGeneration | null | undefined; assistant?: boolean | undefined }
export const candidateProvenance = (candidate: Candidate): Exclude<StrategyProvenanceKind, "assistant_proposal"> => candidate.strategy?.generator?.provenance ?? "deterministic";
export type CandidateOutcome = "schema_rejected" | "temporal_rejected" | "semantic_rejected" | "evidence_pending" | "approvable";
/** The first stage at which a stored candidate stops. Uses only its saved rule report and engine proof. */
export function candidateOutcome(candidate: Candidate): CandidateOutcome {
  const hard = new Set(candidate.report.issues.filter(issue => issue.severity === "hard").map(issue => issue.stage)), engine = candidate.report.engine?.status;
  if (hard.has("schema") || hard.has("graph")) return "schema_rejected";
  if (hard.has("temporal") || engine === "rejected") return "temporal_rejected";
  if (hard.size || candidate.report.status === "infeasible") return "semantic_rejected";
  if (engine !== "passed" || candidate.report.status === "unknown_pending_evidence" || candidate.report.issues.some(issue => issue.severity === "unknown")) return "evidence_pending";
  return "approvable";
}
const empty = (provenance: StrategyProvenanceKind): StrategyFunnel => ({ provenance, runs: 0, failedRuns: 0, generated: 0, schemaRejected: 0, schemaValid: 0, temporalRejected: 0, temporallyValid: 0, semanticRejected: 0, semanticEvidenceValid: 0, evidencePending: 0, approvable: 0, rejections: [], pending: [] });
const bump = (rows: StrategyFunnel["rejections"], code: string, stage: ConstraintStage) => { const row = rows.find(item => item.code === code && item.stage === stage); if (row) row.count++; else rows.push({ code, stage, count: 1 }); };
export function strategyFunnels(attempts: readonly StrategyAttempts[]): Record<StrategyProvenanceKind, StrategyFunnel> {
  const result: Record<StrategyProvenanceKind, StrategyFunnel> = { deterministic: empty("deterministic"), model: empty("model"), recorded_model: empty("recorded_model"), assistant_proposal: empty("assistant_proposal") };
  for (const attempt of attempts) {
    const touched = new Set<StrategyProvenanceKind>();
    if (attempt.generation) {
      const funnel = result[attempt.generation.provenance]; touched.add(funnel.provenance);
      if (attempt.generation.failure) funnel.failedRuns++;
      for (const rejection of attempt.generation.schemaRejected) { funnel.generated++; funnel.schemaRejected++; bump(funnel.rejections, rejection.code, "schema"); }
    }
    for (const candidate of attempt.candidates) {
      // A candidate's own saved provenance is authoritative; a run can never relabel it.
      const funnel = result[candidate.strategy?.generator ? candidate.strategy.generator.provenance : attempt.assistant ? "assistant_proposal" : "deterministic"], outcome = candidateOutcome(candidate); touched.add(funnel.provenance);
      funnel.generated++;
      if (outcome === "schema_rejected") funnel.schemaRejected++; else {
        funnel.schemaValid++;
        if (outcome === "temporal_rejected") funnel.temporalRejected++; else {
          funnel.temporallyValid++;
          if (outcome === "semantic_rejected") funnel.semanticRejected++; else { funnel.semanticEvidenceValid++; if (outcome === "evidence_pending") funnel.evidencePending++; else funnel.approvable++; }
        }
      }
      const seen = new Set<string>();
      for (const issue of candidate.report.issues) { const key = `${issue.severity}:${issue.stage}:${issue.code}`; if (issue.severity === "approval" || seen.has(key)) continue; seen.add(key); bump(issue.severity === "hard" ? funnel.rejections : funnel.pending, issue.code, issue.stage); }
    }
    for (const provenance of touched) result[provenance].runs++;
  }
  for (const funnel of Object.values(result)) { funnel.rejections.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)); funnel.pending.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)); }
  return result;
}
export const runAttempts = (run: RescueRun): StrategyAttempts => ({ candidates: run.candidates, generation: run.generation ?? null, assistant: run.strategySource === "model_assisted_proposal" && !run.generation });
/** Funnels from the production snapshot's stored runs. "latest" is the run Recovery studio currently compares; "all" is every retained run. */
export function showStrategyFunnels(show: Pick<ShowSnapshot, "runs">, scope: "latest" | "all" = "all") {
  return strategyFunnels((scope === "latest" ? show.runs.slice(-1) : show.runs).map(runAttempts));
}
