import test from "node:test";
import assert from "node:assert/strict";
import { assistantContinuation } from "../src/server/wrap/assistant-continuation";

const reasoning = { type: "reasoning", id: "rs_controlled", summary: [], encrypted_content: "controlled-opaque-value" };
const call = { type: "function_call", id: "fc_controlled", call_id: "call_original", name: "readAccount", arguments: "{}" };
const completion = { step: 1, output: [reasoning, call], call: { id: "call_original" } };
const tool = { step: 1, callId: "call_original", output: { ok: true, amountMinor: 100 } };

test("stateless continuation retains original input, opaque reasoning and exact paired tool results", () => {
  const input = assistantContinuation({ amountMinor: 100 }, "Explain L1", [completion], [tool]);
  assert.deepEqual(input.slice(2, 4), [reasoning, call]);
  assert.deepEqual(input.at(-1), { type: "function_call_output", call_id: "call_original", output: '{"amountMinor":100,"ok":true}' });
  assert.equal(input[0]!.role, "developer"); assert.equal(input[1]!.content, "Explain L1");
  assert.equal(JSON.stringify(input).includes("previous_response_id"), false);
});
test("multiple model turns replay all completed model and tool items in original order", () => {
  const second = { step: 2, output: [{ ...reasoning, id: "rs_second" }, { ...call, call_id: "call_second" }], call: { id: "call_second" } };
  const input = assistantContinuation({}, "Read", [completion, second], [tool, { ...tool, step: 2, callId: "call_second" }]);
  assert.deepEqual(input.slice(2).map(item => item.type), ["reasoning", "function_call", "function_call_output", "reasoning", "function_call", "function_call_output"]);
});
test("missing original output, unencrypted reasoning, mismatched or duplicate tools and skipped steps cannot restart a conversation", () => {
  for (const bad of [
    { step: 1, call: completion.call },
    { ...completion, output: [{ type: "reasoning", summary: [] }, call] },
    { ...completion, output: [{ type: "computer_call" }, call] },
    { ...completion, step: 2 },
  ]) assert.throws(() => assistantContinuation({}, "Read", [bad], [tool]), /MODEL_CONTINUATION/);
  for (const tools of [[], [{ ...tool, callId: "foreign" }], [tool, tool]]) assert.throws(() => assistantContinuation({}, "Read", [completion], tools), /MODEL_CONTINUATION_TOOL_MISMATCH/);
});
