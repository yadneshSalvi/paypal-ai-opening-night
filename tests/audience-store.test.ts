import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { digest } from "../src/domain/hash";
import { audienceHarness } from "./audience-harness";
const h = await audienceHarness(); after(h.close);

test("controlled installed-SDK capture yields one encrypted fixed original-ticket invite and no producer Actor", async () => {
  const value = await h.fresh(), original = await h.capture(value), before = h.wire.calls.length, show = await h.store.getShow(value.actor.tenantId);
  const link = await h.invite(value, original.ticket.id), read = await h.attendee.readAttendee(link.reader);
  assert.equal(read.receipt.verification, "verified"); assert.equal(read.receipt.admissionMinor, 3500); assert.equal(read.receipt.perkMinor, 1500); assert.equal(read.receipt.grossMinor, 5000); assert.equal(read.inbox.length, 0);
  assert.equal(await h.store.getActor(link.token), null); assert.equal(read.capabilityId, link.capabilityId);
  assert.equal(h.wire.calls.length, before); assert.equal(digest(await h.store.getShow(value.actor.tenantId)), digest(show));
  const row = (await h.database.pool.query("SELECT * FROM on_audience_capabilities WHERE tenant_id=$1 AND id=$2", [value.actor.tenantId, link.capabilityId])).rows[0]!;
  assert.equal(JSON.stringify(row).includes(link.token), false); assert.equal(row.capture_id, original.captureId); assert.equal(row.ticket_id, original.ticket.id);
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_sessions WHERE token_hash=$1", [h.sessionTokenHash(link.token)])).rowCount, 0);
  assert.equal((await h.audience.recoverAudienceInvitation(value.authority, link.capabilityId)).url, link.result.invitation!.url);
  for (const privateValue of [value.actor.id, value.actor.tenantId, value.token, original.root.id, original.orderId, original.captureId, "Brightline", "Priya", "Sam", "policy_rules", "resources"]) assert.equal(JSON.stringify(read).includes(privateValue), false, privateValue);
});

