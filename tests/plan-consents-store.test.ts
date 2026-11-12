import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { digest } from "../src/domain/hash";
import { applyCommand } from "../src/domain/commands";
import { planConsentHarness } from "./plan-consents-harness";

let h: Awaited<ReturnType<typeof planConsentHarness>>;
before(async () => { h = await planConsentHarness(); });
after(async () => { await h?.close(); });
const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === expected);
async function counts(tenantId: string) {
  return (await h.database.pool.query("SELECT (SELECT count(*)::integer FROM on_plan_consent_requests WHERE tenant_id=$1) AS requests,(SELECT count(*)::integer FROM on_plan_consent_decisions WHERE tenant_id=$1) AS decisions,(SELECT count(*)::integer FROM on_plan_consent_commands WHERE tenant_id=$1) AS commands,(SELECT count(*)::integer FROM on_plan_consent_consumptions WHERE tenant_id=$1) AS consumptions", [tenantId])).rows[0];
}

test("real signed quotes and engine require a separate representative before one producer plan approval", async () => {
  const value = await h.production(), original = await h.store.getShow(value.actor.tenantId);
  assert.throws(() => applyCommand(original, value.actor, { type: "approve", candidateId: value.candidate.id, candidateDigest: value.candidate.digest, approvals: value.candidate.approvals.map(item => item.id) }), code("APPROVAL_ROLE_REQUIRED"));
  const invitation = await h.invitation(value);
  assert.equal(await h.store.getActor(invitation.token), null);
  assert.equal(invitation.review.review.provenance, "controlled_declaration");
  assert.equal(invitation.review.review.changes.find(item => item.taskId === "headliner")!.proposed!.minutes, 75);
  assert.equal("actor" in invitation.review, false); assert.equal("offers" in invitation.review, false); assert.equal("resources" in invitation.review, false);
  assert.equal(digest(await h.store.getShow(value.actor.tenantId)), digest(original));
  await assert.rejects(h.service.executeProducerConsent(value.authority, await h.approval(value)), code("PLAN_CONSENT_NOT_APPROVED"));
  const decision = await h.decision(invitation.token), consent = await h.service.executeReviewerConsent(invitation.token, decision);
  assert.equal(consent.receipt.action, "approve"); assert.equal(digest(await h.store.getShow(value.actor.tenantId)), digest(original));
  const approval = await h.approval(value), [first, replay] = await Promise.all([h.service.executeProducerConsent(value.authority, approval), h.service.executeProducerConsent(value.authority, approval)]);
  assert.deepEqual(first.receipt, replay.receipt); assert.deepEqual([first.replayed, replay.replayed].sort(), [false, true]);
  const approved = await h.store.getShow(value.actor.tenantId);
  assert.equal(approved.revision, original.revision + 1); assert.equal(approved.planVersion, original.planVersion + 1);
  assert.deepEqual(approved.approvedPlan!.roles, value.actor.roles);
  assert.equal(approved.approvedPlan!.externalApprovals!.length, 1);
  assert.equal(approved.approvedPlan!.externalApprovals![0]!.receiptDigest, consent.receipt.result.decision!.receiptDigest);
  assert.equal(approved.runs.at(-1)!.candidates.find(item => item.id === value.candidate.id)!.approvals.find(item => item.role === "artist_representative")!.grantedBy, consent.receipt.result.decision!.reviewerId);
  assert.deepEqual(approved.financialEvidence, original.financialEvidence); assert.deepEqual(approved.sheets, original.sheets);
  assert.deepEqual(approved.financialObservations, original.financialObservations); assert.deepEqual(approved.tickets, original.tickets);
  assert.equal(approved.goReportId, null); assert.equal(approved.state, "standby");
  assert.deepEqual(await counts(value.actor.tenantId), { requests: 1, decisions: 1, commands: 3, consumptions: 1 });
  assert.equal((await h.service.consentWorkspace(value.authority)).requests[0]!.state, "committed");
});

