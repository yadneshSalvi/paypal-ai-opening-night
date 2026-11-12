import { randomUUID } from "node:crypto";
import { DomainError, type Candidate } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { InputAuthority } from "@/domain/production-inputs/contracts";
import type { ReviewContent, StrategyAgentStatus, WorkbenchEnvelope, WorkbenchResult } from "@/domain/planning-workbench/contracts";
import { STRATEGY_PROMPT_VERSION, resolveStrategyOutput, type StrategyGeneration } from "@/domain/planning-workbench/model-strategies";
import { strategyFunnels } from "@/domain/planning-workbench/funnel";
import { strategyMetrics } from "@/domain/planning-workbench/strategies";
import type { PoolClient } from "pg";
import { evaluateCandidates } from "../engine";
import { agentAvailability, dispatchStructured, modelFailureMessages, recordedStrategyOutput, strategyAgentRequest } from "../intelligence/strategy-agent";
import { claimModelAgentRun, completeModelAgentRun, modelAgentRun, modelAgentUsage } from "../intelligence/model-limits";
import { planningProvider, type PlanningProvider } from "../intelligence/provider";
import { inputAuthority, inputShow, inputTransaction } from "../production-inputs/store";
import { openReview, readReceipt, saveReceipt, saveReview, workbenchDigest } from "./store";

type ProposeEnvelope = WorkbenchEnvelope & { command: Extract<WorkbenchEnvelope["command"], { type: "strategies.propose" }> };
const RECORDED_HINT = "Load the labeled recorded model output instead; its validation still runs live here. The deterministic families remain available.";

export async function strategyAgentStatus(db: PoolClient, tenantId: string, demonstration: boolean, provider: PlanningProvider = planningProvider()): Promise<StrategyAgentStatus> {
  const recorded = recordedStrategyOutput(), recordedStatus = { available: Boolean(recorded), recordedAt: recorded?.recordedAt ?? null, model: recorded?.model ?? null, candidates: Array.isArray((recorded?.output as { candidates?: unknown[] } | undefined)?.candidates) ? (recorded!.output as { candidates: unknown[] }).candidates.length : 0 };
  // A long-running process that started before migration 24 reads as unavailable instead of failing the whole workspace.
  if (!(await db.query<{ ready: string | null }>("SELECT to_regclass('on_model_agent_runs')::text AS ready")).rows[0]?.ready) return { live: { available: false, reason: "Model agent storage is not ready in this running process.", model: null, used: 0, limit: 0 }, recorded: { ...recordedStatus, available: false }, demonstration };
  const availability = agentAvailability(provider), usage = await modelAgentUsage(db, tenantId, "strategy");
  const reason = availability.reason ?? (usage.used >= usage.limit ? `This production has used its ${usage.limit} live strategy model runs.` : usage.globalUsed >= usage.globalLimit ? "Live model runs are at today's shared limit for this public rehearsal site." : null);
  return { live: { available: !reason, reason, model: availability.model, used: usage.used, limit: usage.limit }, recorded: recordedStatus, demonstration };
}

/**
 * "Propose strategies with the model". Three steps, so no database lock is held across a provider request:
 * 1. reserve the run (authority, revision, caps) and commit;
 * 2. obtain model output (one live request, or the checked-in recorded response) and validate every proposal
 *    with the shared typed constructor, the deterministic rules and the real scheduling engine;
 * 3. retain the immutable review, including failures and every rejected proposal, with its receipt.
 * Nothing here approves a plan or writes the production.
 */