test("lost invite response recovers original secret/expiry after source drift; changed command body conflicts", async () => {
  const value = await h.fresh(), original = await h.capture(value), state = await h.audience.readAudienceWorkspace(value.authority);
  const envelope = { commandId: randomUUID(), expectedRevision: state.revision, sessionFingerprint: state.sessionFingerprint, sessionExpiresAt: state.expiresAt, command: { type: "create_invite" as const, ticketId: original.ticket.id, receiptDigest: state.tickets[0]!.originalDigest, validForMinutes: 60, confirmed: true as const } };
  const first = await h.audience.executeAudienceCommand(value.authority, envelope);
  await h.command(value.actor, { type: "advance", time: "16:10" });
  const recovered = await h.audience.recoverAudienceCommand(value.authority, envelope.commandId), replay = await h.audience.executeAudienceCommand(value.authority, envelope);
  assert.deepEqual(recovered.receipt, first.receipt); assert.deepEqual(recovered.invitation, first.invitation); assert.deepEqual(replay.invitation, first.invitation); assert.equal(replay.replayed, true);
  await assert.rejects(h.audience.executeAudienceCommand(value.authority, { ...envelope, command: { ...envelope.command, validForMinutes: 61 } }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_capabilities WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 1);
});

test("content and recipient snapshots are immutable, unapproved, and approval is a separate current-source decision", async () => {
  const value = await h.fresh(), first = await h.capture(value, "standard"), second = await h.capture(value), a = await h.invite(value, first.ticket.id), b = await h.invite(value, second.ticket.id);
  const draft = await h.draft(value, [a.capabilityId, b.capabilityId]);
  assert.equal(draft.approval, null); assert.equal(draft.deliveries.length, 0); assert.equal(draft.draft.recipients.length, 2);
  assert.deepEqual(draft.draft.recipients.map(item => item.receipt.grossMinor).sort((x, y) => x - y), [3500, 5000]);
  assert.match(draft.draft.recipients.find(item => item.ticketId === second.ticket.id)!.content.body, /VIP soundcheck \$15\.00/);
  assert.equal(draft.draft.recipients.find(item => item.ticketId === first.ticket.id)!.content.body.includes(second.captureId), false);
  const approved = await h.approve(value, draft.draft.id); assert.equal(approved.view.deliveries.length, 0); assert.equal(approved.view.approval?.recipientCount, 2);
  for (const [table, id] of [["on_audience_drafts", draft.draft.id], ["on_audience_approvals", approved.view.approval!.id]]) await assert.rejects(h.database.pool.query(`UPDATE ${table} SET digest='tampered' WHERE tenant_id=$1 AND id=$2`, [value.actor.tenantId, id]), { code: "23000" });
});

test("each bounded pass commits exact per-recipient inbox receipts once under concurrent continuation", async () => {
  const value = await h.fresh(), first = await h.capture(value, "standard"), second = await h.capture(value), a = await h.invite(value, first.ticket.id), b = await h.invite(value, second.ticket.id), draft = await h.draft(value, [a.capabilityId, b.capabilityId]);
  await h.approve(value, draft.draft.id); const reserved = await h.reserve(value, draft.draft.id, 1), pass = reserved.view.passes[0]!;
  assert.equal(reserved.view.deliveries.length, 0); assert.equal(pass.state, "pending");
  const attempts = await Promise.allSettled([h.audience.runAudienceDelivery(value.authority, pass.id, pass.proof, AbortSignal.timeout(15000)), h.audience.runAudienceDelivery(value.authority, pass.id, pass.proof, AbortSignal.timeout(15000))]);
  assert.ok(attempts.some(item => item.status === "fulfilled"));
  const partial = await h.audience.readAudienceMessage(value.authority, draft.draft.id); assert.equal(partial.deliveries.length, 1); assert.equal(partial.passes[0]!.processed, 1); assert.equal(partial.passes[0]!.state, "complete");
  const completed = await h.deliver(value, draft.draft.id, 10); assert.equal(completed.view.deliveries.length, 2);
  for (const link of [a, b]) {
    const reader = await h.attendee.readAttendee(link.reader); assert.equal(reader.inbox.length, 1);
    const original = draft.draft.recipients.find(item => item.capabilityId === link.capabilityId)!;
    assert.equal(reader.inbox[0]!.subject, original.content.subject); assert.equal(reader.inbox[0]!.body, original.content.body); assert.equal(reader.inbox[0]!.contentDigest, original.content.digest); assert.equal(reader.inbox[0]!.sourceIsCurrent, true);
  }
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_deliveries WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 2);
});

test("changed source prevents approval and preserves the original preview without any delivery", async () => {
  const value = await h.fresh(), original = await h.capture(value), link = await h.invite(value, original.ticket.id), draft = await h.draft(value, [link.capabilityId]);
  await h.command(value.actor, { type: "load_incidents" });
  await assert.rejects(h.audienceAct(value.authority, { type: "approve_message", draftId: draft.draft.id, draftDigest: draft.draft.digest, previewDigest: draft.preview.digest, controlledInboxOnly: true, confirmed: true }), { code: "AUDIENCE_PREVIEW_CHANGED" });
  const view = await h.audience.readAudienceMessage(value.authority, draft.draft.id); assert.deepEqual(view.draft, draft.draft); assert.equal(view.preview.ready, false); assert.equal(view.deliveries.length, 0);
  const read = await h.attendee.readAttendee(link.reader); assert.equal(read.event.scheduleStatus, "under_review"); assert.equal(read.event.admission, "suspended"); assert.match(read.event.notice, /last published times/);
});

