/** Communications writer inside the audience workflow: disposable PostgreSQL schema, controlled commerce wire, and an in-memory model stub. No provider is contacted. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AUDIENCE_TEMPLATE_VERSION } from "../src/domain/audience/contracts";
import type { WriterPurpose, WriterSegment } from "../src/domain/audience/writer";
import type { PlanningProvider } from "../src/server/intelligence/provider";
// Same controlled commerce wire as the audience suite: installed SDK encoding over an in-memory fetch; provider credentials stay blank.
process.env.OPENING_NIGHT_QA_FIXTURE = ""; process.env.OPENING_NIGHT_AUDIENCE_CONTROLLED_WIRE = "1"; process.env.APP_BASE_URL = "http://127.0.0.1:4594";
const { audienceHarness } = await import("./audience-harness");
const h = await audienceHarness(); after(h.close);
const writer = await import("../src/server/audience/writer");
type Value = Awaited<ReturnType<typeof h.fresh>>;
type Call = { raw: string; body: Record<string, unknown> };
function stub(reply: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const provider: PlanningProvider = { configured: true, mode: "controlled_fixture", fetch: (async (_url: unknown, init?: RequestInit) => { const raw = String(init?.body); calls.push({ raw, body: JSON.parse(raw) }); return reply(); }) as typeof fetch };
  return { provider, calls };
}
const completed = (output: unknown) => Response.json({ id: "resp_fixture_writer", status: "completed", model: "controlled-fixture-model", output: [{ type: "message", content: [{ type: "output_text", text: typeof output === "string" ? output : JSON.stringify(output) }] }] });
const body = "The VIP soundcheck for The Night Ferries at Alder Hall has been cancelled. A $15.00 refund for soundcheck access has been approved, and your ticket page shows its current status. Doors open at 7:00 PM as scheduled.";
const draft = (value: Record<string, unknown> = {}) => ({ subject: "The Night Ferries: VIP soundcheck update", body, shortVariant: null, factsUsed: ["event_title", "venue", "doors_time", "refund_amount", "refund_status", "vip_soundcheck_status"], ...value });
async function published() {
  const value = await h.accepted({ replacePlan: false }); await h.command(value.actor, { type: "publish" });
  assert.equal((await h.audience.readAudienceWorkspace(value.authority)).event.scheduleStatus, "current");
  const first = await h.capture(value), second = await h.capture(value), standard = await h.capture(value, "standard");
  const a = await h.invite(value, first.ticket.id), b = await h.invite(value, second.ticket.id), c = await h.invite(value, standard.ticket.id);
  return { value, tickets: [first, second, standard], inboxes: [a, b, c] };
}
async function ask(value: Value, provider: PlanningProvider, mode: "live" | "recorded" = "live", purpose: WriterPurpose = "vip_soundcheck_refund", segment: WriterSegment = "vip") {
  const workspace = await h.audience.readAudienceWorkspace(value.authority);
  return writer.draftWithWriter(value.authority, { commandId: randomUUID(), sessionFingerprint: workspace.sessionFingerprint, sessionExpiresAt: workspace.expiresAt, sourceDigest: workspace.sourceDigest, purpose, segment, mode }, provider);
}
const save = async (value: Value, runId: string, note: string, recipientIds: string[]) => h.audienceAct(value.authority, { type: "draft_message", kind: "vip_remedy", recipientIds, sourceDigest: (await h.audience.readAudienceWorkspace(value.authority)).sourceDigest, templateVersion: AUDIENCE_TEMPLATE_VERSION, note, validForMinutes: 10, writer: { runId } });
const refund = (value: Value, ticketId: string) => h.store.getShow(value.actor.tenantId).then(show => h.paymentService.handlePayment(value.actor, { type: "refund_perk", ticketId, expectedRevision: show.revision }, "http://127.0.0.1:4594"));

test("the writer receives only approved facts, its draft is fact-checked, and saving it changes nothing about separate producer approval", async () => {
  const { value, tickets, inboxes } = await published(), { provider, calls } = stub(() => completed(draft()));
  const run = await ask(value, provider);
  assert.equal(run.state, "draft_ready"); assert.equal(run.provenance, "model"); assert.equal(run.model, "controlled-fixture-model"); assert.equal(run.label, "AI draft · requires producer approval"); assert.equal(run.check!.passed, true); assert.equal(run.draft!.body, body);
  assert.deepEqual(run.facts!.remedy, { item: "soundcheck access", amount: "$15.00", amountMinor: 1500, tickets: 2, confirmed: 0, notYetConfirmed: 2, unknown: 0, state: "not_all_confirmed" }); assert.equal(run.facts!.doors.time, "7:00 PM");
  // Outgoing request: facts only. No attendee, ticket, capture, inbox, tenant, session or credential value.
  assert.equal(calls.length, 1); const sent = calls[0]!, request = sent.body as { tools: unknown[]; store: boolean; input: { content: { text: string }[] }[]; text: { format: { strict: boolean } } };
  assert.deepEqual(request.tools, []); assert.equal(request.store, false); assert.equal(request.text.format.strict, true); assert.deepEqual(JSON.parse(request.input[0]!.content[0]!.text), run.facts);
  const show = await h.store.getShow(value.actor.tenantId);
  for (const forbidden of [...tickets.flatMap(item => [item.ticket.id, item.captureId, item.orderId, item.captureId.slice(-6)]), ...inboxes.flatMap(item => [item.capabilityId, item.token]), value.actor.tenantId, value.actor.id, value.token, value.authority.sessionHash, ...show.resources.filter(row => row.kind === "person").map(row => row.name), ...show.financialEvidence.map(row => row.providerResourceId)]) assert.ok(!sent.raw.includes(forbidden), "a private identity was sent to the model");
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}|Bearer |sk-[A-Za-z0-9]{8,}/i.test(sent.raw));
  // Drafting saved no message. The producer saves, approves and delivers through the existing separate commands.
  const before = await h.audience.readAudienceWorkspace(value.authority); assert.equal(before.messages.length, 0);
  const saved = await save(value, run.id, run.draft!.body, [inboxes[0]!.capabilityId, inboxes[1]!.capabilityId]), view = await h.audience.readAudienceMessage(value.authority, saved.receipt.recordId);
  assert.match(saved.receipt.message, /requires producer approval; nothing was delivered/); assert.equal(view.approval, null); assert.equal(view.deliveries.length, 0); assert.equal(view.draft.note, body);
  assert.ok(view.draft.recipients.every(item => item.content.body.includes("Producer note: " + body) && item.content.body.includes("VIP soundcheck $15.00")));
  const state = await writer.readWriterWorkspace(value.authority, provider); assert.deepEqual(state.drafts.map(item => [item.draftId, item.runId, item.provenance, item.edited]), [[view.draft.id, run.id, "model", false]]); assert.equal(state.live.used, 1); assert.equal(state.runs[0]!.id, run.id);
  const approved = await h.approve(value, view.draft.id); assert.ok(approved.view.approval); assert.equal(approved.view.deliveries.length, 0);
  const delivered = await h.deliver(value, view.draft.id); assert.equal(delivered.view.deliveries.length, 2);
  // An exact repeat returns the retained run and makes no second request.
  assert.equal((await writer.draftWithWriter(value.authority, { commandId: run.commandId, sessionFingerprint: before.sessionFingerprint, sessionExpiresAt: before.expiresAt, sourceDigest: before.sourceDigest, purpose: "vip_soundcheck_refund", segment: "vip", mode: "live" }, provider)).id, run.id); assert.equal(calls.length, 1);
});

test("drafts with a wrong time, a wrong amount or a premature refund claim are retained as rejected and cannot be saved", async () => {
  const { value, tickets, inboxes } = await published(), ids = [inboxes[0]!.capabilityId, inboxes[1]!.capabilityId];
  const wrongTime = await ask(value, stub(() => completed(draft({ body: body.replace("7:00 PM", "7:30 PM") }))).provider);
  assert.equal(wrongTime.state, "fact_check_failed"); assert.deepEqual(wrongTime.check!.checks.filter(row => row.status === "fail").map(row => row.id), ["times"]);
  const premature = await ask(value, stub(() => completed(draft({ body: "The VIP soundcheck has been cancelled and your $25.00 has been refunded. Doors open at 7:00 PM." }))).provider);
  assert.deepEqual(premature.check!.checks.filter(row => row.status === "fail").map(row => row.id), ["amounts", "refund_status"]);
  for (const run of [wrongTime, premature]) await assert.rejects(save(value, run.id, run.draft!.body, ids), (error: Error & { code: string }) => { assert.equal(error.code, "AUDIENCE_WRITER_FACT_CHECK"); assert.match(error.message, /was not saved/); return true; });
  assert.equal((await h.audience.readAudienceWorkspace(value.authority)).messages.length, 0);
  // The producer may correct the words; the corrected note is checked again and recorded as edited.
  const edited = await save(value, wrongTime.id, body, ids), state = await writer.readWriterWorkspace(value.authority);
  assert.deepEqual(state.drafts.map(item => [item.draftId, item.edited]), [[edited.receipt.recordId, true]]);
  // A standard-ticket inbox cannot receive a draft written for the VIP segment.
  await assert.rejects(h.audienceAct(value.authority, { type: "draft_message", kind: "event_update", recipientIds: [inboxes[2]!.capabilityId], sourceDigest: (await h.audience.readAudienceWorkspace(value.authority)).sourceDigest, templateVersion: AUDIENCE_TEMPLATE_VERSION, note: body, validForMinutes: 10, writer: { runId: wrongTime.id } }), { code: "AUDIENCE_WRITER_RUN" });
  // Once every refund in the segment is confirmed in the ledger, the completion wording is accepted and a "pending" claim is not.
  for (const item of tickets.slice(0, 2)) assert.equal((await refund(value, item.ticket.id)).status, "succeeded");
  const done = await ask(value, stub(() => completed(draft({ body: "The VIP soundcheck has been cancelled and your $15.00 soundcheck access refund has been confirmed. Doors open at 7:00 PM." }))).provider);
  assert.equal(done.facts!.remedy!.state, "all_confirmed"); assert.equal(done.state, "draft_ready");
  await assert.rejects(save(value, premature.id, "Your $15.00 refund is pending. Doors open at 7:00 PM.", ids), { code: "AUDIENCE_WRITER_FACT_CHECK" });
  // That was the third live run for this production: the cap refuses a fourth before any request and points to the recorded draft.
  const blocked = stub(() => completed(draft()));
  await assert.rejects(ask(value, blocked.provider), (error: Error & { code: string; status: number }) => { assert.equal(error.code, "MODEL_AGENT_LIMIT"); assert.equal(error.status, 429); assert.match(error.message, /recorded/i); return true; });
  assert.equal(blocked.calls.length, 0); assert.equal((await writer.readWriterWorkspace(value.authority)).live.available, false);
});

test("timeouts, refusals and malformed answers are stored as failures; unsupported purposes and a disconnected model make no request", async () => {
  const { value } = await published();
  const timeout = await ask(value, stub(() => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }).provider); assert.equal(timeout.state, "failed"); assert.equal(timeout.failure!.code, "MODEL_TIMEOUT"); assert.equal(timeout.draft, null);
  const refusal = await ask(value, stub(() => Response.json({ id: "resp_refused", status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] })).provider); assert.equal(refusal.failure!.code, "MODEL_REFUSAL");
  const shape = await ask(value, stub(() => completed({ subject: "Short", message: "wrong field" })).provider); assert.equal(shape.failure!.code, "MODEL_OUTPUT_SHAPE"); assert.equal(shape.draft, null);
  const rows = (await h.database.pool.query("SELECT state,failure_code FROM on_model_agent_runs WHERE tenant_id=$1 AND agent='writer' ORDER BY created_at", [value.actor.tenantId])).rows;
  assert.deepEqual(rows.map(row => [row.state, row.failure_code]), [["failed", "MODEL_TIMEOUT"], ["failed", "MODEL_REFUSAL"], ["failed", "MODEL_OUTPUT_SHAPE"]]);
  assert.deepEqual((await writer.readWriterWorkspace(value.authority)).runs.map(run => run.state), ["failed", "failed", "failed"]);
  await assert.rejects(h.audienceAct(value.authority, { type: "draft_message", kind: "vip_remedy", recipientIds: [randomUUID()], sourceDigest: "0".repeat(64), templateVersion: AUDIENCE_TEMPLATE_VERSION, note: body, validForMinutes: 10, writer: { runId: timeout.id } }));
  const other = await published(), never = stub(() => completed(draft()));
  await assert.rejects(ask(other.value, never.provider, "live", "doors_delay", "all"), { code: "AUDIENCE_WRITER_PURPOSE" });
  await assert.rejects(ask(other.value, never.provider, "live", "event_cancellation", "all"), { code: "AUDIENCE_WRITER_PURPOSE" });
  await assert.rejects(ask(other.value, { configured: false, mode: "live_model", fetch: never.provider.fetch }), (error: Error & { code: string }) => { assert.equal(error.code, "MODEL_AGENT_UNAVAILABLE"); assert.match(error.message, /recorded/i); return true; });
  assert.equal(never.calls.length, 0); assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_model_agent_runs WHERE tenant_id=$1", [other.value.actor.tenantId])).rows[0].count), 0);
});

test("the recorded draft is one checked-in model response, labeled as recorded and fact-checked live against this production", { skip: "No recorded writer output has been produced yet; recorded mode reports unavailable until one real run is checked in." }, async () => {
  const recorded = (await import("../src/server/intelligence/writer-agent")).recordedWriterOutput();
  assert.ok(recorded, "a recorded writer output is checked in"); assert.equal(recorded.purpose, "vip_soundcheck_refund"); assert.equal(recorded.segment, "vip");
  assert.deepEqual(Object.keys(recorded).sort(), ["factsDigest", "fixture", "kind", "label", "model", "output", "outputDigest", "promptVersion", "purpose", "recordedAt", "responseId", "segment", "version"], "only structured output and metadata are stored");
  const { value, inboxes } = await published(), never: PlanningProvider = { configured: true, mode: "controlled_fixture", fetch: (() => { throw new Error("recorded mode must not call the provider"); }) as typeof fetch };
  const run = await ask(value, never, "recorded");
  assert.equal(run.provenance, "recorded_model"); assert.equal(run.mode, "recorded"); assert.equal(run.recordedAt, recorded.recordedAt); assert.equal(run.model, recorded.model); assert.ok(run.check, "the recorded words were checked here");
  assert.equal(run.state, "draft_ready", JSON.stringify(run.check!.checks.filter(row => row.status === "fail")));
  const state = await writer.readWriterWorkspace(value.authority, never); assert.equal(state.live.used, 0, "a recorded draft is never counted as a live model run"); assert.equal(state.recorded.recordedAt, recorded.recordedAt);
  const saved = await save(value, run.id, run.draft!.body, [inboxes[0]!.capabilityId]);
  assert.deepEqual((await writer.readWriterWorkspace(value.authority, never)).drafts.map(item => [item.draftId, item.provenance, item.recordedAt]), [[saved.receipt.recordId, "recorded_model", recorded.recordedAt]]);
  await assert.rejects(ask(value, never, "recorded", "doors_as_scheduled", "all"), { code: "RECORDED_OUTPUT_UNAVAILABLE" });
});
