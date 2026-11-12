import { randomUUID } from "node:crypto";
import { digest } from "@/domain/hash";
import { boundedText } from "../bounded-body";
import { withPlanningTransaction, type PlanningRun } from "./ledger";
import { openIntelligence, sealIntelligence } from "./private-payload";
import type { PlanningProvider } from "./provider";
import type { PlanningResponse } from "./continuation";

type Observation = {
  method: "POST" | "GET"; status: number | null; requestId: string | null;
  outcome: "response" | "body_unreadable" | "transport_unknown"; body: unknown;
};
type Target = Pick<PlanningRun, "id" | "tenant_id" | "provider_response_id">;
type Kind = "planning" | "compilation";
async function retain(run: Target, kind: Kind, value: Observation) {
  return withPlanningTransaction(async db => {
    const table = kind === "planning" ? "on_intelligence_observations" : "on_source_compilation_observations", column = kind === "planning" ? "run_id" : "compilation_id";
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${kind}-observation:${run.id}`]);
    const sequence = (await db.query<{ sequence: number }>(`SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM ${table} WHERE ${column}=$1`, [run.id])).rows[0]!.sequence;
    const id = randomUUID();
    await db.query(`INSERT INTO ${table}(id,tenant_id,${column},sequence,method,client_request_id,provider_request_id,status,outcome,payload_cipher,payload_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, run.tenant_id, run.id, sequence, value.method, run.id, value.requestId, value.status, value.outcome, sealIntelligence(run.tenant_id, `${kind}-observation:${id}`, value), digest(value)]);
  });
}

/** One request only. Unknown writes never receive a create retry here. */
async function observedRequest(run: Target, kind: Kind, method: "POST" | "GET", provider: PlanningProvider, body?: unknown) {
  if (method === "GET" && !/^resp_[A-Za-z0-9_-]{1,240}$/.test(run.provider_response_id ?? "")) throw new Error("Original provider response identity is required");
  const url = method === "POST" ? "https://api.openai.com/v1/responses" : `https://api.openai.com/v1/responses/${run.provider_response_id}`;
  let response: Response;
  try {
    response = await provider.fetch(url, { method, headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`, "Content-Type": "application/json", "X-Client-Request-Id": run.id }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(30000) });
  } catch {
    await retain(run, kind, { method, status: null, requestId: null, outcome: "transport_unknown", body: null });
    return { status: null, ok: false, body: null, requestId: null, outcome: "transport_unknown" as const };
  }
  const id = response.headers.get("x-request-id"), requestId = id && /^[A-Za-z0-9_-]{1,250}$/.test(id) ? id : null;
  let text: string;
  try { text = await boundedText(response, kind === "planning" ? 2_000_000 : 5_000_000); }
  catch {
    await retain(run, kind, { method, status: response.status, requestId, outcome: "body_unreadable", body: null });
    return { status: response.status, ok: response.ok, body: null, requestId, outcome: "body_unreadable" as const };
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = { unreadableJson: text }; }
  await retain(run, kind, { method, status: response.status, requestId, outcome: "response", body: value });
  const parsed = value && typeof value === "object" && !Array.isArray(value) && !Object.hasOwn(value, "unreadableJson") ? value as PlanningResponse : null;
  return { status: response.status, ok: response.ok, body: parsed, requestId, outcome: "response" as const };
}
export const observedPlanningRequest = (run: Target, method: "POST" | "GET", provider: PlanningProvider, body?: unknown) => observedRequest(run, "planning", method, provider, body);
export const observedSourceRequest = (run: Target, method: "POST" | "GET", provider: PlanningProvider, body?: unknown) => observedRequest(run, "compilation", method, provider, body);

/** Recover the already-saved original HTTP result after a process stops before binding its ID. */
export async function retainedModelDispatch(run: Target, kind: Kind): Promise<Observation | null> {
  return withPlanningTransaction(async db => {
    const table = kind === "planning" ? "on_intelligence_observations" : "on_source_compilation_observations", column = kind === "planning" ? "run_id" : "compilation_id";
    const rows = (await db.query<{ id: string; payload_cipher: string | null; payload_digest: string }>(`SELECT id,payload_cipher,payload_digest FROM ${table} WHERE tenant_id=$1 AND ${column}=$2 AND method='POST' ORDER BY sequence`, [run.tenant_id, run.id])).rows;
    if (!rows.length) return null;
    if (rows.length !== 1 || !rows[0]!.payload_cipher) throw new Error("Original model dispatch evidence is unavailable or ambiguous");
    const row = rows[0]!, value = openIntelligence<Observation>(run.tenant_id, `${kind}-observation:${row.id}`, row.payload_cipher!);
    if (digest(value) !== row.payload_digest || value.method !== "POST") throw new Error("Original model dispatch evidence failed its integrity check");
    return value;
  });
}

/** A locally retained terminal read can finish the same run even after the provider's polling window ends. */
export async function retainedModelTerminal(run: Target, kind: Kind): Promise<Observation | null> {
  return withPlanningTransaction(async db => {
    const table = kind === "planning" ? "on_intelligence_observations" : "on_source_compilation_observations", column = kind === "planning" ? "run_id" : "compilation_id";
    const row = (await db.query<{ id: string; payload_cipher: string | null; payload_digest: string }>(`SELECT id,payload_cipher,payload_digest FROM ${table} WHERE tenant_id=$1 AND ${column}=$2 ORDER BY sequence DESC LIMIT 1`, [run.tenant_id, run.id])).rows[0];
    if (!row?.payload_cipher) return null;
    const value = openIntelligence<Observation>(run.tenant_id, `${kind}-observation:${row.id}`, row.payload_cipher);
    if (digest(value) !== row.payload_digest) throw new Error("Original model observation failed its integrity check");
    if (value.method === "GET" && [404, 410].includes(value.status ?? 0)) return value;
    const body = value.body as PlanningResponse | null;
    return value.status !== null && value.status >= 200 && value.status < 300 && body && typeof body === "object" && ["completed", "failed", "incomplete", "cancelled"].includes(body.status ?? "") ? value : null;
  });
}