test("stop preserves one completed inbox and interrupts a retained pass without sending the residual", async () => {
  const value = await h.fresh(), one = await h.capture(value), two = await h.capture(value), a = await h.invite(value, one.ticket.id), b = await h.invite(value, two.ticket.id), draft = await h.draft(value, [a.capabilityId, b.capabilityId]);
  const approved = await h.approve(value, draft.draft.id); const partial = await h.deliver(value, draft.draft.id, 1); const reserved = await h.reserve(value, draft.draft.id, 1);
  await h.audienceAct(value.authority, { type: "stop_message", approvalId: approved.view.approval!.id, approvalDigest: approved.view.approval!.digest, detail: "Stop remaining controlled inboxes while the producer reviews the event.", confirmed: true });
  const stopped = await h.audience.readAudienceMessage(value.authority, draft.draft.id); assert.equal(stopped.deliveries.length, 1); assert.deepEqual(stopped.deliveries[0], partial.view.deliveries[0]); assert.ok(stopped.stoppedAt); assert.equal(stopped.passes.find(item => item.id === reserved.saved.receipt.recordId)!.errorCode, "AUDIENCE_DELIVERY_STOPPED");
  await assert.rejects(h.audienceAct(value.authority, { type: "deliver_message", approvalId: approved.view.approval!.id, approvalDigest: approved.view.approval!.digest, limit: 1, confirmed: true }), { code: "AUDIENCE_DELIVERY_NOT_CURRENT" });
});

test("revocation fails closed for private reads and invite recovery while retaining immutable delivery history", async () => {
  const value = await h.fresh(), original = await h.capture(value), link = await h.invite(value, original.ticket.id), draft = await h.draft(value, [link.capabilityId]);
  await h.approve(value, draft.draft.id); const completed = await h.deliver(value, draft.draft.id), savedReceipt = completed.view.deliveries[0]!;
  await h.audienceAct(value.authority, { type: "revoke_invite", capabilityId: link.capabilityId, confirmed: true });
  await assert.rejects(h.attendee.readAttendee(link.reader), { code: "ATTENDEE_ACCESS_ENDED" });
  await assert.rejects(h.audience.recoverAudienceInvitation(value.authority, link.capabilityId), { code: "AUDIENCE_INVITATION_ENDED" });
  const retained = await h.audience.readAudienceMessage(value.authority, draft.draft.id); assert.deepEqual(retained.deliveries[0], savedReceipt);
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_deliveries WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 1);
});

test("real fixed expiry is bounded by its issuing session and never renewed by reads or recovery", async () => {
  const value = await h.fresh(), original = await h.capture(value);
  await h.database.pool.query("UPDATE on_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=$1", [value.authority.sessionHash]);
  const link = await h.invite(value, original.ticket.id), expiry = link.result.invitation!.expiresAt;
  assert.ok(Date.parse(expiry) - Date.now() < 2100); assert.equal((await h.attendee.readAttendee(link.reader)).expiresAt, expiry);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expiry) - Date.now() + 30)));
  await assert.rejects(h.attendee.readAttendee(link.reader), { code: "ATTENDEE_ACCESS_ENDED" });
  const row = (await h.database.pool.query("SELECT expires_at FROM on_audience_capabilities WHERE tenant_id=$1 AND id=$2", [value.actor.tenantId, link.capabilityId])).rows[0]!;
  assert.equal(row.expires_at.toISOString(), expiry);
});

test("narrowing the original issuer expiry invalidates an invite even while the changed session is still future-dated", async () => {
  const value = await h.fresh(), original = await h.capture(value), link = await h.invite(value, original.ticket.id);
  await h.database.pool.query("UPDATE on_sessions SET expires_at=expires_at-interval '1 second' WHERE token_hash=$1", [value.authority.sessionHash]);
  await assert.rejects(h.attendee.readAttendee(link.reader), { code: "ATTENDEE_ACCESS_ENDED" });
  await assert.rejects(h.audience.recoverAudienceInvitation(value.authority, link.capabilityId), { code: "AUDIENCE_ORIGINAL_SESSION_REQUIRED" });
});

