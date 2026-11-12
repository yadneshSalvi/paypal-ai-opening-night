/**
 * Guided demonstration director: the complete journey through the actual
 * services with replayed payment outcomes. The preload closes the network, so
 * any outbound request fails the suite; no provider or model is contacted.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedDatabase } from "./isolated-database";
import { financialSummary } from "../src/domain/finance";
import { JUDGE_BEAT_IDS, JUDGE_PAYMENT_NOTICE, type JudgeBeatId, type JudgeView } from "../src/domain/judge/contracts";
import type { Actor } from "../src/domain/contracts";

const guard = (globalThis as typeof globalThis & { openingNightJudgeEgressGuard?: { version: number; attempts: { kind: string; target: string }[] } }).openingNightJudgeEgressGuard;
assert.equal(guard?.version, 1, "Run with --import ./scripts/qa/judge-test-runtime.mjs");
const database = await isolatedDatabase(), pool = database.pool;
const store = await import("../src/server/store"), director = await import("../src/server/judge/director"), views = await import("../src/server/judge/view");
const scope = await import("../src/server/judge/scope"), { ReplayWire } = await import("../src/server/judge/wire"), crew = await import("../src/server/crew/service");
const { providers } = await import("../src/server/paypal-providers"), { consoleData } = await import("../src/server/http"), { sessionTokenHash } = await import("../src/server/session-records");
const { readiness } = await import("../src/server/crew/readiness"), jobs = await import("../src/server/jobs"), runner = await import("../src/server/job-runner"), rehearsals = await import("../src/server/rehearsal-service");
after(async () => { await (await import("../src/server/commerce-locks")).closeCommerceLocks(); await database.close(); });

const origin = "http://localhost:4105", admission = "test:judge-director:" + randomUUID();
// The setter seam installs a sentinel as the ACTUAL provider, so "resolves the real provider path" needs no credential.
const actualVenue = { sentinel: "actual-venue" } as never, actualSupplier = { sentinel: "actual-brightline" } as never;
providers.venue = actualVenue; providers.brightline = actualSupplier;

const ordinary = await store.createSession(undefined, admission);
const started = await director.startDemonstration(ordinary.token, admission);
const authority = { actor: started.actor, sessionHash: sessionTokenHash(started.token) }, tenantId = started.actor.tenantId;
const view = () => views.judgeView(started.actor, origin);
const beat = (value: JudgeView, id: JudgeBeatId) => value.beats.find(item => item.id === id)!;
const advance = (id: JudgeBeatId, key: string = randomUUID(), hooks: Parameters<typeof director.advanceDemonstration>[4] = {}) => director.advanceDemonstration(authority, id, key, origin, hooks);
async function complete(id: JudgeBeatId) { for (let call = 0; call < 20; call++) { const current = await view(); if (current.currentBeatId !== id || !beat(current, id).canAdvance) return current; await advance(id); } throw new Error("Beat did not settle: " + id); }
const wireRows = async (tenant = tenantId) => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM on_judge_wire WHERE tenant_id=$1", [tenant])).rows[0]!.n;
async function crewAccess(url: string) { const token = new URL(url).hash.slice(1); return crew.requireCrewSession(new Request(origin + "/api/crew", { headers: { authorization: "Bearer " + token } })); }
async function fingerprint(tenant: string) {
  return (await pool.query(`SELECT md5(s.snapshot::text) AS snapshot,s.revision,s.updated_at,
    (SELECT md5(string_agg(e.id::text || e.event::text, '' ORDER BY e.id)) FROM on_events e WHERE e.tenant_id=s.tenant_id) AS events,
    (SELECT md5(d.state::text) || d.updated_at::text FROM on_judge_demonstrations d WHERE d.tenant_id=s.tenant_id) AS director,
    (SELECT md5(string_agg(w.order_id || w.document::text || w.updated_at::text, '' ORDER BY w.order_id)) FROM on_judge_wire w WHERE w.tenant_id=s.tenant_id) AS wire,
    (SELECT count(*)::int FROM on_sessions x WHERE x.tenant_id=s.tenant_id) AS sessions,
    (SELECT md5(string_agg(j.id::text || j.status || j.updated_at::text, '' ORDER BY j.id)) FROM on_jobs j WHERE j.tenant_id=s.tenant_id) AS jobs
    FROM on_shows s WHERE s.tenant_id=$1`, [tenant])).rows[0];
}

test("a demonstration is a new private rehearsal; the earlier ordinary rehearsal stays ordinary and intact", async () => {
  assert.notEqual(tenantId, ordinary.actor.tenantId);
  assert.deepEqual(started.show.demonstration && { mode: started.show.demonstration.mode }, { mode: "replay" });
  assert.equal(await scope.isDemonstrationTenant(tenantId), true); assert.equal(await scope.isDemonstrationTenant(ordinary.actor.tenantId), false);
  const plain = consoleData(await store.getShow(ordinary.actor.tenantId), ordinary.actor), guided = consoleData(started.show, started.actor);
  assert.equal(plain.controlledQa, false); assert.equal(plain.demonstration, undefined); assert.equal(plain.paymentNotice, undefined);
  assert.equal(guided.controlledQa, true); assert.equal(guided.demonstration, true); assert.equal(guided.paymentNotice, JUDGE_PAYMENT_NOTICE);
  assert.equal((await views.judgeView(ordinary.actor, origin)).active, false); assert.deepEqual((await views.judgeView(null, origin)).beats, []);
  const saved = await rehearsals.listRehearsals(started.actor);
  assert.deepEqual(saved.items.map(item => item.tenantId).sort(), [tenantId, ordinary.actor.tenantId].sort());
  assert.deepEqual(await store.getActor(ordinary.token), ordinary.actor);
});

test("the demonstration marker is set only at creation and can never be added, changed or removed", async () => {
  await assert.rejects(pool.query("UPDATE on_shows SET snapshot=snapshot - 'demonstration' WHERE tenant_id=$1", [tenantId]), /cannot change/);
  await assert.rejects(pool.query("UPDATE on_shows SET snapshot=jsonb_set(snapshot,'{demonstration,startedAt}','\"2020-01-01T00:00:00.000Z\"') WHERE tenant_id=$1", [tenantId]), /cannot change/);
  await assert.rejects(pool.query("UPDATE on_shows SET snapshot=snapshot || '{\"demonstration\":{\"mode\":\"replay\",\"startedAt\":\"2026-01-01T00:00:00.000Z\"}}' WHERE tenant_id=$1", [ordinary.actor.tenantId]), /cannot change/);
  await assert.rejects(pool.query("INSERT INTO on_judge_demonstrations(tenant_id,mode,state) VALUES($1,'replay','{}')", [ordinary.actor.tenantId]), /only with its newly created rehearsal/);
  await assert.rejects(pool.query("UPDATE on_judge_demonstrations SET tenant_id=$2 WHERE tenant_id=$1", [tenantId, ordinary.actor.tenantId]), /immutable|violates/);
  await assert.rejects(() => director.advanceDemonstration({ actor: ordinary.actor, sessionHash: sessionTokenHash(ordinary.token) }, "standby", randomUUID(), origin), /not a guided demonstration/);
  await assert.rejects(() => scope.withReplayScope(ordinary.actor.tenantId, async () => undefined), /not a guided demonstration/);
});

test("provider selection is tenant scoped: replay inside a demonstration, the actual provider everywhere else", async () => {
  assert.equal(providers.venue, actualVenue); assert.equal(scope.currentReplayScope(), undefined);
  await scope.withTenantProviderScope(ordinary.actor.tenantId, async () => { assert.equal(scope.currentReplayScope(), undefined); assert.equal(providers.venue, actualVenue); assert.equal(providers.brightline, actualSupplier); });
  await Promise.all([
    scope.withTenantProviderScope(tenantId, async () => { await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(scope.currentReplayScope()!.tenantId, tenantId); assert.notEqual(providers.venue, actualVenue); assert.equal(providers.venue.source, "live_sandbox"); assert.notEqual(providers.brightline, actualSupplier); await assert.rejects(() => scope.withTenantProviderScope(ordinary.actor.tenantId, async () => undefined), /replays its payment outcomes/); }),
    (async () => { for (let turn = 0; turn < 8; turn++) { await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(providers.venue, actualVenue); } })(),
  ]);
  assert.equal(providers.venue, actualVenue);
  // The durable worker enters the same scope per job tenant.
  const seen: Record<string, boolean> = {};
  for (const tenant of [tenantId, ordinary.actor.tenantId]) await jobs.enqueueJob(pool, { tenantId: tenant, kind: "supplier_expire", semanticKey: "judge-test:" + tenant, payload: { executionId: randomUUID() } });
  for (const tenant of [tenantId, ordinary.actor.tenantId]) await runner.runJobTick({ tenantId: tenant, limit: 1, handler: async job => { seen[job.tenantId] = providers.venue !== actualVenue && scope.currentReplayScope()?.tenantId === job.tenantId; return { status: "complete" }; } });
  assert.deepEqual(seen, { [tenantId]: true, [ordinary.actor.tenantId]: false });
});

test("beats run in order through the actual services; advance is idempotent and resumes after a failure", async () => {
  let current = await view();
  assert.equal(current.active, true); assert.deepEqual(current.beats.map(item => item.id), [...JUDGE_BEAT_IDS]); assert.equal(current.currentBeatId, "standby"); assert.equal(current.acknowledged, null); assert.deepEqual(current.crewLinks, []);
  await assert.rejects(() => advance("commit"), /not the demonstration's current beat/);

  // STANDBY in bounded chunks: a small budget returns with visible progress, and a later call resumes it.
  await advance("standby", randomUUID(), { budgetMs: 400 });
  current = await view(); const partial = (await store.getShow(tenantId)).tickets.length;
  assert.ok(partial > 0 && partial < director.TICKET_COUNT, "a bounded call captured " + partial); assert.equal(beat(current, "standby").steps[0]!.done, false); assert.match(beat(current, "standby").steps[0]!.detail!, new RegExp("^" + partial + "/80"));
  assert.equal(current.currentBeatId, "standby"); assert.equal((await store.getShow(tenantId)).incidents.length, 0);
  // A lost response mid-capture (the replayed capture was stored, its answer never arrived): the operation is reconciled by a read, never repeated.
  const original = ReplayWire.prototype.fetch; let lost = 0;
  ReplayWire.prototype.fetch = async function (input, init) { const response = await original.call(this, input, init); const request = input instanceof Request ? input : new Request(input, init); if (!lost && request.method === "POST" && new URL(request.url).pathname.endsWith("/capture")) { lost++; throw new TypeError("Controlled lost response after the replayed capture was stored"); } return response; };
  try { await advance("standby", randomUUID(), { budgetMs: 1500 }); } finally { ReplayWire.prototype.fetch = original; }
  assert.equal(lost, 1); // The same call recovered the stored capture by reading it back; nothing was captured twice.
  current = await complete("standby");
  let show = await store.getShow(tenantId);
  assert.equal(show.tickets.length, 80); assert.equal(new Set(show.tickets.map(ticket => ticket.captureId)).size, 80); assert.equal(await wireRows(), 80); assert.equal(show.incidents.length, 2);
  assert.equal(financialSummary(show).grossCapturedMinor, 337000); assert.equal(current.currentBeatId, "options");

  // Same key twice: the second call does nothing.
  const key = randomUUID(), first = await advance("options", key), revision = (await store.getShow(tenantId)).revision, state = (await director.readDirectorState(tenantId))!.state;
  assert.equal(first.replayed, false); assert.deepEqual(first.ranSteps, ["quotes", "candidates"]);
  const second = await advance("options", key);
  assert.equal(second.replayed, true); assert.deepEqual(second.ranSteps, []); assert.equal((await store.getShow(tenantId)).revision, revision); assert.deepEqual((await director.readDirectorState(tenantId))!.state, state);
  await assert.rejects(() => advance("assistant", key), /different beat/);
  show = await store.getShow(tenantId); assert.equal(show.offers.filter(offer => offer.serviceQuote).length, 3); assert.ok(show.runs.at(-1)!.candidates.some(candidate => candidate.id.startsWith("doors-brightline")));

  current = await complete("assistant"); assert.equal(current.currentBeatId, "commit");

  // A failure in the middle of COMMIT (after the hold, before the authorization) and a retry under the same key.
  const commitKey = randomUUID();
  await assert.rejects(() => advance("commit", commitKey, { beforeStep: step => { if (step === "authorization") throw new Error("Simulated mid-beat interruption"); } }), /Simulated mid-beat interruption/);
  show = await store.getShow(tenantId); assert.ok(show.approvedPlan); assert.equal(show.rentalExecutions!.length, 1); assert.equal(show.financialEvidence.filter(entry => entry.kind === "authorization").length, 0);
  assert.equal((await view()).busy, false); assert.equal((await view()).currentBeatId, "commit");
  const resumed = await advance("commit", commitKey);
  assert.equal(resumed.replayed, false); assert.deepEqual(resumed.ranSteps, ["authorization", "confirm", "publish"]);
  show = await store.getShow(tenantId);
  assert.equal(show.rentalExecutions!.length, 1); assert.deepEqual(show.financialEvidence.filter(entry => entry.kind === "authorization").map(entry => entry.amountMinor), [78000]); assert.equal(await wireRows(), 81);
  assert.equal(show.rentalExecutions![0]!.state, "confirmed"); assert.equal(show.sheets.at(-1)!.planRevision, show.planVersion);

  // DELIVERY, interrupted between the fee capture and the refunds.
  await assert.rejects(() => advance("delivery", randomUUID(), { beforeStep: step => { if (step === "refunds") throw new Error("Simulated timeout"); } }), /Simulated timeout/);
  show = await store.getShow(tenantId); assert.deepEqual(show.financialEvidence.filter(entry => entry.kind === "capture" && entry.purpose === "rental").map(entry => entry.amountMinor), [48000]); assert.equal(financialSummary(show).refundedVipCount, 0);
  current = await complete("delivery");
  show = await store.getShow(tenantId); const finance = financialSummary(show);
  assert.equal(finance.refundedVipCount, 38); assert.equal(show.financialEvidence.filter(entry => entry.kind === "refund").reduce((sum, entry) => sum + entry.amountMinor, 0), 57000);
  assert.equal(show.financialEvidence.filter(entry => entry.kind === "capture" && entry.purpose === "rental").length, 1); assert.equal(finance.rentalCapturedMinor, 48000); assert.equal(await wireRows(), 81);
  assert.equal(show.clock, "2026-11-14T23:15:00Z"); assert.equal(current.currentBeatId, "crew");
});

test("the crew beat leaves exactly two people; their links are stable scoped capabilities and the real acknowledgment command completes 11/11", async () => {
  let current = await complete("crew");
  assert.equal(current.currentBeatId, "crew"); assert.deepEqual(current.acknowledged, { current: 9, required: 11 }); assert.equal(beat(current, "crew").canAdvance, false); assert.match(beat(current, "crew").waitingOn!, /CONTROLLED DEVICE/);
  assert.deepEqual(current.crewLinks.map(link => [link.kind, link.personId, link.acknowledged]), [["controlled_device", "avery", false], ["judge_phone", "sam", false]]);
  for (const link of current.crewLinks) { const url = new URL(link.url); assert.equal(url.origin, origin); assert.equal(url.pathname, "/crew/access"); assert.equal(url.searchParams.get("device"), link.kind === "judge_phone" ? "judge" : "controlled"); assert.match(url.hash, /^#[A-Za-z0-9_-]{43}$/); assert.match(link.qrSvg, /^<svg[\s\S]+<\/svg>\s*$/); }
  assert.equal(readiness(await store.getShow(tenantId), "DOORS").ready, false);
  // Polling writes nothing and never mints another capability.
  const sessions = async () => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM on_sessions WHERE tenant_id=$1 AND actor->>'personId'=ANY($2)", [tenantId, ["avery", "sam"]])).rows[0]!.n;
  const before = await sessions(), stamp = (await pool.query("SELECT updated_at FROM on_judge_demonstrations WHERE tenant_id=$1", [tenantId])).rows[0].updated_at;
  for (let poll = 0; poll < 3; poll++) assert.deepEqual((await view()).crewLinks.map(link => link.url), current.crewLinks.map(link => link.url));
  assert.equal(await sessions(), before); assert.deepEqual((await pool.query("SELECT updated_at FROM on_judge_demonstrations WHERE tenant_id=$1", [tenantId])).rows[0].updated_at, stamp);
  // An expired link is replaced on demand; the old record is not extended.
  const phone = current.crewLinks.find(link => link.kind === "judge_phone")!, oldHash = sessionTokenHash(new URL(phone.url).hash.slice(1));
  await pool.query("UPDATE on_sessions SET expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1", [oldHash]);
  await pool.query("UPDATE on_judge_demonstrations SET state=jsonb_set(state,'{crewLinks,judge_phone,expiresAt}',to_jsonb('2020-01-01T00:00:00.000Z'::text)) WHERE tenant_id=$1", [tenantId]);
  await assert.rejects(() => crewAccess(phone.url), /expired or was revoked/);
  current = await view(); const renewed = current.crewLinks.find(link => link.kind === "judge_phone")!;
  assert.notEqual(renewed.url, phone.url); assert.equal(current.crewLinks.find(link => link.kind === "controlled_device")!.url, (await view()).crewLinks[0]!.url);
  assert.ok((await pool.query<{ past: boolean }>("SELECT expires_at<clock_timestamp() AS past FROM on_sessions WHERE token_hash=$1", [oldHash])).rows[0]!.past); assert.equal(await sessions(), before + 1);

  // The two remaining acknowledgments go through the unchanged crew command, including the changed-line rule.
  for (const [index, link] of current.crewLinks.entries()) {
    const access = await crewAccess(link.url), data = await crew.readCrew(access);
    assert.equal(access.actor.personId, link.personId); assert.deepEqual(access.actor.roles, ["crew"]); assert.equal(access.actor.tenantId, tenantId); assert.equal(data.controlledQa, true);
    const command = { type: "acknowledge" as const, sheetVersion: data.sheet!.version, sheetDigest: data.sheet!.digest, offline: false };
    if (data.sheet!.changes.length) await assert.rejects(() => crew.executeCrew(access, { idempotencyKey: randomUUID(), expectedRevision: data.show.revision, command: { ...command, seenTaskIds: [] } }));
    await crew.executeCrew(access, { idempotencyKey: randomUUID(), expectedRevision: data.show.revision, command: { ...command, seenTaskIds: data.sheet!.changes.map(change => change.taskId) } });
    assert.deepEqual((await view()).acknowledged, { current: 10 + index, required: 11 });
  }
  current = await view(); assert.equal(current.currentBeatId, "go"); assert.ok(current.crewLinks.every(link => link.acknowledged));
});

test("GO and HOUSE OPEN are the assigned people's own crew commands against the unchanged readiness report", async () => {
  let current = await complete("go");
  assert.match(beat(current, "go").waitingOn!, /DOORS GO/); assert.equal(beat(current, "go").canAdvance, false);
  let show = await store.getShow(tenantId); const report = readiness(show, "DOORS");
  assert.equal(report.ready, true, report.blockers.join("; ")); assert.equal(report.gates.length, 8); assert.ok(report.gates.every(gate => gate.complete)); assert.equal(show.state, "standby"); assert.equal(show.clock, "2026-11-15T00:45:00Z");
  const act = async (kind: "judge_phone" | "controlled_device", cue: "DOORS_GO" | "HOUSE_OPEN") => {
    const access = await crewAccess((await view()).crewLinks.find(link => link.kind === kind)!.url), data = await crew.readCrew(access), option = data.cues.find(item => item.kind === cue)!;
    assert.equal(option.available, true, option.blockers.join("; "));
    return crew.executeCrew(access, { idempotencyKey: randomUUID(), expectedRevision: data.show.revision, command: { type: "cue", kind: cue, review: data.review!, reportId: option.reportId, precedingCueId: option.precedingCueId, detail: "Suite-performed cue through the judge's scoped crew link.", confirmed: true } });
  };
  // The producer session cannot issue the cue; HOUSE OPEN cannot precede GO.
  const { applyCommand } = await import("../src/domain/commands");
  assert.throws(() => applyCommand(show, started.actor, { type: "go", reportId: report.id }), /stage manager issues GO/);
  await assert.rejects(() => act("controlled_device", "HOUSE_OPEN"));
  await act("judge_phone", "DOORS_GO");
  show = await store.getShow(tenantId); assert.equal(show.state, "go"); assert.equal(show.goReportId, report.id); assert.equal(show.crewCues!.at(-1)!.personId, "sam");
  current = await complete("go"); assert.match(beat(current, "go").waitingOn!, /HOUSE OPEN/); assert.equal((await store.getShow(tenantId)).clock, "2026-11-15T01:00:00Z");
  await act("controlled_device", "HOUSE_OPEN");
  show = await store.getShow(tenantId); assert.equal(show.state, "house_open"); assert.deepEqual(show.crewCues!.map(item => [item.kind, item.personId]), [["DOORS_GO", "sam"], ["HOUSE_OPEN", "avery"]]);
  assert.equal((await view()).currentBeatId, "headliner");
});

test("headliner and wrap complete; every money record is replayed, labeled and counted once; nothing left the process", async () => {
  await complete("headliner");
  let show = await store.getShow(tenantId);
  assert.deepEqual(show.crewCues!.map(item => item.kind), ["DOORS_GO", "HOUSE_OPEN", "SUPPORT_START", "HEADLINER_START"]); assert.equal((await view()).currentBeatId, "wrap");
  const final = await complete("wrap");
  assert.equal(final.currentBeatId, null); assert.ok(final.beats.every(item => item.status === "done" && item.steps.every(step => step.done) && !item.canAdvance));
  show = await store.getShow(tenantId); const finance = financialSummary(show), evidence = show.financialEvidence;
  const total = (kind: string, purpose: string) => evidence.filter(entry => entry.kind === kind && entry.purpose === purpose).reduce((sum, entry) => sum + entry.amountMinor, 0), count = (kind: string, purpose: string) => evidence.filter(entry => entry.kind === kind && entry.purpose === purpose).length;
  assert.deepEqual([count("capture", "ticket"), total("capture", "ticket")], [80, 337000]); assert.deepEqual([count("refund", "vip_remedy"), total("refund", "vip_remedy")], [38, 57000]);
  assert.deepEqual([count("authorization", "rental"), total("authorization", "rental")], [1, 78000]); assert.deepEqual([count("capture", "rental"), total("capture", "rental")], [1, 48000]); assert.deepEqual([count("void", "deposit"), total("void", "deposit")], [1, 30000]);
  assert.equal(evidence.length, 121); assert.equal(new Set(evidence.map(entry => entry.providerResourceId + ":" + entry.kind)).size, 121);
  assert.equal(finance.grossCapturedMinor, 337000); assert.equal(finance.refundedVipCount, 38); assert.equal(finance.rentalCapturedMinor, 48000); assert.equal(finance.releasedMinor, 30000); assert.equal(finance.remainingRentalAuthorizationMinor, 0);
  // Provenance in data: every financial row and ticket says replay, carries a replay identifier, and no event claims a sandbox receipt.
  assert.ok(evidence.every(entry => entry.provenance === "replay" && entry.providerResourceId.startsWith("ONREPLAY-"))); assert.ok(show.tickets.every(ticket => ticket.provenance === "replay" && ticket.captureId!.startsWith("ONREPLAY-")));
  assert.equal(show.events.filter(event => event.source === "live_sandbox").length, 0); assert.ok(show.events.filter(event => event.source === "replay").length >= 121); assert.ok(show.events.filter(event => event.source === "replay").every(event => event.message.startsWith("Replayed outcome, no PayPal request was made.") && !/Verified PayPal/.test(event.message)));
  const stored = (await pool.query<{ live: number; replay: number; unmarked: number }>(`SELECT (SELECT count(*)::int FROM on_events WHERE tenant_id=$1 AND event->>'source'='live_sandbox') AS live,
    (SELECT count(*)::int FROM on_events WHERE tenant_id=$1 AND event->>'source'='replay') AS replay,
    (SELECT count(*)::int FROM on_shows, jsonb_array_elements(snapshot->'financialEvidence') entry WHERE tenant_id=$1 AND entry->>'provenance' IS DISTINCT FROM 'replay') AS unmarked`, [tenantId])).rows[0]!;
  assert.equal(stored.live, 0); assert.ok(stored.replay >= 121); assert.equal(stored.unmarked, 0);
  const listed = (await rehearsals.listRehearsals(started.actor)).items.find(item => item.tenantId === tenantId)!; assert.equal(listed.hasFinancialHistory, false); assert.equal(listed.pendingWork <= 1, true);
  assert.deepEqual((await pool.query<{ kind: string }>("SELECT DISTINCT kind FROM on_jobs WHERE tenant_id=$1 AND status IN ('queued','waiting','running')", [tenantId])).rows.map(row => row.kind).filter(kind => kind !== "supplier_expire"), []);
  assert.equal(await wireRows(), 81); assert.equal(consoleData(show, started.actor).controlledQa, true);
  // Egress: the replay transport answered in process; the network guard saw nothing.
  const { egress } = (await director.readDirectorState(tenantId))!.state;
  assert.ok(egress.replayed > 400); assert.equal(egress.forwardedDuringSteps, 0); assert.equal(egress.refused, 0); assert.deepEqual(guard!.attempts, []);
});

test("outside a replay scope the actual provider transport refuses anything owned by a demonstration before sending it", async () => {
  const operation = (await pool.query<{ provider_request_id: string }>("SELECT provider_request_id FROM paycore_operations WHERE tenant_id=$1 LIMIT 1", [tenantId])).rows[0]!;
  const captureId = (await store.getShow(tenantId)).tickets[0]!.captureId!, base = "https://api-m.sandbox.paypal.com", before = scope.providerEgress.forwarded;
  await assert.rejects(() => scope.liveProviderFetch(base + "/v2/checkout/orders", { method: "POST", headers: { "PayPal-Request-Id": operation.provider_request_id }, body: "{}" }), /replays its payment outcomes/);
  await assert.rejects(() => scope.liveProviderFetch(new Request(base + "/v2/checkout/orders", { method: "POST", headers: { "PayPal-Request-Id": operation.provider_request_id }, body: "{}" })), /replays its payment outcomes/);
  await assert.rejects(() => scope.liveProviderFetch(base + "/v2/payments/captures/" + captureId), /replays its payment outcomes/);
  await assert.rejects(() => scope.liveProviderFetch(base + "/v2/payments/captures/" + captureId + "/refund", { method: "POST", body: "{}" }), /replays its payment outcomes/);
  await scope.withTenantProviderScope(tenantId, () => assert.rejects(() => scope.liveProviderFetch(base + "/v1/oauth2/token", { method: "POST" }), /replays its payment outcomes/));
  assert.equal(scope.providerEgress.forwarded, before); assert.deepEqual(guard!.attempts, []);
  // An ordinary tenant's request is forwarded unchanged; only this suite's closed network stops it.
  await assert.rejects(() => scope.liveProviderFetch(base + "/v2/checkout/orders", { method: "POST", headers: { "PayPal-Request-Id": randomUUID() }, body: "{}" }), /JUDGE_EGRESS_BLOCKED/);
  assert.equal(scope.providerEgress.forwarded, before + 1); assert.equal(guard!.attempts.length, 1); guard!.attempts.length = 0;
});

test("reset starts another private demonstration and leaves the earlier one byte-identical", async () => {
  const before = await fingerprint(tenantId), ordinaryBefore = await fingerprint(ordinary.actor.tenantId);
  const next = await director.startDemonstration(started.token, admission);
  assert.notEqual(next.actor.tenantId, tenantId); assert.notEqual(next.token, started.token); assert.equal(next.show.demonstration!.mode, "replay"); assert.equal(next.show.revision, 1); assert.equal(next.show.tickets.length, 0);
  const fresh = await views.judgeView(next.actor, origin); assert.equal(fresh.currentBeatId, "standby"); assert.equal(fresh.tenantId, next.actor.tenantId); assert.equal(await wireRows(next.actor.tenantId), 0);
  assert.deepEqual(await fingerprint(tenantId), before); assert.deepEqual(await fingerprint(ordinary.actor.tenantId), ordinaryBefore);
  assert.deepEqual(await store.getActor(started.token), started.actor); assert.equal((await view()).currentBeatId, null);
  assert.deepEqual((await rehearsals.listRehearsals(next.actor)).items.map(item => item.tenantId).sort(), [tenantId, ordinary.actor.tenantId, next.actor.tenantId].sort());
  // The new demonstration cannot read the earlier one's replayed resources.
  const foreign = (await pool.query<{ order_id: string }>("SELECT order_id FROM on_judge_wire WHERE tenant_id=$1 LIMIT 1", [tenantId])).rows[0]!.order_id;
  await scope.withReplayScope(next.actor.tenantId, async replay => { assert.equal((await replay.wire.fetch("https://api-m.sandbox.paypal.com/v2/checkout/orders/" + foreign)).status, 404); await assert.rejects(() => replay.wire.fetch("https://example.com/v2/checkout/orders/" + foreign), /refuses any address/); });
  assert.deepEqual(guard!.attempts, []);
});

test("the live read of retained evidence is rate limited, redacted, never reads a demonstration and reports unavailable honestly", async () => {
  const verify = await import("../src/server/judge/verify"), { JUDGE_LIVE_READ_LABEL } = await import("../src/domain/judge/contracts");
  // This schema's only verified rows belong to demonstrations, so nothing qualifies and no provider is asked.
  const reads: string[] = []; providers.venue = { read: async (kind: string, id: string) => { reads.push(id); return [{ kind, id, status: "COMPLETED", money: { currency: "USD", minor: 5000 }, parentId: null, customId: null, observedAt: new Date().toISOString(), source: "live_sandbox", links: [] }]; } } as never;
  try {
    const empty = await verify.readRetainedEvidence();
    assert.equal(empty.status, "unavailable"); assert.equal(empty.label, JUDGE_LIVE_READ_LABEL); assert.match(empty.reason!, /no retained original sandbox/); assert.deepEqual(empty.items, []); assert.deepEqual(reads, []);
    const again = await verify.readRetainedEvidence(); assert.equal(again.cached, true); assert.equal(again.readAt, empty.readAt); assert.ok(Date.parse(again.nextReadAfter!) - Date.parse(again.readAt!) >= 599_000);
    await scope.withTenantProviderScope(tenantId, async () => assert.match((await verify.readRetainedEvidence()).reason!, /demonstration step cannot/));
    // A retained ordinary record (controlled stand-in provider here) is read once per window and returned redacted.
    const retainedId = "7KX93041AB556201C", snapshot = await store.getShow(ordinary.actor.tenantId);
    snapshot.financialEvidence.push({ id: "provider:venue:capture:" + retainedId, operationId: randomUUID(), kind: "capture", purpose: "ticket", status: "completed", amountMinor: 5000, currency: "USD", source: "live_sandbox", verified: true, planVersion: 1, providerResourceId: retainedId, parentId: "5O190127TN364715T", ticketId: randomUUID(), recordedAt: "2026-11-01T10:00:00.000Z" });
    await pool.query("UPDATE on_shows SET snapshot=$2 WHERE tenant_id=$1", [ordinary.actor.tenantId, snapshot]);
    await (await import("../src/server/payment-store")).paymentStore();
    const intent = randomUUID(); await pool.query("INSERT INTO on_payment_intents(id,tenant_id,seller,semantic_key,document) VALUES($1,$2,'venue',$3,'{}')", [intent, ordinary.actor.tenantId, "judge-test:" + intent]);
    await pool.query("INSERT INTO on_payment_bindings(seller,kind,provider_id,tenant_id,root_intent_id) VALUES('venue','capture',$1,$2,$3)", [retainedId, ordinary.actor.tenantId, intent]);
    assert.equal((await verify.readRetainedEvidence()).cached, true); assert.deepEqual(reads, []);
    await pool.query("UPDATE on_judge_live_reads SET read_at=read_at-interval '11 minutes'");
    const live = await verify.readRetainedEvidence(), text = JSON.stringify(live);
    assert.equal(live.status, "verified"); assert.equal(live.cached, false); assert.deepEqual(reads, [retainedId]);
    assert.deepEqual(live.items, [{ kind: "capture", reference: "••••56201C", status: "COMPLETED", amountMinor: 5000, currency: "USD", recordedAt: "2026-11-01T10:00:00.000Z", matchesRetainedRecord: true }]);
    assert.ok(!text.includes(retainedId) && !text.includes(ordinary.actor.tenantId) && !text.includes("ONREPLAY") && !text.includes("5O190127TN364715T"));
    assert.equal((await verify.readRetainedEvidence()).cached, true); assert.deepEqual(reads, [retainedId]);
  } finally { providers.venue = actualVenue; }
  assert.deepEqual(guard!.attempts, []);
});
