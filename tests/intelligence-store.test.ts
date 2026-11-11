import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Actor, ShowSnapshot } from "../src/domain/contracts";
import { digest } from "../src/domain/hash";
import { withRun } from "./helpers";
import { isolatedDatabase } from "./isolated-database";
import type { IntelligenceTool } from "../src/domain/intelligence";
import type { IntelligenceAuthority } from "../src/server/intelligence/ledger";
import type { PlanningProvider } from "../src/server/intelligence/provider";

let fixture: Awaited<ReturnType<typeof isolatedDatabase>>;
let ledger: typeof import("../src/server/intelligence/ledger");
let providers: typeof import("../src/server/intelligence/provider");
let tools: typeof import("../src/server/intelligence/tools");
let privatePayload: typeof import("../src/server/intelligence/private-payload");
let sessionTokenHash: typeof import("../src/server/session-records").sessionTokenHash;
before(async () => {
  fixture = await isolatedDatabase(); process.env.OPENAI_API_KEY = ""; process.env.OPENING_NIGHT_AI_QA = "1";
  const store = await import("../src/server/store"); await store.migrate();
  ledger = await import("../src/server/intelligence/ledger"); providers = await import("../src/server/intelligence/provider"); tools = await import("../src/server/intelligence/tools");
  privatePayload = await import("../src/server/intelligence/private-payload"); ({ sessionTokenHash } = await import("../src/server/session-records"));
});
after(async () => { await fixture?.close(); });
async function workspace() {
  const { show, actor } = withRun(), token = randomBytes(32).toString("base64url"), sessionHash = sessionTokenHash(token);
  await fixture.pool.query("INSERT INTO on_shows(tenant_id,snapshot,revision) VALUES($1,$2,$3)", [show.tenantId, show, show.revision]);
  await fixture.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [sessionHash, show.tenantId, actor]);
  return { authority: { actor, sessionHash } satisfies IntelligenceAuthority, show };
}
function wire(name?: IntelligenceTool, args: unknown = {}, options: { pending?: boolean; error?: boolean; status?: number } = {}) {
  const requests: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const callId = "call_" + randomUUID(), responseId = "resp_" + randomUUID().replaceAll("-", "");
  const output = name ? [{ type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) }] : [{ type: "message", content: [{ type: "output_text", text: "The saved production still needs its assigned reviewer." }] }];
  const provider: PlanningProvider = { mode: "controlled_fixture", configured: true, fetch: async (input, init) => {
    requests.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (options.error) throw new TypeError("Controlled transport disconnect");
    if (options.status) return new Response("", { status: options.status });
    const pending = options.pending && init?.method === "POST";
    return Response.json({ id: responseId, status: pending ? "queued" : "completed", output: pending ? [] : output });
  } };
  return { provider, requests, callId, responseId };
}
const command = () => ({ requestId: randomUUID(), conversationId: randomUUID(), afterRunId: null, prompt: "Check Tom's programming qualification using current production evidence." });
const code = (expected: string) => (error: unknown) => { assert.equal((error as { code?: string }).code, expected); return true; };
async function next(authority: IntelligenceAuthority, last: Awaited<ReturnType<typeof providers.startIntelligence>>, name: IntelligenceTool, args: unknown) {
  const provider = wire(name, args), run = await providers.startIntelligence(authority, { requestId: randomUUID(), conversationId: last.conversationId, afterRunId: last.id, prompt: null }, provider.provider);
  const result = await tools.executeIntelligenceTool(authority, { runId: run.id, callId: provider.callId, name, args });
  return { run, result, provider };
}