test("an instruction never received before a fixed-expiry change cannot adopt the altered same-token authority", async () => {
  const value = await h.fresh(), original = await h.capture(value);
  await h.database.pool.query("UPDATE on_sessions SET expires_at=date_trunc('milliseconds',expires_at)-interval '100 microseconds' WHERE token_hash=$1", [value.authority.sessionHash]);
  const state = await h.audience.readAudienceWorkspace(value.authority);
  const envelope = { commandId: randomUUID(), expectedRevision: state.revision, sessionFingerprint: state.sessionFingerprint, sessionExpiresAt: state.expiresAt, command: { type: "create_invite" as const, ticketId: original.ticket.id, receiptDigest: state.tickets[0]!.originalDigest, validForMinutes: 60, confirmed: true as const } };
  await assert.rejects(h.audience.recoverAudienceCommand(value.authority, envelope.commandId), { code: "AUDIENCE_RECEIPT_NOT_FOUND" });
  // Narrow authority by one microsecond: a JS millisecond comparison would miss this change.
  await h.database.pool.query("UPDATE on_sessions SET expires_at=expires_at-interval '1 microsecond' WHERE token_hash=$1", [value.authority.sessionHash]);
  const changed = await h.audience.readAudienceWorkspace(value.authority);
  assert.notEqual(changed.expiresAt, state.expiresAt); assert.equal(Date.parse(changed.expiresAt), Date.parse(state.expiresAt));
  await assert.rejects(h.audience.executeAudienceCommand(value.authority, envelope), { code: "AUDIENCE_ORIGINAL_SESSION_REQUIRED" });
  await assert.rejects(h.audience.recoverAudienceCommand(value.authority, envelope.commandId), { code: "AUDIENCE_RECEIPT_NOT_FOUND" });
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_capabilities WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 0);
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_commands WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 0);
});

test("an unreceived instruction cannot adopt a distinct token with the same actor and identical fixed expiry", async () => {
  const value = await h.fresh(), original = await h.capture(value), state = await h.audience.readAudienceWorkspace(value.authority), sibling = await h.sibling(value), other = await h.audience.readAudienceWorkspace(sibling.authority);
  assert.equal(state.actorId, other.actorId); assert.equal(state.expiresAt, other.expiresAt); assert.notEqual(state.sessionFingerprint, other.sessionFingerprint);
  const envelope = { commandId: randomUUID(), expectedRevision: state.revision, sessionFingerprint: state.sessionFingerprint, sessionExpiresAt: state.expiresAt, command: { type: "create_invite" as const, ticketId: original.ticket.id, receiptDigest: state.tickets[0]!.originalDigest, validForMinutes: 60, confirmed: true as const } };
  await assert.rejects(h.audience.executeAudienceCommand(sibling.authority, envelope), { code: "AUDIENCE_ORIGINAL_SESSION_REQUIRED" });
  await assert.rejects(h.audience.recoverAudienceCommand(value.authority, envelope.commandId), { code: "AUDIENCE_RECEIPT_NOT_FOUND" });
  await assert.rejects(h.audience.recoverAudienceCommand(sibling.authority, envelope.commandId), { code: "AUDIENCE_RECEIPT_NOT_FOUND" });
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_commands WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 0); assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_capabilities WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 0);
});

test("authority is rechecked after waiting for the real source lock, with no accepted invitation after revocation", async () => {
  const value = await h.fresh(), original = await h.capture(value), state = await h.audience.readAudienceWorkspace(value.authority), lock = await h.database.pool.connect();
  await lock.query("BEGIN"); await lock.query("SELECT 1 FROM on_shows WHERE tenant_id=$1 FOR UPDATE", [value.actor.tenantId]);
  const pending = h.audience.executeAudienceCommand(value.authority, { commandId: randomUUID(), expectedRevision: state.revision, sessionFingerprint: state.sessionFingerprint, sessionExpiresAt: state.expiresAt, command: { type: "create_invite", ticketId: original.ticket.id, receiptDigest: state.tickets[0]!.originalDigest, validForMinutes: 60, confirmed: true } });
  const rejected = assert.rejects(pending, { code: "AUDIENCE_SESSION_ENDED" });
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    await h.database.pool.query("UPDATE on_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [value.authority.sessionHash]);
  } finally { await lock.query("ROLLBACK"); lock.release(); }
  await rejected; assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_capabilities WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 0);
});