test("original invitation and decision receipts recover after changed production without a second mutation", async () => {
  const value = await h.production(), invitation = await h.invitation(value), decision = await h.decision(invitation.token);
  const saved = await h.service.executeReviewerConsent(invitation.token, decision);
  await h.command(value.actor, { type: "advance", time: "17:15" });
  const before = await counts(value.actor.tenantId);
  assert.deepEqual((await h.service.readProducerConsentCommand(value.authority, invitation.request.commandId)).receipt, invitation.result.receipt);
  assert.deepEqual((await h.service.executeProducerConsent(value.authority, invitation.request)).receipt, invitation.result.receipt);
  assert.deepEqual((await h.service.readReviewerConsentCommand(invitation.token, decision.commandId)).receipt, saved.receipt);
  assert.deepEqual((await h.service.executeReviewerConsent(invitation.token, decision)).receipt, saved.receipt);
  assert.equal((await h.service.reviewConsent(invitation.token)).state, "source_changed");
  await assert.rejects(h.service.executeProducerConsent(value.authority, await h.approval(value)), code("PLAN_CONSENT_NOT_FEASIBLE"));
  assert.deepEqual(await counts(value.actor.tenantId), before);
});

test("a decline remains immutable and cannot be converted into an approval or silently reinvited", async () => {
  const value = await h.production(), invitation = await h.invitation(value), decline = await h.decision(invitation.token, "decline");
  await h.service.executeReviewerConsent(invitation.token, decline);
  await assert.rejects(h.service.executeReviewerConsent(invitation.token, { ...decline, decision: "approve" }), code("PLAN_CONSENT_IDEMPOTENCY"));
  await assert.rejects(h.service.executeReviewerConsent(invitation.token, { ...decline, commandId: randomUUID(), decision: "approve" }), code("PLAN_CONSENT_ALREADY_DECIDED"));
  await assert.rejects(h.service.executeProducerConsent(value.authority, await h.approval(value)), code("PLAN_CONSENT_NOT_APPROVED"));
  await assert.rejects(h.service.executeProducerConsent(value.authority, await h.envelope(value, invitation.request.command)), code("PLAN_CONSENT_ALREADY_REQUESTED"));
  assert.equal((await h.service.consentWorkspace(value.authority)).requests[0]!.state, "declined");
  assert.deepEqual(await counts(value.actor.tenantId), { requests: 1, decisions: 1, commands: 2, consumptions: 0 });
});

test("revocation stops unused access and keeps the original immutable history", async () => {
  const value = await h.production(), invitation = await h.invitation(value), decision = await h.decision(invitation.token);
  const stop = await h.envelope(value, { type: "revoke", requestId: invitation.review.review.requestId, reviewDigest: invitation.review.reviewDigest, reason: "The designated representative changed; preserve the original controlled invitation." });
  const result = await h.service.executeProducerConsent(value.authority, stop);
  assert.deepEqual((await h.service.executeProducerConsent(value.authority, stop)).receipt, result.receipt);
  await assert.rejects(h.service.reviewConsent(invitation.token), code("PLAN_CONSENT_REVOKED"));
  await assert.rejects(h.service.executeReviewerConsent(invitation.token, decision), code("PLAN_CONSENT_REVOKED"));
  const workspace = await h.service.consentWorkspace(value.authority); assert.equal(workspace.requests[0]!.state, "revoked"); assert.ok(workspace.requests[0]!.revoked);
  assert.equal((await h.store.getShow(value.actor.tenantId)).revision, value.show.revision);
});

test("a producer token with the same actor and microsecond expiry cannot adopt an original instruction", async () => {
  const value = await h.production(), invitation = await h.invitation(value), token = randomBytes(32).toString("base64url"), hash = h.sessionTokenHash(token);
  await h.database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) SELECT $1,tenant_id,actor,expires_at FROM on_sessions WHERE token_hash=$2", [hash, value.authority.sessionHash]);
  const other = { actor: value.actor, sessionHash: hash };
  await assert.rejects(h.service.executeProducerConsent(other, invitation.request), code("PLAN_CONSENT_ACCESS_CHANGED"));
  await assert.rejects(h.service.readProducerConsentCommand(other, invitation.request.commandId), code("PLAN_CONSENT_COMMAND_OWNER"));
  const workspace = await h.service.consentWorkspace(other); assert.equal(workspace.requests[0]!.ownOriginalAccess, false);
  const old = await h.approval(value);
  await assert.rejects(h.service.executeProducerConsent(other, { ...old, scope: workspace.scope }), code("PLAN_CONSENT_ORIGINAL_ISSUER"));
});