test("concurrent duplicate start makes exactly one original provider POST", async () => {
  const { authority } = await workspace(), request = command(), fake = wire();
  const runs = await Promise.all([providers.startIntelligence(authority, request, fake.provider), providers.startIntelligence(authority, request, fake.provider)]);
  assert.equal(runs[0]!.id, runs[1]!.id); assert.equal(fake.requests.filter(item => item.method === "POST").length, 1);
  assert.equal((await providers.startIntelligence(authority, request, fake.provider)).state, "completed"); assert.equal(fake.requests.length, 1);
  await assert.rejects(providers.startIntelligence(authority, { ...request, prompt: "Different" }, fake.provider), code("PLANNING_REQUEST_CHANGED"));
});
test("requests, provider outputs and prompts are encrypted with tenant/record binding", async () => {
  const { authority } = await workspace(), request = command(), fake = wire();
  const run = await providers.startIntelligence(authority, request, fake.provider);
  const row = (await fixture.pool.query("SELECT * FROM on_intelligence_runs WHERE id=$1", [run.id])).rows[0];
  assert.ok(!JSON.stringify(row).includes(request.prompt)); assert.ok(!JSON.stringify(row).includes("assigned reviewer"));
  assert.throws(() => privatePayload.openIntelligence("wrong-tenant", `run:${run.id}:prompt`, row.prompt_cipher));
  assert.throws(() => privatePayload.openIntelligence(authority.actor.tenantId, `run:wrong:prompt`, row.prompt_cipher));
  await assert.rejects(fixture.pool.query("UPDATE on_intelligence_runs SET request_hash='forged' WHERE id=$1", [run.id]), /Immutable planning request/);
  await assert.rejects(fixture.pool.query("UPDATE on_intelligence_runs SET result_cipher='forged' WHERE id=$1", [run.id]), /Terminal planning request/);
});
test("known pending response is recovered through GET without another create", async () => {
  const { authority } = await workspace(), fake = wire(undefined, {}, { pending: true });
  const run = await providers.startIntelligence(authority, command(), fake.provider); assert.equal(run.state, "running");
  await fixture.pool.query("UPDATE on_intelligence_runs SET poll_after=now()-interval '1 second' WHERE id=$1", [run.id]);
  assert.equal((await providers.readIntelligenceRun(authority, run.id, fake.provider)).state, "completed");
  assert.deepEqual(fake.requests.map(item => item.method), ["POST", "GET"]); assert.ok(fake.requests[1]!.url.endsWith(fake.responseId));
});
test("unknown dispatch is held across replay and new conversations", async () => {
  const { authority } = await workspace(), fake = wire(undefined, {}, { error: true }), request = command();
  const run = await providers.startIntelligence(authority, request, fake.provider); assert.equal(run.state, "indeterminate");
  assert.equal((await providers.startIntelligence(authority, request, fake.provider)).state, "indeterminate");
  await assert.rejects(providers.startIntelligence(authority, command(), fake.provider), code("PLANNING_PENDING"));
  assert.equal(fake.requests.length, 1);
});
test("provider rejection is retained and never silently regenerated", async () => {
  const { authority } = await workspace(), fake = wire(undefined, {}, { status: 429 }), request = command();
  assert.equal((await providers.startIntelligence(authority, request, fake.provider)).state, "failed");
  await providers.startIntelligence(authority, request, fake.provider); assert.equal(fake.requests.length, 1);
});
test("foreign tenant, ended exact session, wrong actor and scoped crew cannot read or dispatch", async () => {
  const a = await workspace(), b = await workspace(), fake = wire();
  const run = await providers.startIntelligence(a.authority, command(), fake.provider);
  await assert.rejects(providers.readIntelligenceRun(b.authority, run.id, fake.provider), code("PLANNING_NOT_FOUND"));
  await assert.rejects(providers.startIntelligence({ ...a.authority, actor: { ...a.authority.actor, id: "forged" } }, command(), fake.provider), code("PLANNING_SESSION_ENDED"));
  await assert.rejects(providers.startIntelligence({ ...a.authority, actor: { ...a.authority.actor, personId: "tom" } }, command(), fake.provider), code("PLANNING_ROLE_REQUIRED"));
  await fixture.pool.query("UPDATE on_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [a.authority.sessionHash]);
  await assert.rejects(providers.readIntelligenceRun(a.authority, run.id, fake.provider), code("PLANNING_SESSION_ENDED")); assert.equal(fake.requests.length, 1);
});
test("only exact saved call arguments execute; repeated Tom rejection is one immutable receipt", async () => {
  const { authority, show } = await workspace(), args = { taskId: "lx-program", resourceIds: ["tom"] }, fake = wire("checkAssignment", args);
  const run = await providers.startIntelligence(authority, command(), fake.provider);
  await assert.rejects(tools.executeIntelligenceTool(authority, { runId: run.id, callId: fake.callId, name: "checkAssignment", args: { ...args, resourceIds: ["priya"] } }), code("PLANNING_TOOL_BINDING"));
  const tool = { runId: run.id, callId: fake.callId, name: "checkAssignment" as const, args };
  const [a, b] = await Promise.all([tools.executeIntelligenceTool(authority, tool), tools.executeIntelligenceTool(authority, tool)]);
  assert.deepEqual(a, b); assert.equal(a.ok, true);
  const data = a.data as { allowedByQualification: boolean; issues: { code: string; resourceId: string }[]; qualifiedAlternatives: { id: string }[] };
  assert.equal(data.allowedByQualification, false); assert.ok(data.issues.some(item => item.code === "QUALIFICATION" && item.resourceId === "tom")); assert.ok(data.qualifiedAlternatives.some(item => item.id === "priya"));
  const saved = (await fixture.pool.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1", [show.tenantId])).rows[0]!.snapshot;
  assert.equal(digest(saved), digest(show));
  await assert.rejects(fixture.pool.query("UPDATE on_intelligence_tool_receipts SET result_cipher='changed' WHERE id=$1", [a.evidenceId]), /Immutable planning tool receipt/);
});
test("canonical continuation requires exact preceding run and all saved tool outcomes", async () => {
  const { authority } = await workspace(), args = { taskId: "lx-program", resourceIds: ["tom"] }, first = wire("checkAssignment", args);
  const run = await providers.startIntelligence(authority, command(), first.provider), continuation = { requestId: randomUUID(), conversationId: run.conversationId, afterRunId: run.id, prompt: null };
  const second = wire();
  await assert.rejects(providers.startIntelligence(authority, continuation, second.provider), code("PLANNING_TOOL_PENDING")); assert.equal(second.requests.length, 0);
  const receipt = await tools.executeIntelligenceTool(authority, { runId: run.id, callId: first.callId, name: "checkAssignment", args });
  await providers.startIntelligence(authority, continuation, second.provider);
  const input = second.requests[0]!.body!.input as { type?: string; call_id?: string; output?: string }[];
  assert.equal(input.find(item => item.type === "function_call_output")?.output, JSON.stringify(receipt));
  await assert.rejects(providers.startIntelligence(authority, { ...continuation, requestId: randomUUID() }, second.provider), code("PLANNING_HISTORY_CHANGED"));
});
test("source change makes a saved tool fail visibly without mutating current production", async () => {
  const { authority, show } = await workspace(), fake = wire("readProduction");
  const run = await providers.startIntelligence(authority, command(), fake.provider);
  show.sources[0]!.detail = "Updated source"; show.revision++;
  await fixture.pool.query("UPDATE on_shows SET snapshot=$2,revision=$3 WHERE tenant_id=$1", [show.tenantId, show, show.revision]);
  const result = await tools.executeIntelligenceTool(authority, { runId: run.id, callId: fake.callId, name: "readProduction", args: {} });
  assert.equal(result.ok, false); assert.equal((result.data as { code: string }).code, "PLANNING_SOURCE_CHANGED");
});
test("native checklist refuses fictional completion and restores exact saved progress", async () => {
  const { authority } = await workspace(), args = { goal: "Find a qualified programmer", steps: ["Read the current production", "Check crew qualifications"] }, fake = wire("createPlan", args);
  let run = await providers.startIntelligence(authority, command(), fake.provider);
  await tools.executeIntelligenceTool(authority, { runId: run.id, callId: fake.callId, name: "createPlan", args });
  const premature = await next(authority, run, "completePlanSteps", { stepIds: [1] }); assert.equal(premature.result.ok, false); run = premature.run;
  const read = await next(authority, run, "readProduction", {}); run = read.run;
  const progress = await next(authority, run, "completePlanSteps", { stepIds: [1] }); assert.equal(progress.result.ok, true);
  const history = await ledger.readIntelligenceConversation(authority, run.conversationId);
  assert.equal(history.plan?.steps[0]!.completed, true); assert.equal(history.plan?.steps[1]!.completed, false); assert.equal(history.prompts.length, 1);
});
test("proposal uses real Bryntum engine; explicit exact review only adds a candidate", async () => {
  const { authority, show } = await workspace(), original = show.runs.at(-1)!.candidates.find(candidate => candidate.id.startsWith("doors-brightline"))!;
  const args = { candidateId: original.id, candidateDigest: original.digest, assignments: [{ taskId: "lx-program", resourceIds: ["priya"] }] }, fake = wire("proposeRecovery", args);
  const run = await providers.startIntelligence(authority, command(), fake.provider), result = await tools.executeIntelligenceTool(authority, { runId: run.id, callId: fake.callId, name: "proposeRecovery", args });
  assert.equal(result.ok, true);
  const desk = await tools.intelligenceWorkspace(authority), proposal = desk.proposals[0]!;
  assert.equal(proposal.candidate.report.engine?.status, "passed"); assert.equal(proposal.candidate.report.status, "feasible_with_approval");
  assert.equal((await fixture.pool.query("SELECT revision FROM on_shows WHERE tenant_id=$1", [show.tenantId])).rows[0].revision, show.revision);
  const review = { commandId: randomUUID(), expectedRevision: show.revision, proposalId: proposal.id, proposalDigest: proposal.digest, reviewed: true as const };
  await assert.rejects(tools.reviewIntelligenceProposal(authority, { ...review, proposalDigest: "f".repeat(64) }), code("PROPOSAL_CHANGED"));
  const accepted = await tools.reviewIntelligenceProposal(authority, review);
  assert.equal(accepted.show.revision, show.revision + 1); assert.equal(accepted.show.runs.at(-1)!.strategySource, "model_assisted_proposal");
  assert.deepEqual(accepted.show.tasks, show.tasks); assert.equal(accepted.show.approvedPlan, null); assert.deepEqual(accepted.show.financialEvidence, []); assert.deepEqual(accepted.show.acknowledgments, []);
  assert.equal((await tools.reviewIntelligenceProposal(authority, review)).replayed, true);
  await assert.rejects(fixture.pool.query("UPDATE on_intelligence_proposals SET candidate_cipher='changed' WHERE id=$1", [proposal.id]), /Immutable planning proposal/);
});
test("an infeasible Tom proposal is retained with rejection, and cannot enter reviewed alternatives", async () => {
  const { authority, show } = await workspace(), candidate = show.runs.at(-1)!.candidates.find(item => item.id.startsWith("doors-brightline"))!;
  const args = { candidateId: candidate.id, candidateDigest: candidate.digest, assignments: [{ taskId: "lx-program", resourceIds: ["tom"] }] }, fake = wire("proposeRecovery", args);
  const run = await providers.startIntelligence(authority, command(), fake.provider); await tools.executeIntelligenceTool(authority, { runId: run.id, callId: fake.callId, name: "proposeRecovery", args });
  const proposal = (await tools.intelligenceWorkspace(authority)).proposals[0]!;
  assert.equal(proposal.candidate.report.status, "infeasible"); assert.ok(proposal.candidate.report.issues.some(item => item.code === "QUALIFICATION"));
  await assert.rejects(tools.reviewIntelligenceProposal(authority, { commandId: randomUUID(), expectedRevision: show.revision, proposalId: proposal.id, proposalDigest: proposal.digest, reviewed: true }), code("PROPOSAL_NOT_FEASIBLE"));
});
test("schema rejects provider-invented financial tools and malformed/parallel calls", () => {
  const response = (name: string) => ({ status: "completed", output: [{ type: "function_call", call_id: "test", name, arguments: "{}" }] });
  assert.throws(() => providers.completionFromProvider(response("capturePayment")), /PROVIDER_TOOL_POLICY/);
  assert.throws(() => providers.completionFromProvider({ status: "completed", output: [...response("readProduction").output, ...response("readProduction").output] }), /PROVIDER_OUTPUT_SHAPE/);
  assert.throws(() => providers.completionFromProvider({ status: "completed", output: [] }), /PROVIDER_OUTPUT_SHAPE/);
  assert.equal(providers.planningProvider().configured, false);
});
