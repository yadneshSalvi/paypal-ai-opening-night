import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "dotenv";

const qa = parse(readFileSync(new URL("../../.env", import.meta.url)));
if (qa.OPENING_NIGHT_AI_QA !== "1" || process.env.VERCEL) throw new Error("This bootstrap is only for an isolated local planning rehearsal");
for (const key of Object.keys(process.env)) if (/OPENAI|GEMINI|PAYPAL|CHANNEL3|ANTHROPIC/.test(key)) process.env[key] = "";
Object.assign(process.env, qa);
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (/(openai|googleapis|paypal|channel3|anthropic)\./i.test(url.hostname)) throw new Error("External provider requests are disabled in this controlled rehearsal");
  return nativeFetch(input, init);
};
const steps = ["Read the current production", "Check crew qualifications", "Compare validated alternatives", "Prepare an alternative for review"];
globalThis.openingNightPlanningQa = {
  configured: true, mode: "controlled_fixture",
  fetch: async (url, init) => {
    if (String(url) !== "https://api.openai.com/v1/responses" || init?.method !== "POST") throw new Error("Unexpected controlled planning request");
    const body = JSON.parse(String(init.body)), input = body.input, last = input.at(-1);
    const toolOutput = last.type === "function_call_output" ? JSON.parse(last.output) : null;
    const priorOutputs = input.filter(item => item.type === "function_call_output").map(item => JSON.parse(item.output));
    let name, args, text;
    if (last.role === "user") {
      if (/priya/i.test(last.content) && priorOutputs.some(item => item.name === "askUser")) { name = "checkAssignment"; args = { taskId: "lx-program", resourceIds: ["priya"] }; }
      else { name = "createPlan"; args = { goal: "Find a qualified way to protect doors", steps }; }
    } else if (toolOutput?.name === "createPlan") { name = "readProduction"; args = {}; }
    else if (toolOutput?.name === "readProduction") { name = "completePlanSteps"; args = { stepIds: [1] }; }
    else if (toolOutput?.name === "checkAssignment") {
      if (toolOutput.data.allowedByQualification) { name = "compareRecoveryPlans"; args = {}; }
      else { name = "completePlanSteps"; args = { stepIds: [2] }; }
    } else if (toolOutput?.name === "completePlanSteps") {
      const completed = toolOutput.data.plan.steps.filter(step => step.completed).map(step => step.id);
      if (completed.includes(4)) text = "The qualified alternative is saved. Priya owns LX programming, and the independent engine check passed. Review the exact alternative below; plan approval, payments and crew sign-offs remain separate.";
      else if (completed.includes(3)) {
        const comparison = priorOutputs.findLast(item => item.name === "compareRecoveryPlans");
        const candidate = comparison.data.candidates.find(item => item.current && item.id.startsWith("doors-brightline"));
        if (!candidate) text = "The saved candidate is no longer current. Recompute the recovery alternatives before proposing.";
        else { name = "proposeRecovery"; args = { candidateId: candidate.id, candidateDigest: candidate.digest, assignments: [{ taskId: "lx-program", resourceIds: ["priya"] }] }; }
      } else if (completed.includes(2)) { name = "askUser"; args = { question: "Tom lacks LX programming qualification. Use Priya, the qualified programmer?", options: ["Use Priya and protect doors", "Keep the current assignments"] }; }
      else { name = "checkAssignment"; args = { taskId: "lx-program", resourceIds: ["tom"] }; }
    } else if (toolOutput?.name === "compareRecoveryPlans") { name = "completePlanSteps"; args = { stepIds: [3] }; }
    else if (toolOutput?.name === "proposeRecovery") { name = "completePlanSteps"; args = { stepIds: [4] }; }
    else text = "This controlled response cannot continue that step. Review the saved decision record.";
    if (toolOutput?.ok === false) { name = undefined; text = toolOutput.message; }
    const output = name ? [{ type: "function_call", call_id: "call_qa_" + randomUUID(), name, arguments: JSON.stringify(args) }] : [{ type: "message", content: [{ type: "output_text", text }] }];
    return Response.json({ id: "resp_qa_" + randomUUID().replaceAll("-", ""), status: "completed", output, controlledFixture: true });
  },
};
