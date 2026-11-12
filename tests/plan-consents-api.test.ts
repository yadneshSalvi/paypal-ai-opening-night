import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { planConsentHarness } from "./plan-consents-harness";

let h: Awaited<ReturnType<typeof planConsentHarness>>;
let producer: typeof import("../src/app/api/plan-approvals/route"), reviewer: typeof import("../src/app/api/plan-approvals/review/route"), show: typeof import("../src/app/api/show/route");
const origin = "http://127.0.0.1:4607";
before(async () => { h = await planConsentHarness(); producer = await import("../src/app/api/plan-approvals/route"); reviewer = await import("../src/app/api/plan-approvals/review/route"); show = await import("../src/app/api/show/route"); });
after(async () => { await h?.close(); });
const request = (path: string, token: string, body?: unknown, extra: Record<string, string> = {}) => new Request(origin + path, { method: body === undefined ? "GET" : "POST", headers: { Origin: origin, Authorization: "Bearer " + token, "Content-Type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("dedicated routes reject wrong origins, query capabilities, unknown fields and oversize bodies", async () => {
  const value = await h.production(), invitation = await h.invitation(value), decision = await h.decision(invitation.token);
  const missing = await producer.GET(request("/api/plan-approvals", "invalid")); assert.equal(missing.status, 401);
  const invalidToken = await reviewer.GET(request("/api/plan-approvals/review", value.token)); assert.equal(invalidToken.status, 404);
  assert.equal((await reviewer.GET(request("/api/plan-approvals/review?token=" + invitation.token, invitation.token))).status, 400);
  assert.equal((await reviewer.POST(request("/api/plan-approvals/review", invitation.token, decision, { Origin: "http://localhost:4607" }))).status, 403);
  assert.equal((await reviewer.POST(request("/api/plan-approvals/review", invitation.token, decision, { Origin: "null" }))).status, 403);
  const injected = await reviewer.POST(request("/api/plan-approvals/review", invitation.token, { ...decision, roles: ["producer"], hidden: "never-echo-this-marker" }));
  assert.equal(injected.status, 400); assert.doesNotMatch(await injected.text(), /never-echo-this-marker/);
  assert.equal((await reviewer.POST(request("/api/plan-approvals/review", invitation.token, { ...decision, padding: "x".repeat(31000) }))).status, 413);
  assert.equal((await h.database.pool.query("SELECT count(*)::integer AS count FROM on_plan_consent_decisions")).rows[0].count, 0);
});

test("a reviewer capability exposes only its safe review and never becomes production authority", async () => {
  const value = await h.production(), invitation = await h.invitation(value);
  const response = await reviewer.GET(request("/api/plan-approvals/review", invitation.token, undefined, { Cookie: "opening-night-ai-qa-session=" + value.token }));
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /no-store/); assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const data = await response.json();
  assert.doesNotMatch(JSON.stringify(data), /issuer_session_hash|cap_cipher|sessionFingerprint|ownOriginalAccess|originalReviewPath|financialEvidence|commercialCapMinor|tenantId|actorRoles/);
  assert.equal(data.review.requestId, invitation.review.review.requestId);
  assert.equal((await producer.GET(request("/api/plan-approvals", invitation.token))).status, 401);
  assert.equal((await show.GET(request("/api/show", invitation.token))).status, 401);
  const crewToken = await h.store.createCrewCapability(value.actor, "sam");
  assert.equal((await producer.GET(request("/api/plan-approvals", crewToken))).status, 403);
  assert.equal((await reviewer.GET(request("/api/plan-approvals/review", crewToken))).status, 404);
});