export async function proposeWithModel(authority: InputAuthority, envelope: ProposeEnvelope, provider: PlanningProvider = planningProvider()): Promise<WorkbenchResult> {
  const { mode, count } = envelope.command, tenantId = authority.actor.tenantId;
  const prepared = await inputTransaction(async db => {
    const show = await inputShow(db, tenantId, true); await inputAuthority(db, authority, envelope.scope);
    const replay = await readReceipt(db, authority, envelope.scope, envelope.commandId, digest(envelope)); if (replay) return { replay };
    if (show.revision !== envelope.expectedRevision) throw new DomainError("WORKBENCH_REVISION_CHANGED", "The production changed. Review current sources before a new instruction.");
    if (!show.incidents.length) throw new DomainError("STRATEGY_INCIDENT_REQUIRED", "Review the incident sources before comparing recovery strategies.");
    if (show.cancellationDecision) throw new DomainError("STRATEGY_CANCELLED_PROGRAMME", "A cancelled programme stays cancelled. Use its retained support-only recovery or cancellation workflow.");
    if (!show.offers.length) throw new DomainError("STRATEGY_OFFER_CHANGED", "No current supplier offer is available to build a strategy on.");
    const earlier = await modelAgentRun(db, tenantId, "strategy", envelope.commandId);
    if (earlier) throw new DomainError(earlier.state === "dispatching" ? "MODEL_AGENT_PENDING" : "MODEL_AGENT_RUN_SPENT", earlier.state === "dispatching" ? "The original model run for this instruction is still in progress, or its outcome is unknown. It is not sent again; check the original result." : "This instruction's model run already ended without a retained review. Start a new instruction.");
    const availability = agentAvailability(provider), recorded = mode === "recorded" ? recordedStrategyOutput() : null;
    if (mode === "live" && !availability.available) throw new DomainError("MODEL_AGENT_UNAVAILABLE", `${availability.reason} No request was made. ${RECORDED_HINT}`);
    if (mode === "recorded" && !recorded) throw new DomainError("RECORDED_OUTPUT_UNAVAILABLE", modelFailureMessages.RECORDED_OUTPUT_UNAVAILABLE);
    const runId = randomUUID(), built = strategyAgentRequest(show, count, runId, availability.model ?? "unconfigured", authority.actor);
    await claimModelAgentRun(db, { id: runId, tenantId, agent: "strategy", mode, commandId: envelope.commandId, actorId: authority.actor.id, sessionHash: authority.sessionHash, baseRevision: show.revision, inputDigest: built.inputDigest });
    await inputAuthority(db, authority, envelope.scope);
    return { show, runId, built, recorded };
  });
  if ("replay" in prepared) return prepared.replay!;
  const { show, runId, built, recorded } = prepared;
  let candidates: Candidate[] = [], generation: StrategyGeneration;
  try {
    const base = { version: 1 as const, runId, provenance: mode === "live" ? "model" as const : "recorded_model" as const, mode, inputDigest: built.inputDigest, promptVersion: STRATEGY_PROMPT_VERSION, requestedCount: count };
    const outcome = recorded ? { ok: true as const, output: recorded.output, model: recorded.model, responseId: recorded.responseId, outputDigest: recorded.outputDigest, at: new Date().toISOString() } : await dispatchStructured(provider, built.request);
    if (!outcome.ok) generation = { ...base, model: built.request.model, responseId: null, outputDigest: null, generatedAt: outcome.at, recordedAt: null, proposed: 0, schemaRejected: [], failure: { code: outcome.code, message: outcome.message } };
    else {
      const resolved = resolveStrategyOutput(show, outcome.output, { generator: { provenance: base.provenance, model: outcome.model, responseId: outcome.responseId, outputDigest: outcome.outputDigest, promptVersion: STRATEGY_PROMPT_VERSION, generatedAt: outcome.at, recordedAt: recorded?.recordedAt ?? null }, references: recorded?.references ?? null }, outcome.at);
      // The same real engine pass the deterministic families receive. A model proposal has no other route to "approvable".
      candidates = await evaluateCandidates(resolved.candidates);
      generation = { ...base, model: outcome.model, responseId: outcome.responseId, outputDigest: outcome.outputDigest, generatedAt: outcome.at, recordedAt: recorded?.recordedAt ?? null, proposed: resolved.proposed, schemaRejected: resolved.schemaRejected, failure: !resolved.shape ? { code: "MODEL_OUTPUT_SHAPE", message: modelFailureMessages.MODEL_OUTPUT_SHAPE } : !candidates.length ? { code: "MODEL_ZERO_VALID", message: modelFailureMessages.MODEL_ZERO_VALID } : null };
    }
  } catch (error) {
    await completeModelAgentRun(null, { id: runId, tenantId }, { state: "failed", failureCode: "VALIDATION_INTERRUPTED", model: null, responseId: null, document: { reviewId: null } });
    throw error;
  }
  const saved = await inputTransaction(async db => {
    const current = await inputShow(db, tenantId, true); await inputAuthority(db, authority, envelope.scope);
    const replay = await readReceipt(db, authority, envelope.scope, envelope.commandId, digest(envelope)); if (replay) return replay;
    if (current.revision !== show.revision || workbenchDigest(current) !== workbenchDigest(show)) return null;
    const content: ReviewContent = { kind: "strategies", request: { kinds: [...new Set(candidates.map(candidate => candidate.strategy!.kind))], offerIds: [...new Set(candidates.map(candidate => candidate.patch.offerId))], substitutions: [] }, candidates, metrics: strategyMetrics(candidates, current.doorsAt), generation };
    const review = await saveReview(db, authority, envelope, current, content), label = mode === "recorded" ? "Recorded model output" : "Model output";
    const funnel = strategyFunnels([{ candidates, generation }])[generation.provenance];
    await completeModelAgentRun(db, { id: runId, tenantId }, { state: generation.failure ? "failed" : "completed", failureCode: generation.failure?.code ?? null, model: generation.model, responseId: generation.responseId, document: { reviewId: review.id, generation } });
    const receipt = await saveReceipt(db, authority, envelope, { reviewId: review.id, digest: review.digest, revision: current.revision, admitted: false, message: generation.failure ? `${label}: ${generation.failure.message} The attempt is retained. The deterministic families remain available.` : `${label} retained: ${funnel.generated} proposed, ${funnel.schemaValid} passed the typed contract, ${funnel.temporallyValid} passed the engine, ${funnel.approvable} could go forward to a separate producer decision. Every rejection is kept with its reason; the model approved nothing.` });
    await inputAuthority(db, authority, envelope.scope); return receipt;
  });
  if (!saved) {
    await completeModelAgentRun(null, { id: runId, tenantId }, { state: "failed", failureCode: "PRODUCTION_CHANGED", model: generation.model, responseId: generation.responseId, document: { reviewId: null, generation } });
    throw new DomainError("WORKBENCH_REVISION_CHANGED", "The production changed while the proposals were being validated. Nothing was retained; review current sources before a new instruction.");
  }
  return saved;
}