test("a current adverse capture observation preserves the original receipt but withdraws admission and new invite eligibility", async () => {
  const value = await h.fresh(), original = await h.capture(value), link = await h.invite(value, original.ticket.id), before = await h.attendee.readAttendee(link.reader);
  h.wire.orders.get(original.orderId)!.purchase_units[0].payments.captures[0].status = "DENIED";
  const { observeOwnedPayment } = await import("../src/server/payment-observations"); await observeOwnedPayment(original.root, h.wire.provider(), AbortSignal.timeout(10000));
  const read = await h.attendee.readAttendee(link.reader); assert.equal(read.receipt.originalDigest, before.receipt.originalDigest); assert.equal(read.receipt.grossMinor, 5000); assert.equal(read.receipt.verification, "unknown"); assert.equal(read.receipt.admission, "unverified");
  await assert.rejects(h.audienceAct(value.authority, { type: "create_invite", ticketId: original.ticket.id, receiptDigest: read.receipt.originalDigest, validForMinutes: 60, confirmed: true }), { code: "AUDIENCE_ORIGINAL_CAPTURE_REQUIRED" });
});

test("stale source interrupts remaining work, keeps the exact first body, and labels that inbox record historical", async () => {
  const value = await h.fresh(), first = await h.capture(value), second = await h.capture(value), a = await h.invite(value, first.ticket.id), b = await h.invite(value, second.ticket.id), draft = await h.draft(value, [a.capabilityId, b.capabilityId]);
  await h.approve(value, draft.draft.id); const partial = await h.deliver(value, draft.draft.id, 1), reserved = await h.reserve(value, draft.draft.id, 1);
  await h.command(value.actor, { type: "load_incidents" });
  const changed = await h.audience.readAudienceMessage(value.authority, draft.draft.id), pending = changed.passes.find(item => item.id === reserved.saved.receipt.recordId)!;
  await assert.rejects(h.audience.runAudienceDelivery(value.authority, pending.id, pending.proof, AbortSignal.timeout(10000)), { code: "AUDIENCE_DELIVERY_SOURCE_ENDED" });
  const after = await h.audience.readAudienceMessage(value.authority, draft.draft.id); assert.equal(after.deliveries.length, 1); assert.deepEqual(after.deliveries[0], partial.view.deliveries[0]); assert.equal(after.passes.find(item => item.id === pending.id)!.state, "interrupted");
  const recipient = after.deliveries[0]!.capabilityId === a.capabilityId ? a : b, inbox = await h.attendee.readAttendee(recipient.reader); assert.equal(inbox.inbox[0]!.sourceIsCurrent, false); assert.equal(inbox.inbox[0]!.body, after.deliveries[0]!.body); assert.equal(inbox.event.scheduleStatus, "under_review");
});

test("foreign production and crew access cannot recover original audience content or mutate its command identity", async () => {
  const value = await h.fresh(), foreign = await h.fresh(), original = await h.capture(value), link = await h.invite(value, original.ticket.id), draft = await h.draft(value, [link.capabilityId]);
  await assert.rejects(h.audience.readAudienceMessage(foreign.authority, draft.draft.id), { code: "AUDIENCE_DRAFT_NOT_FOUND" });
  await assert.rejects(h.audience.recoverAudienceCommand(foreign.authority, link.result.receipt.commandId), { code: "AUDIENCE_RECEIPT_NOT_FOUND" });
  const crewToken = await h.store.createCrewCapability(value.actor, "priya"), crew = (await h.store.getActor(crewToken))!;
  await assert.rejects(h.audience.readAudienceWorkspace({ actor: crew, sessionHash: h.sessionTokenHash(crewToken) }), { code: "AUDIENCE_PRODUCER_REQUIRED" });
  assert.equal((await h.attendeeRoute.GET(h.request(value.token, "/api/attendee"))).status, 401);
  assert.equal((await h.route.GET(h.request(link.token))).status, 401);
});

