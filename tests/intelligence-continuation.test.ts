import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/domain/hash";
import { planningContinuation, planningRequestContract, type PlanningRequest, type RetainedPlanningStep } from "../src/server/intelligence/continuation";
import type { IntelligenceToolResult } from "../src/domain/intelligence";

const request = (id: string, input: PlanningRequest["input"]): PlanningRequest => ({
  model: "gpt-6.1-sol", reasoning: { effort: "max" }, background: true, store: false,
  include: ["reasoning.encrypted_content"], truncation: "disabled", instructions: "Original fixed instructions.",
  tools: [], input, metadata: { planning_contract: planningRequestContract, opening_planning_run: id, source_digest: "d".repeat(64) },
});
function step(id: string, sequence = 1, input: PlanningRequest["input"] = [{ role: "developer", content: "Original production v1." }, { role: "user", content: "Read the production." }]): RetainedPlanningStep {
  const args = {}, callId = `call_${id}`, original = request(id, input);
  const result: IntelligenceToolResult = { name: "readProduction", evidenceId: `evidence_${id}`, ok: true, data: { revision: 1, unknowns: ["No physical observation"] }, message: "Exact retained result." };
  return { id, sequence, state: "completed", responseId: `resp_${id}`, request: original,
    response: { id: `resp_${id}`, status: "completed", model: original.model as string, store: false, metadata: original.metadata, output: [
      { type: "reasoning", id: `rs_${id}`, encrypted_content: `opaque-controlled-${id}`, summary: [] },
      { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Checking the saved production.", annotations: [] }] },
      { type: "function_call", id: `fc_${id}`, call_id: callId, name: "readProduction", arguments: "{  }", status: "completed" },
    ] },
    result: { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "Checking the saved production.", tool_calls: [{ id: callId, type: "function", function: { name: "readProduction", arguments: JSON.stringify(args) } }] } }] },
    receipts: [{ callId, name: "readProduction", argsHash: digest(args), result }],
  };
}
test("stateless continuation preserves every opaque output item, original prefix, order and exact receipt", () => {
  const first = step("one"), before = digest(first), result = planningContinuation([first])!;
  assert.deepEqual(result.input.slice(0, 2), first.request.input);
  assert.deepEqual(result.input.slice(2, 5), first.response!.output);
  assert.deepEqual(result.input[5], { type: "function_call_output", call_id: "call_one", output: JSON.stringify(first.receipts[0]!.result) });
  assert.equal(digest(first), before); result.input[0]!.content = "Local copy changed"; assert.equal(digest(first), before);
  assert.equal(result.configuration.store, false); assert.equal(Object.hasOwn(result.configuration, "metadata"), false);
});
test("later current production is appended after original reasoning and tools without replacing earlier facts", () => {
  const first = step("one"), initial = planningContinuation([first])!;
  const second = step("two", 2, [...initial.input, { role: "developer", content: "Current production v2; earlier v1 retained." }, { role: "user", content: "Check again." }]);
  const third = step("three", 3, planningContinuation([first, second])!.input);
  const result = planningContinuation([first, second, third])!;
  assert.deepEqual(result.input.slice(0, initial.input.length), initial.input);
  assert.equal(result.input.filter(item => item.type === "reasoning").length, 3);
  assert.deepEqual(result.input.filter(item => item.type === "function_call_output").map(item => item.call_id), ["call_one", "call_two", "call_three"]);
});
test("a missing receipt or incomplete original request cannot be replaced with another response", () => {
  const incomplete = step("one"); incomplete.state = "indeterminate";
  assert.throws(() => planningContinuation([incomplete]), /CONTINUATION_INCOMPLETE/);
  const missing = step("one"); missing.receipts = [];
  assert.throws(() => planningContinuation([missing]), /CONTINUATION_TOOL_MISMATCH/);
  const wrong = step("one"); wrong.receipts[0]!.argsHash = digest({ forged: true });
  assert.throws(() => planningContinuation([wrong]), /CONTINUATION_TOOL_MISMATCH/);
});
test("legacy settings, omitted encrypted reasoning and mismatched provider metadata fail closed", () => {
  const legacy = step("one"); legacy.request.store = true;
  assert.throws(() => planningContinuation([legacy]), /LEGACY_READ_ONLY/);
  const missing = step("one"); delete missing.response!.output![0]!.encrypted_content;
  assert.throws(() => planningContinuation([missing]), /REASONING_MISSING/);
  const mismatch = step("one"); mismatch.response!.metadata = { ...mismatch.request.metadata, opening_planning_run: "different" };
  assert.throws(() => planningContinuation([mismatch]), /RECEIPT_MISMATCH/);
});
test("reordered or rewritten prefix and changed model configuration cannot continue", () => {
  const first = step("one"), input = planningContinuation([first])!.input;
  const changed = step("two", 2, structuredClone(input)); changed.request.input[0]!.content = "Replaced production";
  assert.throws(() => planningContinuation([first, changed]), /PREFIX_CHANGED/);
  const order = step("two", 2, [input[1]!, input[0]!, ...input.slice(2)]);
  assert.throws(() => planningContinuation([first, order]), /PREFIX_CHANGED/);
  const model = step("two", 2, input); model.request.model = "different";
  assert.throws(() => planningContinuation([first, model]), /CONFIGURATION_CHANGED/);
});
test("invented call receipts, repeated call IDs and unsupported raw output cannot be replayed", () => {
  const first = step("one"), input = planningContinuation([first])!.input, duplicate = step("one", 2, input);
  assert.throws(() => planningContinuation([first, duplicate]), /DUPLICATE_CALL/);
  const extra = step("one"); extra.receipts.push({ ...extra.receipts[0]!, callId: "foreign_call" });
  assert.throws(() => planningContinuation([extra]), /TOOL_MISMATCH/);
  const unsupported = step("one"); unsupported.response!.output!.push({ type: "web_search_call", id: "not_authorized" });
  assert.throws(() => planningContinuation([unsupported]), /OUTPUT_UNSUPPORTED/);
});