export interface ProposedStrategies { receipt: WorkbenchResult["receipt"]; replayed: boolean; reviewId: string; reviewDigest: string; generation: StrategyGeneration | null; candidates: Candidate[]; funnel: ReturnType<typeof strategyFunnels> }
/**
 * Server entry point for other server code (for example the guided demonstration director).
 * Uses the caller's exact current producer access; applies the same caps, validation and retention as the HTTP action.
 */
export async function proposeStrategies(authority: InputAuthority, options: { mode: "live" | "recorded"; count?: number; commandId?: string }, provider: PlanningProvider = planningProvider()): Promise<ProposedStrategies> {
  const tenantId = authority.actor.tenantId;
  const current = await inputTransaction(async db => { const show = await inputShow(db, tenantId); return { scope: await inputAuthority(db, authority), revision: show.revision }; });
  const result = await proposeWithModel(authority, { version: 1, commandId: options.commandId ?? randomUUID(), scope: current.scope, expectedRevision: current.revision, command: { type: "strategies.propose", mode: options.mode, count: options.count ?? 6 } }, provider);
  return inputTransaction(async db => {
    await inputAuthority(db, authority, current.scope);
    const row = (await db.query("SELECT * FROM on_planning_workbench_reviews WHERE tenant_id=$1 AND id=$2", [tenantId, result.receipt.result.reviewId])).rows[0];
    const review = openReview(tenantId, row), content = review.content;
    if (content.kind !== "strategies") throw new DomainError("WORKBENCH_REVIEW_KIND", "The retained review is not a strategy comparison.");
    return { receipt: result.receipt, replayed: result.replayed, reviewId: review.id, reviewDigest: review.digest, generation: content.generation ?? null, candidates: content.candidates, funnel: strategyFunnels([{ candidates: content.candidates, generation: content.generation ?? null }]) };
  });
}
