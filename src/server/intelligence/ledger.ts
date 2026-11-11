import type { PoolClient } from "pg";
import { DomainError, type Actor, type Candidate, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { planningDigest } from "@/domain/scheduling";
import type { IntelligenceCompletion, IntelligenceConversation, IntelligenceProposal, IntelligenceRunState, IntelligenceRunView, IntelligenceToolResult } from "@/domain/intelligence";
import { migrate, pool } from "../store";
import { openIntelligence } from "./private-payload";

export interface IntelligenceAuthority { actor: Actor; sessionHash: string }
export interface PlanningRun {
  id: string; tenant_id: string; conversation_id: string; actor_id: string; request_id: string; request_hash: string;
  sequence: number; revision: number; source_digest: string; request_cipher: string; prompt_cipher: string | null;
  result_cipher: string | null; state: IntelligenceRunState; provider_response_id: string | null; provider_source: "live_model" | "controlled_fixture";
  created_at: Date; poll_after: Date | null;
}
export interface ToolReceipt { id: string; tenant_id: string; run_id: string; call_id: string; name: IntelligenceToolResult["name"]; args_hash: string; state: string; result_cipher: string | null; created_at: Date }
export interface ProposalRow { id: string; tenant_id: string; actor_id: string; run_id: string; call_id: string; base_revision: number; source_digest: string; payload_digest: string; candidate_cipher: string; state: "proposed" | "reviewed"; reviewed_at: Date | null; created_at: Date }
export function planningFail(code: string, message: string, status = 409): never { throw new DomainError(code, message, status); }
export function intelligenceSourceDigest(show: ShowSnapshot) { return digest({ graph: planningDigest(show), sources: show.sources }); }
export async function withPlanningTransaction<T>(fn: (db: PoolClient) => Promise<T>) {
  await migrate(); const db = await pool.connect();
  try { await db.query("BEGIN"); const result = await fn(db); await db.query("COMMIT"); return result; }
  catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
export async function requirePlanningAuthority(db: PoolClient, authority: IntelligenceAuthority) {
  const actor = authority.actor;
  if (actor.personId || actor.executionId || actor.supplierId || !actor.roles.some(role => ["producer", "stage_manager"].includes(role))) planningFail("PLANNING_ROLE_REQUIRED", "The production operator opens this planning desk.", 403);
  const valid = await db.query("SELECT token_hash FROM on_sessions WHERE token_hash=$1 AND tenant_id=$2 AND actor=$3::jsonb AND expires_at>clock_timestamp() FOR SHARE", [authority.sessionHash, actor.tenantId, JSON.stringify(actor)]);
  if (!valid.rowCount) planningFail("PLANNING_SESSION_ENDED", "This planning session has ended. Open your current production session.", 401);
}
export async function planningShow(db: PoolClient, actor: Actor, lock = false) {
  const row = (await db.query<{ snapshot: ShowSnapshot }>(`SELECT snapshot FROM on_shows WHERE tenant_id=$1${lock ? " FOR SHARE" : ""}`, [actor.tenantId])).rows[0];
  if (!row) planningFail("SHOW_NOT_FOUND", "This production no longer exists.", 404);
  return row.snapshot;
}
export function runCompletion(run: PlanningRun): IntelligenceCompletion | null { return run.result_cipher ? openIntelligence(run.tenant_id, `run:${run.id}:result`, run.result_cipher) : null; }
export function receiptResult(row: ToolReceipt): IntelligenceToolResult | null { return row.result_cipher ? openIntelligence(row.tenant_id, `tool:${row.id}`, row.result_cipher) : null; }
export function proposalView(row: ProposalRow): IntelligenceProposal {
  const candidate = openIntelligence<Candidate>(row.tenant_id, `proposal:${row.id}`, row.candidate_cipher);
  if (digest(candidate) !== row.payload_digest) planningFail("PROPOSAL_INTEGRITY", "The saved proposal cannot be verified.", 503);
  return { id: row.id, baseRevision: row.base_revision, sourceDigest: row.source_digest, digest: row.payload_digest, candidate, state: row.state, reviewedAt: row.reviewed_at?.toISOString() ?? null, createdAt: row.created_at.toISOString() };
}
const states: Record<IntelligenceRunState, string> = {
  dispatching: "The original request is saved; its provider identity is being recorded.",
  running: "The original planning response is still working. Reconnecting will read that same response.",
  completed: "The saved response is ready. Any change still needs separate review.",
  failed: "The original request ended without a usable response. The attempt is retained.",
  indeterminate: "The original request has no confirmed response identity. It is held for review; no replacement was sent.",
  unavailable: "The original response could not be recovered. Its saved attempt remains in the record.",
};
export function runView(run: PlanningRun): IntelligenceRunView {
  return { id: run.id, requestId: run.request_id, conversationId: run.conversation_id, sequence: run.sequence, state: run.state, revision: run.revision, sourceDigest: run.source_digest, createdAt: run.created_at.toISOString(), result: runCompletion(run), model: "gpt-6.1-sol", reasoning: "max", provenance: run.provider_source, message: states[run.state], retryAfterMs: 2500 };
}
export async function ownedRun(db: PoolClient, actor: Actor, id: string) {
  const run = (await db.query<PlanningRun>("SELECT * FROM on_intelligence_runs WHERE tenant_id=$1 AND actor_id=$2 AND id=$3", [actor.tenantId, actor.id, id])).rows[0];
  if (!run) planningFail("PLANNING_NOT_FOUND", "This planning request is not in your current workspace.", 404);
  return run;
}

/** Rebuild every assistant message and tool output from the immutable ledger. */
export async function canonicalConversation(db: PoolClient, actor: Actor, conversationId: string) {
  const owner = (await db.query("SELECT id FROM on_intelligence_conversations WHERE id=$1 AND tenant_id=$2 AND actor_id=$3", [conversationId, actor.tenantId, actor.id])).rowCount;
  if (!owner) planningFail("PLANNING_NOT_FOUND", "This conversation is not in your current workspace.", 404);
  const runs = (await db.query<PlanningRun>("SELECT * FROM on_intelligence_runs WHERE conversation_id=$1 AND tenant_id=$2 AND actor_id=$3 ORDER BY sequence", [conversationId, actor.tenantId, actor.id])).rows;
  const receipts = (await db.query<ToolReceipt>("SELECT t.* FROM on_intelligence_tool_receipts t JOIN on_intelligence_runs r ON r.id=t.run_id AND r.tenant_id=t.tenant_id WHERE r.conversation_id=$1 AND r.tenant_id=$2 AND r.actor_id=$3 ORDER BY r.sequence,t.created_at,t.id", [conversationId, actor.tenantId, actor.id])).rows;
  const inputs: Record<string, unknown>[] = [], prompts: IntelligenceConversation["prompts"] = [];
  let unresolvedCalls = false;
  for (const run of runs) {
    if (run.prompt_cipher) { const text = openIntelligence<string>(actor.tenantId, `run:${run.id}:prompt`, run.prompt_cipher); prompts.push({ runId: run.id, text }); inputs.push({ role: "user", content: text }); }
    const message = runCompletion(run)?.choices[0].message;
    if (!message) continue;
    if (message.content) inputs.push({ role: "assistant", content: message.content });
    for (const call of message.tool_calls ?? []) {
      inputs.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      const receipt = receipts.find(row => row.run_id === run.id && row.call_id === call.id), result = receipt && receiptResult(receipt);
      if (!result) unresolvedCalls = true;
      else inputs.push({ type: "function_call_output", call_id: call.id, output: JSON.stringify(result) });
    }
  }
  return { runs, receipts, prompts, inputs, unresolvedCalls };
}
export async function readIntelligenceConversation(authority: IntelligenceAuthority, conversationId: string): Promise<IntelligenceConversation> {
  return withPlanningTransaction(async db => {
    await requirePlanningAuthority(db, authority);
    const saved = await canonicalConversation(db, authority.actor, conversationId);
    let plan: IntelligenceConversation["plan"] = null;
    for (const row of saved.receipts) {
      const result = receiptResult(row); if (!result?.ok) continue;
      if (row.name === "createPlan" || row.name === "completePlanSteps") plan = (result.data as { plan: NonNullable<IntelligenceConversation["plan"]> }).plan;
    }
    return { id: conversationId, runs: saved.runs.map(runView), prompts: saved.prompts, receipts: saved.receipts.flatMap(row => { const result = receiptResult(row); return result ? [{ runId: row.run_id, callId: row.call_id, result }] : []; }), plan, pending: saved.unresolvedCalls || saved.runs.some(run => ["dispatching", "running", "indeterminate"].includes(run.state)) };
  });
}
