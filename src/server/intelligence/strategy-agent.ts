import { digest } from "@/domain/hash";
import type { ShowSnapshot } from "@/domain/contracts";
import { STRATEGY_PROMPT_VERSION, STRATEGY_SCHEMA_NAME, strategyAgentInput, strategyInstructions, strategyOutputJsonSchema, type StrategyFailureCode, type StrategyReferences } from "@/domain/planning-workbench/model-strategies";
import { boundedText } from "../bounded-body";
import { planningProvider, type PlanningProvider } from "./provider";
import recordedStrategy from "./recorded/strategy-candidates.v1.json";

/**
 * One bounded, tool-free structured request through the existing server-side OpenAI adapter and its egress guards.
 * The model name comes from configuration. Nothing here can approve, schedule, pay or send anything: the caller
 * receives parsed JSON or a typed failure, and treats both as untrusted data.
 */
export type ModelCallFailure = Exclude<StrategyFailureCode, "MODEL_ZERO_VALID" | "RECORDED_OUTPUT_UNAVAILABLE" | "MODEL_OUTPUT_SHAPE">;
export type ModelCallOutcome =
  | { ok: true; output: unknown; model: string; responseId: string | null; outputDigest: string; at: string }
  | { ok: false; code: ModelCallFailure; message: string; at: string };