test("saved separate consent cannot be injected through ordinary approval or silently borrowed by the producer", async () => {
  const value = await h.production(), invitation = await h.invitation(value), decision = await h.decision(invitation.token);
  const saved = await reviewer.POST(request("/api/plan-approvals/review", invitation.token, decision)); assert.equal(saved.status, 200);
  const original = await saved.json(), recovered = await reviewer.GET(request("/api/plan-approvals/review?commandId=" + decision.commandId, invitation.token));
  assert.deepEqual((await recovered.json()).receipt, original.receipt);
  const ordinary = { idempotencyKey: randomUUID(), expectedRevision: value.show.revision, command: { type: "approve", candidateId: value.candidate.id, candidateDigest: value.candidate.digest, approvals: value.candidate.approvals.map(item => item.id) } };
  assert.equal((await show.POST(request("/api/show", value.token, ordinary))).status, 403);
  assert.equal((await show.POST(request("/api/show", value.token, { ...ordinary, command: { ...ordinary.command, verifiedConsents: [original.receipt.result.decision] } }))).status, 400);
  const approval = await h.approval(value), committed = await producer.POST(request("/api/plan-approvals", value.token, approval));
  assert.equal(committed.status, 200); const record = await committed.json();
  assert.deepEqual((await (await producer.GET(request("/api/plan-approvals?commandId=" + approval.commandId, value.token))).json()).receipt, record.receipt);
  assert.deepEqual((await h.store.getShow(value.actor.tenantId)).approvedPlan!.roles, value.actor.roles);
});

test("receipt GET waits behind an in-flight consent transaction before reporting absence", async () => {
  const value = await h.production(), invitation = await h.invitation(value), decision = await h.decision(invitation.token), lock = await h.database.pool.connect();
  let read: Promise<Response> | undefined, resolved = false;
  try {
    await lock.query("BEGIN"); await lock.query("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR UPDATE", [value.actor.tenantId]);
    read = reviewer.GET(request("/api/plan-approvals/review?commandId=" + decision.commandId, invitation.token)).then(response => { resolved = true; return response; });
    let waiting = false;
    for (let i = 0; i < 80; i++) {
      waiting = Boolean((await h.database.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND state='active' AND query LIKE 'SELECT snapshot FROM on_shows WHERE tenant_id=%FOR UPDATE'")).rowCount);
      if (waiting) break; await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true); assert.equal(resolved, false); await lock.query("COMMIT");
    const response = await read; assert.equal(response.status, 404); assert.equal((await response.json()).code, "PLAN_CONSENT_COMMAND_NOT_FOUND");
  } finally { await lock.query("ROLLBACK"); lock.release(); if (read) await read; }
});

test("original expiry is rechecked after a transaction wait before any invitation is saved", async () => {
  const value = await h.production(), current = await h.service.consentWorkspace(value.authority), lock = await h.database.pool.connect();
  const envelope = await h.envelope(value, { type: "invite", candidateId: value.candidate.id, candidateDigest: value.candidate.digest, requirementId: "artist-set", representativeName: "Controlled Artist Representative", representationBasis: "Controlled test designation only, no real human authority claimed.", sourceId: value.candidate.patch.tasks.find(task => task.id === "headliner")!.sourceId, validityMinutes: 15, sourceReviewed: true, invitationReviewed: true });
  let running: Promise<Response> | undefined;
  try {
    await lock.query("BEGIN"); await lock.query("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR UPDATE", [value.actor.tenantId]);
    running = producer.POST(request("/api/plan-approvals", value.token, envelope));
    let waiting = false;
    for (let i = 0; i < 80; i++) { waiting = Boolean((await h.database.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND state='active' AND query LIKE 'SELECT snapshot FROM on_shows WHERE tenant_id=%FOR UPDATE'")).rowCount); if (waiting) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(waiting, true);
    await h.database.pool.query("UPDATE on_sessions SET expires_at=expires_at+interval '1 microsecond' WHERE token_hash=$1", [value.authority.sessionHash]); await lock.query("COMMIT");
    const response = await running; assert.equal(response.status, 401); assert.equal((await response.json()).code, "PLAN_CONSENT_ACCESS_CHANGED");
    assert.equal((await h.service.consentWorkspace(value.authority)).requests.length, 0); assert.equal((await h.store.getShow(value.actor.tenantId)).revision, current.revision);
  } finally { await lock.query("ROLLBACK"); lock.release(); if (running) await running; }
});
