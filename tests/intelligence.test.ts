import test from "node:test";
import assert from "node:assert/strict";
import { intelligenceDependencyDelta, intelligenceReviewDelta, intelligenceToolNames, intelligenceTools, productionForIntelligence, startIntelligenceSchema } from "../src/domain/intelligence";
import { qualificationIssues, validatePatch, buildCandidate } from "../src/domain/scheduling";
import { disrupted } from "./helpers";

test("native planning surface has only the seven explicit read/proposal/checklist tools", () => {
  assert.deepEqual(intelligenceToolNames, ["readProduction", "checkAssignment", "compareRecoveryPlans", "proposeRecovery", "askUser", "createPlan", "completePlanSteps"]);
  for (const forbidden of ["pay", "refund", "assignResource", "addTask", "updateTask", "go", "acknowledge", "approve"]) assert.equal(Object.hasOwn(intelligenceTools, forbidden), false);
});
test("browser cannot supply model history, tools, tenant, model or provider identity", () => {
  const valid = { requestId: "d0d8ae20-235b-437d-9707-07b1f2858b67", conversationId: "e23d442e-401d-4316-8670-381430e16b9d", afterRunId: null, prompt: "Assign Tom to programming" };
  assert.ok(startIntelligenceSchema.safeParse(valid).success);
  for (const field of ["messages", "tools", "tenantId", "model", "providerResponseId"]) assert.equal(startIntelligenceSchema.safeParse({ ...valid, [field]: "forged" }).success, false);
});
test("Tom rejection is the same exact qualification result used by whole-plan validation", () => {
  const { show } = disrupted(), candidate = buildCandidate(show, show.offers[0]!, "doors");
  const task = candidate.patch.tasks.find(item => item.id === "lx-program")!; task.resources = ["tom"];
  const check = qualificationIssues(show, task), full = validatePatch(show, candidate.patch, show.offers[0]!).issues.filter(item => item.code === "QUALIFICATION");
  assert.deepEqual(full, check); assert.equal(check.length, 1); assert.equal(check[0]!.sourceId, "crew-policy-v1"); assert.match(check[0]!.message, /Tom Chen lacks lx programming/);
  task.resources = ["priya"]; assert.deepEqual(qualificationIssues(show, task), []);
});
test("proposal contract cannot carry arbitrary graphs, money, approvals or crew signoffs", () => {
  const args = { candidateId: "saved-candidate", candidateDigest: "a".repeat(64), assignments: [] };
  assert.ok(intelligenceTools.proposeRecovery.safeParse(args).success);
  for (const key of ["tasks", "cost", "approved", "supplier", "payee", "facts", "state"]) assert.equal(intelligenceTools.proposeRecovery.safeParse({ ...args, [key]: "injected" }).success, false);
  assert.equal(intelligenceTools.checkAssignment.safeParse({ taskId: "lx-program", resourceIds: ["tom", "tom"] }).success, false);
});
test("model context deliberately excludes payer and capability records", () => {
  const { show } = disrupted(); show.financialEvidence.push({ providerResourceId: "private-payment-identity" } as never);
  show.acknowledgments.push({ id: "personal-ack-identity" } as never);
  const context = JSON.stringify(productionForIntelligence(show));
  assert.ok(context.includes("crew-policy-v1")); assert.ok(context.includes("lx_programming"));
  assert.ok(!context.includes("private-payment-identity")); assert.ok(!context.includes("personal-ack-identity"));
  assert.ok(!context.includes(show.tenantId));
});
test("native plan accepts known evidence steps and distinct bounded choices only", () => {
  assert.equal(intelligenceTools.createPlan.safeParse({ goal: "Win", steps: ["Capture the payment"] }).success, false);
  assert.equal(intelligenceTools.completePlanSteps.safeParse({ stepIds: [1, 1] }).success, false);
  assert.equal(intelligenceTools.askUser.safeParse({ question: "Approve funds?", options: ["Yes"] }).success, false);
});
test("exact proposal review includes canceled calls and changed qualifications as well as added milestones", () => {
  const { show } = disrupted(), candidate = buildCandidate(show, show.offers[0]!, "doors");
  const rows = intelligenceReviewDelta(show, candidate);
  assert.deepEqual(rows.filter(row => row.kind === "removed").map(row => row.before!.id).sort(), ["headliner-check", "vip"]);
  assert.ok(rows.some(row => row.kind === "added" && row.after?.id === "rental-captured"));
  assert.ok(rows.some(row => row.kind === "changed" && row.after?.id === "lx-program"));
  const edges = intelligenceDependencyDelta(show, candidate);
  assert.ok(edges.removed.some(edge => edge.to === "vip"));
  assert.ok(edges.added.some(edge => edge.from === "rental-captured" && edge.to === "lx-focus" && edge.financial));
  candidate.patch.tasks.find(task => task.id === "load-in")!.requiredSkill = "rigging";
  assert.ok(intelligenceReviewDelta(show, candidate).some(row => row.kind === "changed" && row.after?.id === "load-in"));
});