test("an unchanged token cannot adopt a later original expiry or revive its reviewer", async () => {
  const value = await h.production(), invitation = await h.invitation(value), decision = await h.decision(invitation.token);
  await h.database.pool.query("UPDATE on_sessions SET expires_at=expires_at+interval '1 microsecond' WHERE token_hash=$1", [value.authority.sessionHash]);
  await assert.rejects(h.service.executeProducerConsent(value.authority, invitation.request), code("PLAN_CONSENT_ACCESS_CHANGED"));
  await assert.rejects(h.service.executeReviewerConsent(invitation.token, decision), code("PLAN_CONSENT_ACCESS_CHANGED"));
  const changed = (await h.service.consentWorkspace(value.authority)).requests[0]!;
  assert.equal(changed.state, "source_changed"); assert.equal(changed.ownOriginalAccess, false); assert.equal(changed.originalReviewPath, null);
  assert.deepEqual(await counts(value.actor.tenantId), { requests: 1, decisions: 0, commands: 1, consumptions: 0 });
});

test("wrong names, foreign reviews, and same-ID content changes cannot grant a decision", async () => {
  const value = await h.production(), invitation = await h.invitation(value), other = await h.production(), otherInvitation = await h.invitation(other);
  const decision = await h.decision(invitation.token);
  await assert.rejects(h.service.executeReviewerConsent(invitation.token, { ...decision, declaredName: "A different representative" }), code("PLAN_CONSENT_NAME_CHANGED"));
  await assert.rejects(h.service.executeReviewerConsent(otherInvitation.token, decision), code("PLAN_CONSENT_REVIEW_CHANGED"));
  await assert.rejects(h.service.readProducerConsentCommand(other.authority, invitation.request.commandId), code("PLAN_CONSENT_COMMAND_NOT_FOUND"));
  await assert.rejects(h.service.executeProducerConsent(value.authority, { ...invitation.request, command: { ...invitation.request.command, representativeName: "Changed review name" } } as typeof invitation.request), code("PLAN_CONSENT_IDEMPOTENCY"));
  assert.equal((await counts(value.actor.tenantId)).decisions, 0);
});

test("missing current engine proof and a newly changed source block a new reviewer decision", async () => {
  const value = await h.production(), invitation = await h.invitation(value), decision = await h.decision(invitation.token), show = await h.store.getShow(value.actor.tenantId);
  // Explicit negative input corruption, never a positive approval fixture.
  show.runs.at(-1)!.candidates.find(item => item.id === value.candidate.id)!.report.engine = null;
  await h.database.pool.query("UPDATE on_shows SET snapshot=$2 WHERE tenant_id=$1", [show.tenantId, show]);
  await assert.rejects(h.service.executeReviewerConsent(invitation.token, decision), code("PLAN_CONSENT_ENGINE_REQUIRED"));
  assert.equal((await counts(value.actor.tenantId)).decisions, 0);
});

test("every consent evidence table refuses updates and deletes", async () => {
  const value = await h.production(), invitation = await h.invitation(value), decision = await h.decision(invitation.token);
  await h.service.executeReviewerConsent(invitation.token, decision); await h.service.executeProducerConsent(value.authority, await h.approval(value));
  await h.service.executeProducerConsent(value.authority, await h.envelope(value, { type: "revoke", requestId: invitation.review.review.requestId, reviewDigest: invitation.review.reviewDigest, reason: "Close historical review access after its separately committed producer plan." }));
  for (const table of ["on_plan_consent_requests", "on_plan_consent_commands", "on_plan_consent_decisions", "on_plan_consent_revocations", "on_plan_consent_consumptions"]) {
    await assert.rejects(h.database.pool.query(`UPDATE ${table} SET tenant_id=tenant_id WHERE tenant_id=$1`, [value.actor.tenantId]), /Immutable plan consent evidence/);
    await assert.rejects(h.database.pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [value.actor.tenantId]), /Immutable plan consent evidence/);
  }
  assert.equal((await h.service.consentWorkspace(value.authority)).requests[0]!.state, "committed");
});