export const modelFailureMessages: Record<StrategyFailureCode, string> = {
  MODEL_NOT_CONFIGURED: "The model is not connected in this environment. No request was made.",
  MODEL_TIMEOUT: "The model did not answer within the time limit. Nothing was generated.",
  MODEL_TRANSPORT: "The model request could not be completed. Its outcome is unknown and nothing was generated.",
  MODEL_RATE_LIMITED: "The model provider is rate limiting this deployment. Nothing was generated.",
  MODEL_HTTP_ERROR: "The model provider refused this request. Nothing was generated.",
  MODEL_REFUSAL: "The model declined to answer. Nothing was generated.",
  MODEL_INCOMPLETE: "The model stopped before finishing its answer. The partial answer was discarded.",
  MODEL_INVALID_JSON: "The model's answer was not valid JSON. It was discarded.",
  MODEL_OUTPUT_SHAPE: "The model's answer did not match the typed contract. It was discarded.",
  MODEL_ZERO_VALID: "The model answered, but none of its proposals passed the typed contract. Each rejection is retained below.",
  RECORDED_OUTPUT_UNAVAILABLE: "No recorded model output is available in this build.",
};
/** Configured model name; never hardcoded. A controlled test provider carries its own label. */
export function agentModel(provider: PlanningProvider, role: "planner" | "writer" = "planner"): string | null {
  if (provider.mode === "controlled_fixture") return "controlled-fixture-model";
  const name = role === "planner" ? process.env.OPENAI_PLANNER_MODEL || process.env.OPENAI_MODEL : process.env.OPENAI_MODEL || process.env.OPENAI_PLANNER_MODEL;
  return name && /^[A-Za-z0-9._:-]{1,80}$/.test(name) ? name : null;
}
export const agentAvailability = (provider: PlanningProvider = planningProvider(), role: "planner" | "writer" = "planner") => { const model = agentModel(provider, role); return { available: provider.configured && Boolean(model), model, reason: !provider.configured ? "The model is not connected in this environment." : model ? null : "No model name is configured for this agent." }; };
interface ResponseBody { id?: unknown; status?: unknown; model?: unknown; output?: { type?: string; content?: { type?: string; text?: string }[] }[] }
export interface StructuredRequest { runId: string; model: string; instructions: string; input: unknown; schemaName: string; schema: unknown; safetyIdentifier: string; agent: "strategy" | "writer"; maxOutputTokens?: number; timeoutMs?: number }
export function structuredRequestBody(request: StructuredRequest) {
  const effort = process.env.OPENING_NIGHT_AGENT_REASONING_EFFORT;
  return { model: request.model, reasoning: { effort: effort && /^[a-z]{2,12}$/.test(effort) ? effort : "low" }, instructions: request.instructions, input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(request.input) }] }], text: { format: { type: "json_schema", name: request.schemaName, strict: true, schema: request.schema } }, tools: [], tool_choice: "none", store: false, max_output_tokens: request.maxOutputTokens ?? 6000, safety_identifier: request.safetyIdentifier, metadata: { opening_agent: request.agent, opening_agent_run: request.runId } };
}
export async function dispatchStructured(provider: PlanningProvider, request: StructuredRequest): Promise<ModelCallOutcome> {
  const fail = (code: ModelCallFailure): ModelCallOutcome => ({ ok: false, code, message: modelFailureMessages[code], at: new Date().toISOString() });
  if (!provider.configured) return fail("MODEL_NOT_CONFIGURED");
  let response: Response;
  try {
    response = await provider.fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`, "Content-Type": "application/json", "X-Client-Request-Id": request.runId }, body: JSON.stringify(structuredRequestBody(request)), redirect: "error", signal: AbortSignal.timeout(request.timeoutMs ?? 50000) });
  } catch (error) { return fail(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "MODEL_TIMEOUT" : "MODEL_TRANSPORT"); }
  if (response.status === 429) return fail("MODEL_RATE_LIMITED");
  if (!response.ok) return fail("MODEL_HTTP_ERROR");
  let body: ResponseBody;
  try { const value: unknown = JSON.parse(await boundedText(response, 400_000)); if (!value || typeof value !== "object" || Array.isArray(value)) return fail("MODEL_INVALID_JSON"); body = value as ResponseBody; }
  catch { return fail("MODEL_INVALID_JSON"); }
  const parts = Array.isArray(body.output) ? body.output.filter(item => item?.type === "message").flatMap(item => Array.isArray(item.content) ? item.content : []) : [];
  if (parts.some(part => part?.type === "refusal")) return fail("MODEL_REFUSAL");
  if (body.status !== "completed") return fail("MODEL_INCOMPLETE");
  const text = parts.filter(part => part?.type === "output_text").map(part => part.text ?? "").join("");
  let output: unknown;
  try { output = JSON.parse(text); } catch { return fail("MODEL_INVALID_JSON"); }
  const model = typeof body.model === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(body.model) ? body.model : request.model, responseId = typeof body.id === "string" && /^resp_[A-Za-z0-9_-]{1,240}$/.test(body.id) ? body.id : null;
  return { ok: true, output, model, responseId, outputDigest: digest(output), at: new Date().toISOString() };
}
export function strategyAgentRequest(show: ShowSnapshot, count: number, runId: string, model: string, actor: { tenantId: string; id: string }) {
  const prepared = strategyAgentInput(show, count);
  const request: StructuredRequest = { runId, agent: "strategy", model, instructions: strategyInstructions, input: prepared.document, schemaName: STRATEGY_SCHEMA_NAME, schema: strategyOutputJsonSchema, safetyIdentifier: digest({ tenant: actor.tenantId, actor: actor.id }), maxOutputTokens: 6000 };
  return { ...prepared, request };
}
/** One real model response for the fixture incident, checked in. Only its structured output and metadata are stored. */
export interface RecordedStrategyOutput { version: 1; kind: "strategy"; label: string; recordedAt: string; model: string; responseId: string | null; promptVersion: string; inputDigest: string; outputDigest: string; fixture: string; references: StrategyReferences; output: unknown }
export function recordedStrategyOutput(): RecordedStrategyOutput | null {
  try {
    const value = structuredClone(recordedStrategy) as unknown as RecordedStrategyOutput;
    if (value.version !== 1 || value.kind !== "strategy" || value.promptVersion !== STRATEGY_PROMPT_VERSION || !Number.isFinite(Date.parse(value.recordedAt)) || typeof value.model !== "string" || digest(value.output) !== value.outputDigest || !Array.isArray(value.references?.offers) || !Array.isArray(value.references?.people)) return null;
    return value;
  } catch { return null; }
}
