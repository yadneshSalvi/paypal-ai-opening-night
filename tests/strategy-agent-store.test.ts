/** Strategy agent against a disposable PostgreSQL schema and the real scheduling engine. The model provider is always an in-memory stub. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { workbenchHarness } from "./planning-workbench-harness";
import { digest } from "../src/domain/hash";
import { strategyAgentInput } from "../src/domain/planning-workbench/model-strategies";
import { candidateProvenance, showStrategyFunnels, strategyFunnels } from "../src/domain/planning-workbench/funnel";
import type { WorkbenchEnvelope } from "../src/domain/planning-workbench/contracts";
import type { PlanningProvider } from "../src/server/intelligence/provider";

const shared = (async () => { const h = await workbenchHarness(), agent = await import("../src/server/planning-workbench/model-strategies"); return { ...h, agent }; })();
after(async () => { await (await shared).close(); });
type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown>; raw: string };
function stub(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const provider: PlanningProvider = { configured: true, mode: "controlled_fixture", fetch: (async (url: unknown, init?: RequestInit) => { const raw = String(init?.body), call = { url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(raw), raw }; calls.push(call); return reply(call); }) as typeof fetch };
  return { provider, calls };
}
const completed = (output: unknown, id = "resp_fixture_strategy") => Response.json({ id, status: "completed", model: "controlled-fixture-model", output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: typeof output === "string" ? output : JSON.stringify(output) }] }] });
let brightline = "";
const item = (value: Record<string, unknown>) => ({ offerId: brightline, kind: "doors_window", minutes: null, order: null, substitution: null, protects: "doors", rationale: "Keeps the opening close to the published time.", assumptions: [], ...value });
async function incident() {
  const h = await shared, p = await h.production(), quoted = await h.quoted(p); brightline = quoted.offers.find(offer => offer.supplierId === "brightline")!.id; assert.ok(quoted.incidents.length);
  const envelope = async (command: WorkbenchEnvelope["command"]): Promise<WorkbenchEnvelope> => { const view = await h.workbench.planningWorkbench(p.authority); return { version: 1, commandId: randomUUID(), scope: view.scope, expectedRevision: view.revision, command }; };
  const reviewOf = async (id: string) => { const row = (await h.workbench.planningWorkbench(p.authority)).reviews.find(item => item.review.id === id)!; assert.ok(row); const content = row.review.content; if (content.kind !== "strategies") throw new Error("wrong review kind"); return { row, content }; };
  return { h, p, envelope, reviewOf, show: () => h.store.getShow(p.actor.tenantId) };
}
const propose = (mode: "live" | "recorded" = "live") => ({ type: "strategies.propose" as const, mode, count: 6 });

test("model proposals are schema-checked individually, rebuilt by the typed constructor, engine-validated and retained with reasons", async () => {
  const { h, p, envelope, reviewOf, show } = await incident(), before = await show();
  const mixed = { candidates: [
    item({ minutes: 20, assumptions: ["The replacement console arrives when quoted."] }),
    item({ minutes: 120, protects: "artist", rationale: "Gives the artist the longest possible preparation." }),
    { offerId: brightline, kind: "doors_window", minutes: 25 },
    item({ offerId: "offer-invented-9", minutes: 30 }),
    item({ kind: "quiet_preparation", minutes: 200 }),
    item({ kind: "running_order", order: "headliner_first", protects: "audience" }),
    item({ kind: "crew_substitution", substitution: { taskId: "lx-program", replaces: "P1", person: "P99" }, protects: "crew" }),
    item({ minutes: 20 }),
  ] };
  const { provider, calls } = stub(() => completed(mixed)), request = await envelope(propose());
  const saved = await h.workbench.executeWorkbench(p.authority, request, provider), { content, row } = await reviewOf(saved.receipt.result.reviewId);
  assert.equal(saved.receipt.result.admitted, false); assert.equal(row.state, "current"); assert.equal(calls.length, 1);
  const generation = content.generation!; assert.ok(generation);
  assert.equal(generation.provenance, "model"); assert.equal(generation.mode, "live"); assert.equal(generation.model, "controlled-fixture-model"); assert.equal(generation.responseId, "resp_fixture_strategy"); assert.equal(generation.outputDigest, digest(mixed)); assert.equal(generation.failure, null); assert.equal(generation.proposed, 8);
  assert.deepEqual(generation.schemaRejected.map(row => [row.index, row.code]), [[2, "MODEL_SCHEMA_INVALID"], [3, "MODEL_UNKNOWN_OFFER"], [4, "MODEL_OUT_OF_BOUNDS"], [6, "MODEL_UNKNOWN_REFERENCE"], [7, "MODEL_DUPLICATE"]]);
  assert.ok(generation.schemaRejected.every(row => row.stage === "schema" && row.message.length > 10));
  assert.equal(content.candidates.length, 3);
  // Every schema-valid proposal carries its own real engine report and the model's untrusted commentary.
  for (const candidate of content.candidates) { assert.ok(["passed", "rejected"].includes(candidate.report.engine!.status)); assert.equal(candidate.strategy!.generator!.provenance, "model"); assert.equal(candidate.strategy!.generator!.model, "controlled-fixture-model"); assert.match(candidate.id, /^model-/); assert.equal(candidateProvenance(candidate), "model"); assert.equal(digest({ patch: candidate.patch, approvals: candidate.approvals, cost: candidate.cost, strategy: candidate.strategy }), candidate.digest); }
  const [near, late, order] = content.candidates as [typeof content.candidates[number], typeof content.candidates[number], typeof content.candidates[number]];
  assert.deepEqual(near.strategy!.generator!.assumptions, ["The replacement console arrives when quoted."]); assert.equal(near.strategy!.generator!.protects, "doors"); assert.equal(near.report.engine!.status, "passed");
  assert.equal(late.report.status, "infeasible"); assert.ok(late.report.issues.some(issue => issue.severity === "hard" && issue.message.length > 10), "the engine/rule rejection keeps its reason");
  assert.equal(order.report.status, "unknown_pending_evidence"); assert.ok(order.report.issues.some(issue => issue.code === "RUNNING_ORDER_CUE_POLICY"));
  // The model's own text never decides a status: no candidate is approvable merely because it was proposed.
  assert.ok(content.candidates.every(candidate => candidate.approvals.every(approval => approval.grantedBy === null)));
  const funnel = strategyFunnels([{ candidates: content.candidates, generation }]);
  assert.equal(funnel.model.generated, 8); assert.equal(funnel.model.schemaRejected, 5); assert.equal(funnel.model.schemaValid, 3);
  assert.equal(funnel.model.temporalRejected + funnel.model.semanticRejected, 1); assert.equal(funnel.model.evidencePending, 1); assert.equal(funnel.model.approvable, 1);
  assert.equal(funnel.model.generated, funnel.model.schemaRejected + funnel.model.temporalRejected + funnel.model.semanticRejected + funnel.model.evidencePending + funnel.model.approvable);
  for (const code of ["MODEL_SCHEMA_INVALID", "MODEL_UNKNOWN_OFFER", "MODEL_OUT_OF_BOUNDS", "MODEL_UNKNOWN_REFERENCE", "MODEL_DUPLICATE"]) assert.equal(funnel.model.rejections.find(row => row.code === code)?.count, 1);
  assert.ok(funnel.model.pending.some(row => row.code === "RUNNING_ORDER_CUE_POLICY"));
  assert.equal(funnel.deterministic.generated, 0); assert.equal(funnel.recorded_model.generated, 0);
  assert.equal(digest(await show()), digest(before), "a proposal changes no production state");
  // Exact replay returns the original receipt and makes no second provider request.
  assert.deepEqual((await h.workbench.executeWorkbench(p.authority, request, provider)).receipt, saved.receipt); assert.equal(calls.length, 1);
  assert.deepEqual((await h.workbench.recoverWorkbench(p.authority, request.commandId)).receipt, saved.receipt);
});

test("the outgoing request is credential-free and name-free, uses the configured tool-free structured contract, and omits untrusted free text", async () => {
  const { h, p, envelope, show } = await incident(), current = await show();
  const { provider, calls } = stub(() => completed({ candidates: [item({ minutes: 15 })] }));
  await h.workbench.executeWorkbench(p.authority, await envelope(propose()), provider);
  const call = calls[0]!, body = call.body as { model: string; tools: unknown[]; tool_choice: string; store: boolean; text: { format: { type: string; strict: boolean; name: string } }; input: { content: { text: string }[] }[]; safety_identifier: string };
  assert.equal(call.url, "https://api.openai.com/v1/responses"); assert.equal(body.model, "controlled-fixture-model"); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, "none"); assert.equal(body.store, false);
  assert.equal(body.text.format.type, "json_schema"); assert.equal(body.text.format.strict, true);
  const people = current.resources.filter(row => row.kind === "person");
  assert.ok(people.length > 3);
  for (const person of people) { assert.ok(!call.raw.includes(person.name), `person name ${person.id} must not be sent`); assert.ok(!new RegExp(`"${person.id}"`).test(call.raw), `person id ${person.id} must not be sent`); }
  for (const forbidden of [current.tenantId, p.actor.id, p.token, p.authority.sessionHash, ...current.incidents.map(row => row.sourceText), ...current.incidents.map(row => row.title), ...current.offers.map(row => row.terms), ...current.offers.map(row => row.supplier), current.title, current.venue]) assert.ok(!call.raw.includes(forbidden), "private or free-text value was sent");
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i.test(call.raw), "no email address"); assert.ok(!/sk-[A-Za-z0-9]{8,}|Bearer /.test(call.raw), "no credential in the body");
  assert.match(body.safety_identifier, /^[a-f0-9]{64}$/);
  const document = JSON.parse(body.input[0]!.content[0]!.text) as ReturnType<typeof strategyAgentInput>["document"];
  assert.deepEqual(document.offers.map(row => row.offerId), current.offers.map(row => row.id)); assert.ok(document.people.every(row => /^P\d+$/.test(row.alias))); assert.equal(document.incidents.length, current.incidents.length);
});

test("timeouts, refusals, invalid JSON, wrong shapes and zero valid proposals are stored as failures and cannot be admitted", async () => {
  const { h, p, envelope, reviewOf, show } = await incident();
  const cases: [string, () => Response | Promise<Response>][] = [
    ["MODEL_TIMEOUT", () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }],
    ["MODEL_REFUSAL", () => Response.json({ id: "resp_refused", status: "completed", model: "controlled-fixture-model", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] })],
    ["MODEL_INVALID_JSON", () => completed("{ not json")],
  ];
  for (const [code, reply] of cases) {
    const { provider } = stub(reply), saved = await h.workbench.executeWorkbench(p.authority, await envelope(propose()), provider), { content } = await reviewOf(saved.receipt.result.reviewId);
    assert.equal(content.generation!.failure!.code, code); assert.equal(content.candidates.length, 0); assert.equal(content.generation!.provenance, "model"); assert.match(saved.receipt.result.message, /deterministic families remain available/i);
    await assert.rejects(h.workbench.executeWorkbench(p.authority, await envelope({ type: "strategies.admit", reviewId: saved.receipt.result.reviewId, reviewDigest: saved.receipt.result.digest, reviewed: true })), { code: "STRATEGY_NOTHING_TO_ADMIT" });
  }
  assert.equal((await show()).runs.length, 0, "a failed model attempt never becomes a recovery run, deterministic or otherwise");
  const rows = (await h.database.pool.query("SELECT state,failure_code,mode FROM on_model_agent_runs WHERE tenant_id=$1 ORDER BY created_at", [p.actor.tenantId])).rows;
  assert.deepEqual(rows.map(row => [row.state, row.failure_code, row.mode]), [["failed", "MODEL_TIMEOUT", "live"], ["failed", "MODEL_REFUSAL", "live"], ["failed", "MODEL_INVALID_JSON", "live"]]);
  // The per-production cap counted those three live attempts; the next one is refused before any request, with a pointer to recorded mode.
  const blocked = stub(() => completed({ candidates: [item({ minutes: 15 })] }));
  await assert.rejects(h.workbench.executeWorkbench(p.authority, await envelope(propose()), blocked.provider), (error: Error & { code: string; status: number }) => { assert.equal(error.code, "MODEL_AGENT_LIMIT"); assert.equal(error.status, 429); assert.match(error.message, /recorded model output/i); return true; });
  assert.equal(blocked.calls.length, 0);
  const status = (await h.workbench.planningWorkbench(p.authority)).modelAgent!; assert.equal(status.live.available, false); assert.equal(status.live.used, 3); assert.equal(status.live.limit, 3);
});

test("wrong shape and zero schema-valid proposals keep each rejection; a disconnected model makes no request and consumes nothing", async () => {
  const { h, p, envelope, reviewOf } = await incident();
  const shape = stub(() => completed({ plans: [] })), first = await h.workbench.executeWorkbench(p.authority, await envelope(propose()), shape.provider);
  assert.equal((await reviewOf(first.receipt.result.reviewId)).content.generation!.failure!.code, "MODEL_OUTPUT_SHAPE");
  const none = stub(() => completed({ candidates: [item({ offerId: "offer-nowhere-1", minutes: 20 }), { kind: "approve_everything" }] })), second = await h.workbench.executeWorkbench(p.authority, await envelope(propose()), none.provider), { content } = await reviewOf(second.receipt.result.reviewId);
  assert.equal(content.generation!.failure!.code, "MODEL_ZERO_VALID"); assert.deepEqual(content.generation!.schemaRejected.map(row => row.code), ["MODEL_UNKNOWN_OFFER", "MODEL_SCHEMA_INVALID"]); assert.equal(content.candidates.length, 0);
  const funnel = strategyFunnels([{ candidates: content.candidates, generation: content.generation }]).model; assert.equal(funnel.generated, 2); assert.equal(funnel.schemaRejected, 2); assert.equal(funnel.failedRuns, 1); assert.equal(funnel.approvable, 0);
  const off: PlanningProvider = { configured: false, mode: "live_model", fetch: (() => { throw new Error("must not be called"); }) as typeof fetch };
  const before = Number((await h.database.pool.query("SELECT count(*) FROM on_model_agent_runs WHERE tenant_id=$1", [p.actor.tenantId])).rows[0].count);
  await assert.rejects(h.workbench.executeWorkbench(p.authority, await envelope(propose()), off), (error: Error & { code: string }) => { assert.equal(error.code, "MODEL_AGENT_UNAVAILABLE"); assert.match(error.message, /recorded model output/i); return true; });
  assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_model_agent_runs WHERE tenant_id=$1", [p.actor.tenantId])).rows[0].count), before);
});

test("provenance is never mixed: deterministic and model attempts keep separate funnels through admission, and admission approves nothing", async () => {
  const { h, p, envelope, reviewOf, show } = await incident();
  const deterministic = await h.workbench.executeWorkbench(p.authority, await envelope({ type: "strategies.preview", request: { kinds: ["doors_window", "running_order"], offerIds: [brightline], substitutions: [] } }));
  const fixed = (await reviewOf(deterministic.receipt.result.reviewId)).content;
  assert.equal(fixed.generation, undefined); assert.ok(fixed.candidates.every(candidate => !candidate.strategy!.generator && candidateProvenance(candidate) === "deterministic" && /^strategy-/.test(candidate.id)));
  const { provider } = stub(() => completed({ candidates: [item({ minutes: 20 }), item({ kind: "set_length", minutes: 80, protects: "budget" }), item({ offerId: "offer-ghost-1", minutes: 10 })] }));
  const proposed = await h.workbench.executeWorkbench(p.authority, await envelope(propose()), provider), model = (await reviewOf(proposed.receipt.result.reviewId)).content;
  assert.ok(model.candidates.every(candidate => candidate.strategy!.generator!.provenance === "model"));
  const both = strategyFunnels([{ candidates: fixed.candidates }, { candidates: model.candidates, generation: model.generation }]);
  assert.equal(both.deterministic.generated, 4); assert.equal(both.deterministic.runs, 1); assert.equal(both.model.generated, 3); assert.equal(both.model.schemaRejected, 1); assert.equal(both.model.runs, 1); assert.equal(both.recorded_model.generated, 0);
  // Even a mislabeled container cannot relabel a deterministic candidate as model output, or the reverse.
  const crossed = strategyFunnels([{ candidates: [...fixed.candidates, ...model.candidates] }]); assert.equal(crossed.deterministic.generated, 4); assert.equal(crossed.model.generated, 2);
  const before = await show();
  const admitted = await h.workbench.executeWorkbench(p.authority, await envelope({ type: "strategies.admit", reviewId: proposed.receipt.result.reviewId, reviewDigest: proposed.receipt.result.digest, reviewed: true })), next = await show();
  assert.equal(admitted.receipt.result.admitted, true); assert.equal(next.revision, before.revision + 1);
  const run = next.runs.at(-1)!; assert.equal(run.generation!.provenance, "model"); assert.equal(run.generation!.schemaRejected.length, 1); assert.equal(run.candidates.length, 2);
  assert.deepEqual(next.approvedPlan, before.approvedPlan); assert.deepEqual(next.tasks, before.tasks); assert.deepEqual(next.sheets, before.sheets); assert.deepEqual(next.financialEvidence, before.financialEvidence);
  assert.match(next.events.at(-1)!.message, /model approved nothing/i);
  const stored = showStrategyFunnels(next, "all"); assert.equal(stored.model.generated, 3); assert.equal(stored.model.schemaRejected, 1); assert.equal(stored.model.schemaValid, 2); assert.equal(stored.deterministic.generated, 0);
  assert.deepEqual(showStrategyFunnels(next, "latest").model, stored.model);
});

test("the shared daily cap is enforced in PostgreSQL before any request and names recorded mode", async () => {
  const { h, p, envelope } = await incident(), original = process.env.OPENING_NIGHT_MODEL_AGENT_DAILY_CAP;
  const live = Number((await h.database.pool.query("SELECT count(*) FROM on_model_agent_runs WHERE mode='live' AND created_at>clock_timestamp()-interval '1 day'")).rows[0].count);
  process.env.OPENING_NIGHT_MODEL_AGENT_DAILY_CAP = String(live);
  try {
    const { provider, calls } = stub(() => completed({ candidates: [item({ minutes: 15 })] }));
    await assert.rejects(h.workbench.executeWorkbench(p.authority, await envelope(propose()), provider), (error: Error & { code: string }) => { assert.equal(error.code, "MODEL_AGENT_LIMIT"); assert.match(error.message, /shared limit/i); assert.match(error.message, /recorded model output/i); return true; });
    assert.equal(calls.length, 0);
    assert.equal((await h.workbench.planningWorkbench(p.authority)).modelAgent!.live.available, false);
  } finally { if (original === undefined) delete process.env.OPENING_NIGHT_MODEL_AGENT_DAILY_CAP; else process.env.OPENING_NIGHT_MODEL_AGENT_DAILY_CAP = original; }
});

test("recorded mode replays one checked-in model response through live validation, labeled as recorded, without any provider request", async () => {
  const { h, p, show } = await incident(), recorded = (await import("../src/server/intelligence/strategy-agent")).recordedStrategyOutput();
  assert.ok(recorded, "a recorded strategy output is checked in"); assert.ok(Number.isFinite(Date.parse(recorded.recordedAt))); assert.ok(recorded.model.length > 2);
  assert.deepEqual(Object.keys(recorded).sort(), ["fixture", "inputDigest", "kind", "label", "model", "output", "outputDigest", "promptVersion", "recordedAt", "references", "responseId", "version"], "only structured output and metadata are stored");
  const never: PlanningProvider = { configured: true, mode: "controlled_fixture", fetch: (() => { throw new Error("recorded mode must not call the provider"); }) as typeof fetch };
  const before = await show(), result = await h.agent.proposeStrategies(p.authority, { mode: "recorded" }, never);
  assert.equal(result.generation!.provenance, "recorded_model"); assert.equal(result.generation!.mode, "recorded"); assert.equal(result.generation!.recordedAt, recorded.recordedAt); assert.equal(result.generation!.model, recorded.model); assert.equal(result.generation!.failure, null);
  assert.ok(result.candidates.length > 0);
  for (const candidate of result.candidates) { assert.equal(candidate.strategy!.generator!.provenance, "recorded_model"); assert.equal(candidate.strategy!.generator!.recordedAt, recorded.recordedAt); assert.ok(candidate.report.engine, "validated live by the real engine"); assert.ok(Date.parse(candidate.report.engine!.computedAt) > Date.parse(recorded.recordedAt)); assert.equal(candidate.sourceDigest, (await import("../src/domain/scheduling")).planningDigest(before)); }
  assert.equal(result.funnel.recorded_model.generated, result.generation!.proposed); assert.equal(result.funnel.model.generated, 0); assert.equal(result.funnel.deterministic.generated, 0);
  const row = (await h.database.pool.query("SELECT mode,state FROM on_model_agent_runs WHERE tenant_id=$1", [p.actor.tenantId])).rows; assert.deepEqual(row.map(item => [item.mode, item.state]), [["recorded", "completed"]]);
  const status = (await h.workbench.planningWorkbench(p.authority)).modelAgent!; assert.equal(status.live.used, 0, "a recorded replay is never counted as a live model run"); assert.equal(status.recorded.recordedAt, recorded.recordedAt);
});
