import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { isolatedDatabase } from "./isolated-database";
import type { DisruptionEnvelope } from "../src/domain/disruptions";
const database = await isolatedDatabase();
const store = await import("../src/server/store"), payments = await import("../src/server/payment-store");
const get = await import("../src/app/api/disruptions/route"), post = await import("../src/app/api/disruptions/commands/route"), recover = await import("../src/app/api/disruptions/commands/[id]/route"), preview = await import("../src/app/api/disruptions/preview/route");
const { sessionTokenHash } = await import("../src/server/session-records");
await payments.paymentStore(); after(() => database.close());
const origin = "http://localhost:4564";
const request = (path: string, token?: string, body?: unknown, otherHeaders: Record<string, string> = {}) => new Request(origin + path, { method: body === undefined ? "GET" : "POST", headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json" }), ...otherHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
function report(show: Awaited<ReturnType<typeof store.getShow>>): DisruptionEnvelope {
  return { idempotencyKey: randomUUID(), expectedRevision: show.revision, command: { type: "report", offerId: show.offers[0]!.id, offerRevision: show.offers[0]!.revision, executionId: null, availability: "unavailable", earliestAt: null, observedAt: new Date().toISOString(), reference: "Controlled HTTP source", detail: "Attributed fixture source says the current supplier unit cannot fulfill this production.", confirmed: true } };
}
test("unauthenticated access is a no-session response; cross-origin mutations and oversized or unknown fields are rejected", async () => {
  // Explicitly unsupported credentials avoid invoking Next's request-local cookies outside an HTTP server.
  const anonymous = await get.GET(request("/api/disruptions", undefined, undefined, { Authorization: "Basic no-authority" })); assert.equal(anonymous.status, 401); assert.equal((await anonymous.json()).code, "SESSION_REQUIRED");
  const session = await store.createSession(undefined, "disruption-http:" + randomUUID()), envelope = report(session.show);
  const wrongOrigin = await post.POST(request("/api/disruptions/commands", session.token, envelope, { Origin: "http://localhost:4561" })); assert.equal(wrongOrigin.status, 403);
  const extra = await post.POST(request("/api/disruptions/commands", session.token, { ...envelope, forgeAuthority: "do not echo this field" })); assert.equal(extra.status, 400); assert.doesNotMatch(await extra.text(), /do not echo/);
  const oversized = await post.POST(request("/api/disruptions/commands", session.token, { ...envelope, excessive: "a".repeat(31000) })); assert.equal(oversized.status, 413);
  assert.equal((await store.getShow(session.actor.tenantId)).supplierDisruptions?.length ?? 0, 0);
});
test("HTTP commit, exact receipt recovery, and explicit missing receipt remain distinguishable and private", async () => {
  const session = await store.createSession(undefined, "disruption-http:" + randomUUID()), envelope = report(session.show);
  const committed = await post.POST(request("/api/disruptions/commands", session.token, envelope)); assert.equal(committed.status, 200); assert.match(committed.headers.get("cache-control")!, /no-store/);
  const result = await committed.json(); assert.equal(result.receipt.commandId, envelope.idempotencyKey); assert.equal(result.workspace.reports.length, 1); assert.equal(result.workspace.providerActionsEnabled, false);
  assert.doesNotMatch(JSON.stringify(result), /sessionHash|document_cipher|receipt_cipher|JUDGE_SESSION_SECRET/);
  const recovered = await recover.GET(request("/api/disruptions/commands/" + envelope.idempotencyKey, session.token), { params: Promise.resolve({ id: envelope.idempotencyKey }) }); assert.equal(recovered.status, 200); assert.deepEqual((await recovered.json()).receipt, result.receipt);
  const missingId = randomUUID(), missing = await recover.GET(request("/api/disruptions/commands/" + missingId, session.token), { params: Promise.resolve({ id: missingId }) }); assert.equal(missing.status, 404); assert.equal((await missing.json()).code, "DISRUPTION_COMMAND_NOT_FOUND");
  const otherToken = randomBytes(32).toString("base64url"); await database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [sessionTokenHash(otherToken), session.actor.tenantId, session.actor]);
  const other = await recover.GET(request("/api/disruptions/commands/" + envelope.idempotencyKey, otherToken), { params: Promise.resolve({ id: envelope.idempotencyKey }) }); assert.equal(other.status, 404);
  const foreign = await store.createSession(undefined, "disruption-http-other:" + randomUUID());
  const crossed = await get.GET(request("/api/disruptions", foreign.token, undefined, { "x-opening-night-production": session.actor.tenantId })); assert.equal(crossed.status, 409);
});
test("preview is a scoped read and cannot turn an unverified fixture ticket into a refundable original capture", async () => {
  const session = await store.createSession(undefined, "disruption-http:" + randomUUID());
  const posted = await post.POST(request("/api/disruptions/commands", session.token, report(session.show))); assert.equal(posted.status, 200);
  const invalid = await preview.POST(request("/api/disruptions/preview", session.token, { mode: "cancel_show", admissionRefundMinor: 1500 })); assert.equal(invalid.status, 400);
  const before = await store.getShow(session.actor.tenantId);
  const read = await preview.POST(request("/api/disruptions/preview", session.token, { mode: "cancel_show", admissionRefundMinor: 3500 })); assert.equal(read.status, 200); const body = await read.json(); assert.equal(body.capturedTickets, 0); assert.equal(body.newRefundMinor, 0);
  assert.equal((await store.getShow(session.actor.tenantId)).revision, before.revision); assert.equal((await payments.listIntents(session.actor.tenantId)).length, 0);
  await database.pool.query("UPDATE on_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [sessionTokenHash(session.token)]);
  const expired = await post.POST(request("/api/disruptions/commands", session.token, report(before))); assert.equal(expired.status, 401);
});
