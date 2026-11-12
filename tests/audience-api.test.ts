/** Actual route handlers and loopback HTTP with fresh owned PostgreSQL. No actual provider traffic. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { audienceHarness } from "./audience-harness";
const h = await audienceHarness(); after(h.close);

test("private attendee reads require their dedicated bearer and cannot use cookies, query IDs, producer or crew access", async () => {
  const value = await h.fresh(), ticket = await h.capture(value), link = await h.invite(value, ticket.ticket.id), before = h.wire.calls.length;
  const allowed = await h.attendeeRoute.GET(h.request(link.token, "/api/attendee")); assert.equal(allowed.status, 200); assert.equal(allowed.headers.get("cache-control"), "private, no-store"); assert.equal(allowed.headers.get("referrer-policy"), "no-referrer"); assert.equal((await allowed.json()).receipt.ticketId, ticket.ticket.id);
  for (const headers of [{ cookie: "opening-night-audience-4594-session=" + value.token }, { authorization: "Bearer " + value.token }, { authorization: "Basic " + link.token }, { authorization: "Bearer " + "att_" + "a".repeat(43) }]) assert.equal((await h.attendeeRoute.GET(new Request("http://127.0.0.1:4594/api/attendee", { headers }))).status, 401);
  assert.equal((await h.attendeeRoute.GET(h.request(link.token, "/api/attendee?ticketId=" + randomUUID()))).status, 400);
  assert.equal((await h.attendeeRoute.GET(h.request(link.token, "/api/attendee?before=" + randomUUID()))).status, 404); assert.equal(h.wire.calls.length, before);
});

test("producer routes deny foreign scope and reader capabilities before an audience mutation", async () => {
  const value = await h.fresh(), ticket = await h.capture(value), link = await h.invite(value, ticket.ticket.id), state = await h.audience.readAudienceWorkspace(value.authority), before = h.wire.calls.length;
  const command = { commandId: randomUUID(), expectedRevision: state.revision, sessionFingerprint: state.sessionFingerprint, sessionExpiresAt: state.expiresAt, command: { type: "create_invite", ticketId: ticket.ticket.id, receiptDigest: state.tickets[0]!.originalDigest, validForMinutes: 60, confirmed: true } };
  assert.equal((await h.commandRoute.POST(h.request(link.token, "/api/audience/commands", command))).status, 401);
  assert.equal((await h.commandRoute.POST(h.request(value.token, "/api/audience/commands", command, { "x-opening-night-production": randomUUID() }))).status, 409);
  assert.equal((await h.commandRoute.POST(h.request(value.token, "/api/audience/commands", command, { origin: "http://localhost:4594" }))).status, 403);
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_capabilities WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 1); assert.equal(h.wire.calls.length, before);
});

test("malformed, extra, oversized and unconfirmed commands are rejected without new authority or inbox rows", async () => {
  const value = await h.fresh(), ticket = await h.capture(value), state = await h.audience.readAudienceWorkspace(value.authority), command = { commandId: randomUUID(), expectedRevision: state.revision, sessionFingerprint: state.sessionFingerprint, sessionExpiresAt: state.expiresAt, command: { type: "create_invite", ticketId: ticket.ticket.id, receiptDigest: state.tickets[0]!.originalDigest, validForMinutes: 60, confirmed: true } };
  const cases: [unknown, number][] = [[{ ...command, actor: value.actor }, 400], [{ ...command, command: { ...command.command, confirmed: false } }, 400], [{ ...command, command: { ...command.command, captureId: "FORGED" } }, 400], [{ ...command, padding: "x".repeat(30001) }, 413]];
  for (const [body, status] of cases) assert.equal((await h.commandRoute.POST(h.request(value.token, "/api/audience/commands", body))).status, status);
  const invalid = new Request("http://127.0.0.1:4594/api/audience/commands", { method: "POST", headers: { authorization: "Bearer " + value.token, origin: "http://127.0.0.1:4594", "content-type": "application/json" }, body: "{invalid" });
  assert.equal((await h.commandRoute.POST(invalid)).status, 400);
  assert.equal((await h.commandRoute.POST(h.request(value.token, "/api/audience/commands", command, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_capabilities WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 0);
});

test("one command receipt can be absent, accepted, and recovered only by the original exact session", async () => {
  const value = await h.fresh(), foreign = await h.fresh(), original = await h.capture(value), state = await h.audience.readAudienceWorkspace(value.authority), id = randomUUID();
  const read = (token: string) => h.commandRead.GET(h.request(token, "/api/audience/commands/" + id), { params: Promise.resolve({ id }) });
  const absent = await read(value.token); assert.equal(absent.status, 404); assert.equal((await absent.json()).code, "AUDIENCE_RECEIPT_NOT_FOUND");
  const saved = await h.commandRoute.POST(h.request(value.token, "/api/audience/commands", { commandId: id, expectedRevision: state.revision, sessionFingerprint: state.sessionFingerprint, sessionExpiresAt: state.expiresAt, command: { type: "create_invite", ticketId: original.ticket.id, receiptDigest: state.tickets[0]!.originalDigest, validForMinutes: 60, confirmed: true } })); assert.equal(saved.status, 200); const body = await saved.json();
  const recovered = await read(value.token); assert.equal(recovered.status, 200); assert.deepEqual((await recovered.json()).receipt, body.receipt); assert.equal((await read(foreign.token)).status, 404);
});

test("delivery requires a current exact saved-pass read proof and never starts from an approval GET", async () => {
  const value = await h.fresh(), original = await h.capture(value), link = await h.invite(value, original.ticket.id), draft = await h.draft(value, [link.capabilityId]);
  await h.approve(value, draft.draft.id); const reserved = await h.reserve(value, draft.draft.id), pass = reserved.view.passes[0]!;
  const message = await h.messageRoute.GET(h.request(value.token, "/api/audience/messages/" + draft.draft.id), { params: Promise.resolve({ id: draft.draft.id }) }); assert.equal(message.status, 200); assert.equal((await message.json()).deliveries.length, 0);
  const rejected = await h.workRoute.POST(h.request(value.token, "/api/audience/work", { commandId: pass.id, proof: "0".repeat(64) })); assert.equal(rejected.status, 409); assert.equal((await rejected.json()).code, "AUDIENCE_PASS_READ_REQUIRED");
  assert.equal((await h.attendee.readAttendee(link.reader)).inbox.length, 0);
  const allowed = await h.workRoute.POST(h.request(value.token, "/api/audience/work", { commandId: pass.id, proof: pass.proof })); assert.equal(allowed.status, 200); assert.equal((await h.attendee.readAttendee(link.reader)).inbox.length, 1);
});

test("revoked private reads and expired invite recovery expose no content, key or internal production data", async () => {
  const value = await h.fresh(), original = await h.capture(value), link = await h.invite(value, original.ticket.id);
  await h.audienceAct(value.authority, { type: "revoke_invite", capabilityId: link.capabilityId, confirmed: true });
  const denied = await h.attendeeRoute.GET(h.request(link.token, "/api/attendee")); assert.equal(denied.status, 401); const raw = await denied.text();
  for (const secret of [link.token, value.token, value.actor.tenantId, original.captureId, original.ticket.id, "financialEvidence", "resources"]) assert.equal(raw.includes(secret), false);
  assert.equal((await h.invitationRoute.GET(h.request(value.token), { params: Promise.resolve({ id: link.capabilityId }) })).status, 410);
});

test("actual loopback response loss after commit recovers one original invite without a second capability", async () => {
  const value = await h.fresh(), original = await h.capture(value), state = await h.audience.readAudienceWorkspace(value.authority), commandId = randomUUID(); let committed = false;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const address = server.address(); assert.ok(address && typeof address !== "string"); const url = `http://127.0.0.1:${address.port}${incoming.url}`;
      const request = new Request(url, { method: incoming.method, headers: incoming.headers as HeadersInit, ...(incoming.method === "POST" ? { body: Readable.toWeb(incoming) as ReadableStream, duplex: "half" } : {}) } as RequestInit);
      const response = incoming.method === "POST" ? await h.commandRoute.POST(request) : await h.commandRead.GET(request, { params: Promise.resolve({ id: commandId }) });
      if (incoming.method === "POST") { assert.equal(response.status, 200); committed = true; outgoing.destroy(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
    } catch { outgoing.writeHead(503); outgoing.end("Controlled local HTTP harness could not complete"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string"); const origin = `http://127.0.0.1:${address.port}`;
  try {
    const envelope = { commandId, expectedRevision: state.revision, sessionFingerprint: state.sessionFingerprint, sessionExpiresAt: state.expiresAt, command: { type: "create_invite", ticketId: original.ticket.id, receiptDigest: state.tickets[0]!.originalDigest, validForMinutes: 60, confirmed: true } };
    await assert.rejects(fetch(origin + "/api/audience/commands", { method: "POST", headers: { authorization: "Bearer " + value.token, origin, "content-type": "application/json" }, body: JSON.stringify(envelope) })); assert.equal(committed, true);
    const recovered = await fetch(origin + "/api/audience/commands/" + commandId, { headers: { authorization: "Bearer " + value.token } }); assert.equal(recovered.status, 200); const result = await recovered.json(); assert.equal(result.receipt.commandId, commandId); assert.equal(result.replayed, true); assert.ok(result.invitation);
    assert.equal((await h.database.pool.query("SELECT 1 FROM on_audience_capabilities WHERE tenant_id=$1", [value.actor.tenantId])).rowCount, 1);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
