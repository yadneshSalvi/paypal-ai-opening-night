import type { PoolClient } from "pg";
import { DomainError } from "@/domain/contracts";
import { pool } from "../store";
import { openIntelligence, sealIntelligence } from "./private-payload";

/**
 * Cost and abuse control for the two producer-triggered model agents. These endpoints are reachable by
 * anonymous judge rehearsals, so every live call is reserved in PostgreSQL before it is dispatched.
 */
export type ModelAgent = "strategy" | "writer";
export type ModelAgentMode = "live" | "recorded";
const bounded = (name: string, fallback: number, maximum: number) => { const value = Number(process.env[name]); return Number.isInteger(value) && value >= 0 && value <= maximum ? value : fallback; };
export const modelAgentLimits = () => ({
  /** Live calls per production, per agent, for the life of that production. */
  perTenant: bounded("OPENING_NIGHT_MODEL_AGENT_TENANT_CAP", 3, 50),
  /** Live calls across every production and both agents in any 24 hours. */
  globalPerDay: bounded("OPENING_NIGHT_MODEL_AGENT_DAILY_CAP", 150, 5000),
  /** Recorded-output runs make no provider call; this only bounds repeated engine validation and stored rows. */
  recordedPerTenant: 20,
});
export class ModelAgentLimitError extends DomainError {
  constructor(readonly scope: "production" | "global" | "recorded", message: string) { super("MODEL_AGENT_LIMIT", message, 429); }
}
export interface ModelAgentRunRow {
  id: string; tenant_id: string; agent: ModelAgent; mode: ModelAgentMode; command_id: string; actor_id: string; session_hash: string; base_revision: number;
  state: "dispatching" | "completed" | "failed"; failure_code: string | null; model: string | null; response_id: string | null; input_digest: string; document_cipher: string | null; created_at: Date; completed_at: Date | null;
}
const context = (id: string) => `model-agent/v1:run:${id}`;
export async function modelAgentUsage(db: Pick<PoolClient, "query">, tenantId: string, agent: ModelAgent) {
  const limits = modelAgentLimits();
  const row = (await db.query<{ tenant_live: number; tenant_recorded: number; global_live: number }>(`SELECT
    (SELECT count(*)::int FROM on_model_agent_runs WHERE tenant_id=$1 AND agent=$2 AND mode='live') AS tenant_live,
    (SELECT count(*)::int FROM on_model_agent_runs WHERE tenant_id=$1 AND agent=$2 AND mode='recorded') AS tenant_recorded,
    (SELECT count(*)::int FROM on_model_agent_runs WHERE mode='live' AND created_at>clock_timestamp()-interval '1 day') AS global_live`, [tenantId, agent])).rows[0]!;
  return { used: row.tenant_live, limit: limits.perTenant, recordedUsed: row.tenant_recorded, recordedLimit: limits.recordedPerTenant, globalUsed: row.global_live, globalLimit: limits.globalPerDay };
}
export const modelAgentRun = async (db: Pick<PoolClient, "query">, tenantId: string, agent: ModelAgent, commandId: string) => (await db.query<ModelAgentRunRow>("SELECT * FROM on_model_agent_runs WHERE tenant_id=$1 AND agent=$2 AND command_id=$3", [tenantId, agent, commandId])).rows[0] ?? null;
/**
 * Reserve one run inside the caller's transaction. The caller commits before dispatching, so the reservation
 * survives a lost response. Live reservations are serialized across all app instances by one database lock.
 */
export async function claimModelAgentRun(db: PoolClient, run: { id: string; tenantId: string; agent: ModelAgent; mode: ModelAgentMode; commandId: string; actorId: string; sessionHash: string; baseRevision: number; inputDigest: string; document?: unknown }) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4105024))", ["opening-night:model-agents:v1"]);
  const usage = await modelAgentUsage(db, run.tenantId, run.agent), recordedHint = "Load the labeled recorded model output instead; its validation still runs live here.";
  if (run.mode === "live") {
    if (usage.used >= usage.limit) throw new ModelAgentLimitError("production", `This production has used its ${usage.limit} live ${run.agent === "strategy" ? "strategy" : "writer"} model runs. ${recordedHint}`);
    if (usage.globalUsed >= usage.globalLimit) throw new ModelAgentLimitError("global", `Live model runs are at today's shared limit for this public rehearsal site. ${recordedHint}`);
  } else if (usage.recordedUsed >= usage.recordedLimit) throw new ModelAgentLimitError("recorded", "This production has already replayed the recorded model output many times. Its retained results remain available.");
  await db.query("INSERT INTO on_model_agent_runs(id,tenant_id,agent,mode,command_id,actor_id,session_hash,base_revision,state,input_digest,document_cipher) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'dispatching',$9,$10)", [run.id, run.tenantId, run.agent, run.mode, run.commandId, run.actorId, run.sessionHash, run.baseRevision, run.inputDigest, run.document === undefined ? null : sealIntelligence(run.tenantId, context(run.id), run.document)]);
}
/** Terminal bookkeeping for a reserved run. A second completion is ignored; the first stored outcome stands. */
export async function completeModelAgentRun(db: Pick<PoolClient, "query"> | null, run: { id: string; tenantId: string }, outcome: { state: "completed" | "failed"; failureCode: string | null; model: string | null; responseId: string | null; document: unknown }) {
  await (db ?? pool).query("UPDATE on_model_agent_runs SET state=$3,failure_code=$4,model=$5,response_id=$6,document_cipher=$7,completed_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND state='dispatching'", [run.id, run.tenantId, outcome.state, outcome.failureCode, outcome.model, outcome.responseId, sealIntelligence(run.tenantId, context(run.id), outcome.document)]);
}
export function openModelAgentDocument<T>(row: Pick<ModelAgentRunRow, "id" | "tenant_id" | "document_cipher">): T | null { return row.document_cipher ? openIntelligence<T>(row.tenant_id, context(row.id), row.document_cipher) : null; }
