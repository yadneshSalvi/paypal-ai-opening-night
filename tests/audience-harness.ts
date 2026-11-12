/** Fresh controlled commerce through the installed SDK fetch seam. No actual provider or physical proof. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { AudienceCommand, AudienceEnvelope } from "../src/domain/audience/contracts";
import { rentalHarness } from "./rental-closeout-harness";

export async function audienceHarness(options: Pick<NonNullable<Parameters<typeof rentalHarness>[0]>, "database" | "onStep"> = {}) {
  const h = await rentalHarness({ ...options, realEngine: true, appOrigin: "http://127.0.0.1:4594" });
  const audience = await import("../src/server/audience/service"), attendee = await import("../src/server/audience/attendee"), audienceStore = await import("../src/server/audience/store");
  const route = await import("../src/app/api/audience/route"), commandRoute = await import("../src/app/api/audience/commands/route"), commandRead = await import("../src/app/api/audience/commands/[id]/route"), attendeeRoute = await import("../src/app/api/attendee/route");
  const messageRoute = await import("../src/app/api/audience/messages/[id]/route"), workRoute = await import("../src/app/api/audience/work/route"), invitationRoute = await import("../src/app/api/audience/invites/[id]/route");
  async function fresh() {
    const session = await h.store.createSession(undefined, "audience-controlled:" + randomUUID());
    return { ...session, authority: { actor: session.actor, sessionHash: h.sessionTokenHash(session.token) } };
  }
  async function sibling(value: Awaited<ReturnType<typeof fresh>>) {
    // An explicit fresh test capability with the same actor and exact original expiry.
    // This never extends, renews or replaces the original capability.
    const token = randomBytes(32).toString("base64url"), sessionHash = h.sessionTokenHash(token);
    const created = await h.database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) SELECT $1,tenant_id,actor,expires_at FROM on_sessions WHERE token_hash=$2 AND expires_at>clock_timestamp()", [sessionHash, value.authority.sessionHash]);
    assert.equal(created.rowCount, 1); assert.deepEqual(await h.store.getActor(token), value.actor);
    return { ...value, token, authority: { actor: value.actor, sessionHash } };
  }
  async function capture(value: Awaited<ReturnType<typeof fresh>>, tier: "standard" | "vip" = "vip") {
    const show = await h.store.getShow(value.actor.tenantId), ticketId = randomUUID();
    const checkout = await h.paymentService.handlePayment(value.actor, { type: "ticket_checkout", expectedRevision: show.revision, ticketId, tier }, "http://127.0.0.1:4594");
    const root = await h.payments.readIntent(value.actor.tenantId, checkout.command.intentId), resources = await h.payments.ownedResources(value.actor.tenantId, "venue", root.id), orderId = resources.find(item => item.kind === "order")!.id;
    h.wire.orders.get(orderId)!.status = "APPROVED"; // Explicit synthetic payer fixture, never a real buyer action.
    const captured = await h.paymentService.handlePayment(value.actor, { type: "complete_checkout", intentId: root.id, state: h.paymentService.callbackState(root) }, "http://127.0.0.1:4594");
    assert.equal(captured.status, "succeeded");
    const ticket = (await h.store.getShow(value.actor.tenantId)).tickets.find(item => item.id === ticketId)!;
    assert.ok(ticket.captureId); assert.ok(h.wire.calls.filter(call => call.method === "POST").every(call => call.durable));
    return { ticket, root, orderId, captureId: ticket.captureId! };
  }
  async function act(authority: Parameters<typeof audience.executeAudienceCommand>[0], command: AudienceCommand, envelope?: AudienceEnvelope) {
    const workspace = await audience.readAudienceWorkspace(authority);
    return audience.executeAudienceCommand(authority, envelope ?? { commandId: randomUUID(), expectedRevision: workspace.revision, sessionFingerprint: workspace.sessionFingerprint, sessionExpiresAt: workspace.expiresAt, command });
  }
  async function invite(value: Awaited<ReturnType<typeof fresh>>, ticketId: string) {
    const workspace = await audience.readAudienceWorkspace(value.authority), receipt = workspace.tickets.find(item => item.ticketId === ticketId)!;
    const result = await act(value.authority, { type: "create_invite", ticketId, receiptDigest: receipt.originalDigest, validForMinutes: 60, confirmed: true });
    assert.ok(result.invitation); const token = result.invitation.url.split("#")[1]!;
    const reader = await attendee.requireAttendeeReader(new Request("http://127.0.0.1:4594/api/attendee", { headers: { authorization: "Bearer " + token } }));
    return { result, token, reader, capabilityId: result.invitation.capabilityId };
  }
  async function draft(value: Awaited<ReturnType<typeof fresh>>, ids: string[], kind: "event_update" | "vip_remedy" = "event_update", note = "Controlled producer update. No actual external outreach or physical show is claimed.") {
    const state = await audience.readAudienceWorkspace(value.authority);
    const saved = await act(value.authority, { type: "draft_message", recipientIds: ids, kind, sourceDigest: state.sourceDigest, templateVersion: "audience-v1", note, validForMinutes: 15 });
    return audience.readAudienceMessage(value.authority, saved.receipt.recordId);
  }
  async function approve(value: Awaited<ReturnType<typeof fresh>>, draftId: string) {
    const view = await audience.readAudienceMessage(value.authority, draftId);
    assert.equal(view.preview.ready, true, view.preview.blockers.join("; "));
    const saved = await act(value.authority, { type: "approve_message", draftId, draftDigest: view.draft.digest, previewDigest: view.preview.digest, controlledInboxOnly: true, confirmed: true });
    return { saved, view: await audience.readAudienceMessage(value.authority, draftId) };
  }
  async function reserve(value: Awaited<ReturnType<typeof fresh>>, draftId: string, limit = 10) {
    const view = await audience.readAudienceMessage(value.authority, draftId); assert.ok(view.approval);
    const saved = await act(value.authority, { type: "deliver_message", approvalId: view.approval.id, approvalDigest: view.approval.digest, limit, confirmed: true });
    return { saved, view: await audience.readAudienceMessage(value.authority, draftId) };
  }
  async function deliver(value: Awaited<ReturnType<typeof fresh>>, draftId: string, limit = 10) {
    const reserved = await reserve(value, draftId, limit), pass = reserved.view.passes.find(item => item.id === reserved.saved.receipt.recordId)!;
    const saved = await audience.runAudienceDelivery(value.authority, pass.id, pass.proof, AbortSignal.timeout(15000));
    return { saved, view: await audience.readAudienceMessage(value.authority, draftId) };
  }
  function request(token: string | null, path = "/api/audience", body?: unknown, headers: HeadersInit = {}) {
    return new Request("http://127.0.0.1:4594" + path, { method: body === undefined ? "GET" : "POST", headers: { ...(token ? { authorization: "Bearer " + token } : {}), origin: "http://127.0.0.1:4594", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  return { ...h, audience, attendee, audienceStore, route, commandRoute, commandRead, attendeeRoute, messageRoute, workRoute, invitationRoute, fresh, sibling, capture, audienceAct: act, invite, draft, approve, reserve, deliver, request };
}
