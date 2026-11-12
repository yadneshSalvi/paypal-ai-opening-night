import { canonical, digest } from "@/domain/hash";
import type { IntelligenceCompletion, IntelligenceToolResult } from "@/domain/intelligence";

export const planningRequestContract = "opening-night-planning-stateless-v1";
export type ResponseItem = Record<string, unknown>;
export interface PlanningResponse extends Record<string, unknown> {
  id?: string; status?: string; model?: string; store?: boolean; metadata?: Record<string, string>;
  output?: ResponseItem[];
}
export interface PlanningRequest extends Record<string, unknown> {
  input: ResponseItem[];
  metadata: Record<string, string>;
}
export interface RetainedPlanningStep {
  id: string; sequence: number; state: string; responseId: string | null;
  request: PlanningRequest; response: PlanningResponse | null;
  result: IntelligenceCompletion | null;
  receipts: { callId: string; name: string; argsHash: string; result: IntelligenceToolResult | null }[];
}

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
const configuration = ({ input: _input, metadata: _metadata, ...rest }: PlanningRequest) => rest;

/** Replay opaque provider items, in order, from the encrypted original journal. */
export function planningContinuation(steps: RetainedPlanningStep[]): { input: ResponseItem[]; configuration: Record<string, unknown> } | null {
  if (!steps.length) return null;
  let input: ResponseItem[] = [], settings: Record<string, unknown> | null = null;
  const callIds = new Set<string>();
  for (const [index, step] of steps.entries()) {
    check(step.sequence === index + 1 && step.state === "completed", "PLANNING_CONTINUATION_INCOMPLETE");
    const request = step.request;
    check(request?.metadata?.planning_contract === planningRequestContract && request.store === false && Array.isArray(request.include) && request.include.includes("reasoning.encrypted_content") && !Object.hasOwn(request, "previous_response_id") && !Object.hasOwn(request, "conversation"), "PLANNING_LEGACY_READ_ONLY");
    check(request.stream === true && request.background === false, "PLANNING_LEGACY_READ_ONLY");
    check(Array.isArray(request.input) && request.input.length > 0, "PLANNING_CONTINUATION_INPUT_MISSING");
    const currentSettings = configuration(request);
    if (!settings) settings = currentSettings;
    else {
      check(canonical(currentSettings) === canonical(settings), "PLANNING_CONTINUATION_CONFIGURATION_CHANGED");
      check(request.input.length >= input.length && canonical(request.input.slice(0, input.length)) === canonical(input), "PLANNING_CONTINUATION_PREFIX_CHANGED");
      // Later source data and operator text are appended; they never replace
      // the original inputs, opaque reasoning, calls or receipt bytes.
      check(request.input.slice(input.length).every(item => ["developer", "user"].includes(String(item.role)) && typeof item.content === "string" && !item.type), "PLANNING_CONTINUATION_APPEND_INVALID");
    }
    const response = step.response, message = step.result?.choices[0]?.message;
    check(response && response.id === step.responseId && response.status === "completed" && Array.isArray(response.output) && response.output.length > 0 && message, "PLANNING_CONTINUATION_OUTPUT_MISSING");
    check(response.store === false && typeof response.model === "string" && (response.model === request.model || response.model.startsWith(`${request.model}-`)) && ["planning_contract", "opening_planning_run", "source_digest"].every(key => response.metadata?.[key] === request.metadata[key]), "PLANNING_CONTINUATION_RECEIPT_MISMATCH");
    check(response.output.every(item => item && typeof item === "object" && !Array.isArray(item) && ["reasoning", "message", "function_call"].includes(String(item.type))), "PLANNING_CONTINUATION_OUTPUT_UNSUPPORTED");
    check(response.output.every(item => item.type !== "reasoning" || typeof item.encrypted_content === "string" && item.encrypted_content.length > 0), "PLANNING_CONTINUATION_REASONING_MISSING");
    const rawCalls = response.output.filter(item => item.type === "function_call"), calls = message.tool_calls ?? [];
    check(rawCalls.length === calls.length && calls.length <= 1, "PLANNING_CONTINUATION_CALL_MISMATCH");
    input = [...request.input, ...response.output];
    for (const [callIndex, call] of calls.entries()) {
      const original = rawCalls[callIndex]!;
      check(original.call_id === call.id && original.name === call.function.name && typeof original.arguments === "string", "PLANNING_CONTINUATION_CALL_MISMATCH");
      let args: unknown;
      try { args = JSON.parse(original.arguments); } catch { throw new Error("PLANNING_CONTINUATION_CALL_MISMATCH"); }
      check(digest(args) === digest(JSON.parse(call.function.arguments)), "PLANNING_CONTINUATION_CALL_MISMATCH");
      check(!callIds.has(call.id), "PLANNING_CONTINUATION_DUPLICATE_CALL"); callIds.add(call.id);
      const receipts = step.receipts.filter(receipt => receipt.callId === call.id);
      check(receipts.length === 1 && receipts[0]!.name === call.function.name && receipts[0]!.argsHash === digest(args) && receipts[0]!.result?.name === call.function.name, "PLANNING_CONTINUATION_TOOL_MISMATCH");
      input.push({ type: "function_call_output", call_id: call.id, output: JSON.stringify(receipts[0]!.result) });
    }
    check(step.receipts.length === calls.length, "PLANNING_CONTINUATION_TOOL_MISMATCH");
  }
  return { input: structuredClone(input), configuration: structuredClone(settings!) };
}