test("same command key/body converges under concurrent import and a changed body cannot replace its original outcome", async () => {
  const value = await h.fresh(), original = await h.capture(value), state = await h.audience.readAudienceWorkspace(value.authority);
  const envelope = { commandId: randomUUID(), expectedRevision: state.revision, sessionFingerprint: state.sessionFingerprint, sessionExpiresAt: state.expiresAt, command: { type: "create_invite" as const, ticketId: original.ticket.id, receiptDigest: state.tickets[0]!.originalDigest, validForMinutes: 60, confirmed: true as const } };
  const responses = await Promise.all([h.audience.executeAudienceCommand(value.authority, envelope), h.audience.executeAudienceCommand(value.authority, envelope)]);
  assert.deepEqual(responses[0]!.invitation, responses[1]!.invitation); assert.equal(responses.filter(item => item.replayed).length, 1);
  const conflict = await Promise.allSettled([h.audience.executeAudienceCommand(value.authority, envelope), h.audience.executeAudienceCommand(value.authority, { ...envelope, command: { ...envelope.command, validForMinutes: 90 } })]);
  assert.equal(conflict[0]!.status, "fulfilled"); assert.equal(conflict[1]!.status, "rejected"); if (conflict[1]!.status === "rejected") assert.equal(conflict[1]!.reason.code, "IDEMPOTENCY_CONFLICT");
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_capabilities WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 1);
});

test("reserved/sample rows and a directly fabricated verified flag do not prove original owned capture attribution", async () => {
  const value = await h.fresh(), ticketId = randomUUID(), captureId = "INVALID-SUPPLIED-CAPTURE";
  // Explicit adversarial input only. No positive fixture or provider outcome is fabricated.
  await h.database.pool.query("UPDATE on_shows SET snapshot=jsonb_set(jsonb_set(snapshot,'{tickets}',$2::jsonb),'{financialEvidence}',$3::jsonb) WHERE tenant_id=$1", [value.actor.tenantId, JSON.stringify([{ id: ticketId, tier: "vip", admissionMinor: 3500, perkMinor: 1500, captureId, source: "live_sandbox", refundedMinor: 0, status: "captured" }]), JSON.stringify([{ id: "invalid-input", operationId: randomUUID(), kind: "capture", purpose: "ticket", status: "completed", amountMinor: 5000, currency: "USD", source: "live_sandbox", verified: true, planVersion: 1, providerResourceId: captureId, parentId: "INVALID-ORDER", ticketId, recordedAt: new Date().toISOString() }])]);
  const state = await h.audience.readAudienceWorkspace(value.authority); assert.equal(state.tickets[0]!.verification, "unpaid"); assert.equal(state.tickets[0]!.admission, "unverified");
  await assert.rejects(h.audienceAct(value.authority, { type: "create_invite", ticketId, receiptDigest: state.tickets[0]!.originalDigest, validForMinutes: 60, confirmed: true }), { code: "AUDIENCE_ORIGINAL_CAPTURE_REQUIRED" });
});

test("the maximum ten-recipient pass leaves the eleventh pending and a completed pass cannot dispatch it on replay", async () => {
  const value = await h.fresh(), links = [];
  for (let index = 0; index < 11; index++) { const original = await h.capture(value, index % 2 ? "standard" : "vip"); links.push(await h.invite(value, original.ticket.id)); }
  const draft = await h.draft(value, links.map(link => link.capabilityId)); await h.approve(value, draft.draft.id);
  const partial = await h.deliver(value, draft.draft.id, 10); assert.equal(partial.view.deliveries.length, 10); assert.equal(partial.view.passes[0]!.processed, 10); assert.equal(partial.view.passes[0]!.state, "complete");
  await h.audience.runAudienceDelivery(value.authority, partial.view.passes[0]!.id, partial.view.passes[0]!.proof, AbortSignal.timeout(15000));
  assert.equal((await h.audience.readAudienceMessage(value.authority, draft.draft.id)).deliveries.length, 10);
  const complete = await h.deliver(value, draft.draft.id, 1); assert.equal(complete.view.deliveries.length, 11); assert.equal(new Set(complete.view.deliveries.map(item => item.capabilityId)).size, 11);
  for (const link of links) { const read = await h.attendee.readAttendee(link.reader); assert.equal(read.inbox.length, 1); assert.equal(read.inbox[0]!.ticketId, read.receipt.ticketId); }
});