test("even a still-feasible clock change invalidates an unconsumed exact-revision artist consent", async () => {
  const value = await h.production(), invitation = await h.invitation(value);
  await h.service.executeReviewerConsent(invitation.token, await h.decision(invitation.token));
  await h.command(value.actor, { type: "advance", time: "16:10" });
  const workspace = await h.service.consentWorkspace(value.authority);
  assert.equal(workspace.candidates.find(item => item.candidate.id === value.candidate.id)!.current, true);
  assert.equal(workspace.requests[0]!.state, "source_changed");
  await assert.rejects(h.service.executeProducerConsent(value.authority, await h.approval(value)), code("PLAN_CONSENT_NOT_APPROVED"));
  assert.equal((await h.store.getShow(value.actor.tenantId)).approvedPlan, null);
});

test("two simultaneous reviewer decisions commit one original decision and same-ID replay recovers it", async () => {
  const value = await h.production(), invitation = await h.invitation(value), decision = await h.decision(invitation.token);
  const results = await Promise.all([h.service.executeReviewerConsent(invitation.token, decision), h.service.executeReviewerConsent(invitation.token, decision)]);
  assert.deepEqual(results[0]!.receipt, results[1]!.receipt); assert.deepEqual(results.map(item => item.replayed).sort(), [false, true]);
  await assert.rejects(h.service.executeReviewerConsent(invitation.token, { ...decision, commandId: randomUUID(), decision: "decline" }), code("PLAN_CONSENT_ALREADY_DECIDED"));
  assert.deepEqual(await counts(value.actor.tenantId), { requests: 1, decisions: 1, commands: 2, consumptions: 0 });
});

test("a corrupted proposal digest is refused before any new representative or producer decision", async () => {
  const value = await h.production(), invitation = await h.invitation(value), decision = await h.decision(invitation.token), show = await h.store.getShow(value.actor.tenantId);
  // Invalid input fixture: changing the immutable candidate content without its original digest.
  show.runs.at(-1)!.candidates.find(item => item.id === value.candidate.id)!.cost.rentalMinor++;
  await h.database.pool.query("UPDATE on_shows SET snapshot=$2 WHERE tenant_id=$1", [show.tenantId, show]);
  await assert.rejects(h.service.executeReviewerConsent(invitation.token, decision), code("PLAN_CONSENT_INTEGRITY"));
  assert.equal((await counts(value.actor.tenantId)).decisions, 0);
});

test("an explicitly invalid decision signature is retained as failed evidence and never grants consent", async () => {
  const value = await h.production(), invitation = await h.invitation(value);
  const { sealIntelligence } = await import("../src/server/intelligence/private-payload"), { consentContext } = await import("../src/server/plan-consents/store");
  const request = (await h.database.pool.query("SELECT * FROM on_plan_consent_requests WHERE id=$1", [invitation.review.review.requestId])).rows[0];
  const content = { id: randomUUID(), requestId: request.id, decision: "approve", declaredName: "Forged negative-test declaration", statement: "Explicit invalid-input fixture. This is not positive approval evidence.", reviewDigest: request.review_digest, recordedAt: new Date().toISOString().replace(/Z$/, "000Z"), reviewerId: "plan-review:" + request.id }, decision = { ...content, receiptDigest: digest(content) };
  await h.database.pool.query("INSERT INTO on_plan_consent_decisions(id,tenant_id,request_id,cap_hash,review_digest,decision,decision_cipher,decision_digest,signature,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [decision.id, value.actor.tenantId, request.id, request.cap_hash, request.review_digest, "approve", sealIntelligence(value.actor.tenantId, consentContext(request.id, "decision"), decision), decision.receiptDigest, "0".repeat(64), decision.recordedAt]);
  await assert.rejects(h.service.reviewConsent(invitation.token), code("PLAN_CONSENT_INTEGRITY"));
  await assert.rejects(h.service.consentWorkspace(value.authority), code("PLAN_CONSENT_INTEGRITY"));
  assert.equal((await h.store.getShow(value.actor.tenantId)).approvedPlan, null);
  assert.equal((await counts(value.actor.tenantId)).consumptions, 0);
});
