/** Route contracts over controlled installed-SDK services, with all actual egress blocked. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { rentalHarness } from "./rental-closeout-harness";
import type { CloseoutEnvelope } from "../src/domain/rental-closeout";
const h = await rentalHarness(); after(h.close);
const get = await import("../src/app/api/rental-closeout/route"), command = await import("../src/app/api/rental-closeout/commands/route"), receipt = await import("../src/app/api/rental-closeout/commands/[id]/route"), preview = await import("../src/app/api/rental-closeout/preview/route"), work = await import("../src/app/api/rental-closeout/work/route");
const origin = "http://127.0.0.1:4580";
function request(path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) { return new Request(origin + path, { method: body === undefined ? "GET" : "POST", headers: { ...(token ? { Authorization: "Bearer " + token } : { Authorization: "Basic no-authority" }), ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
const recover = (token: string, id: string) => receipt.GET(request("/api/rental-closeout/commands/" + id, token), { params: Promise.resolve({ id }) });
test("anonymous, wrong-origin, overlong and unrecognized instructions cannot mutate a rental", async () => {
  const anonymous = await get.GET(request("/api/rental-closeout")); assert.equal(anonymous.status, 401); assert.match(anonymous.headers.get("cache-control")!, /no-store/);
  const value = await h.accepted(), desk = await h.service.readCloseoutWorkspace(value.supplierAuthority), rental = desk.rentals[0]!;
  const body: CloseoutEnvelope = { commandId: randomUUID(), expectedRevision: desk.revision, command: { type: "record_return", executionId: rental.id, executionDigest: rental.executionDigest, previousInspectionId: null, observedAt: new Date().toISOString(), condition: "undamaged", detail: "Controlled original supplier inspection for route boundaries.", confirmed: true } };
  assert.equal((await command.POST(request("/api/rental-closeout/commands", value.supplierToken, body, { Origin: "http://localhost:4580" }))).status, 403);
  const unknown = await command.POST(request("/api/rental-closeout/commands", value.supplierToken, { ...body, fakeSecret: "never echo this value" })); assert.equal(unknown.status, 400); assert.doesNotMatch(await unknown.text(), /never echo this value/);
  assert.equal((await command.POST(request("/api/rental-closeout/commands", value.supplierToken, { ...body, detail: "x".repeat(31000) }))).status, 413);
  assert.equal((await h.service.readCloseoutWorkspace(value.supplierAuthority)).rentals[0]!.returns.length, 0);
});
test("HTTP return, exact receipt and separate producer review retain original financial bindings", async () => {
  const value = await h.accepted(), desk = await h.service.readCloseoutWorkspace(value.supplierAuthority), rental = desk.rentals[0]!, writes = h.wire.voids().length;
  const envelope: CloseoutEnvelope = { commandId: randomUUID(), expectedRevision: desk.revision, command: { type: "record_return", executionId: rental.id, executionDigest: rental.executionDigest, previousInspectionId: null, observedAt: new Date().toISOString(), condition: "undamaged", detail: "Controlled original supplier return; no real-world physical qualification.", confirmed: true } };
  const first = await command.POST(request("/api/rental-closeout/commands", value.supplierToken, envelope)); assert.equal(first.status, 200); assert.match(first.headers.get("cache-control")!, /no-store/); const saved = await first.json();
  assert.doesNotMatch(JSON.stringify(saved), /sessionHash|document_cipher|receipt_cipher|JUDGE_SESSION_SECRET|PayPal-Request-Id/); assert.equal(saved.workspace.rentals[0].originalPlanVersion, value.original.planVersion); assert.equal(saved.workspace.rentals[0].releasedMinor, 0); assert.equal(h.wire.voids().length, writes);
  const recovered = await recover(value.supplierToken, envelope.commandId); assert.equal(recovered.status, 200); assert.deepEqual((await recovered.json()).receipt, saved.receipt);
  const duplicate = await command.POST(request("/api/rental-closeout/commands", value.supplierToken, envelope)); assert.equal((await duplicate.json()).replayed, true);
  const expectedRevision = saved.workspace.revision, previewBody = { executionId: value.executionId, expectedRevision };
  assert.equal((await preview.POST(request("/api/rental-closeout/preview", value.supplierToken, previewBody))).status, 403);
  assert.equal((await work.POST(request("/api/rental-closeout/work", value.supplierToken, {}))).status, 403);
  const read = await preview.POST(request("/api/rental-closeout/preview", value.token, previewBody)); assert.equal(read.status, 200); const review = await read.json(); assert.equal(review.ready, true); assert.equal(review.authorizationMinor, 78000); assert.equal(review.acceptedFeeMinor, 48000); assert.equal(review.residualMinor, 30000); assert.equal((await h.store.getShow(value.actor.tenantId)).revision, expectedRevision);
  const approval = await command.POST(request("/api/rental-closeout/commands", value.token, { commandId: randomUUID(), expectedRevision, command: { type: "approve_closeout", executionId: value.executionId, previewDigest: review.digest, detail: "Producer reviewed the original controlled return, captured fee and remaining hold.", confirmed: true } })); assert.equal(approval.status, 200); const approved = await approval.json(); assert.equal(approved.workspace.rentals[0].releasedMinor, 0); assert.equal(h.wire.voids().length, writes);
  const processed = await work.POST(request("/api/rental-closeout/work", value.token, {})); assert.equal(processed.status, 200); assert.equal((await processed.json()).workspace.rentals[0].releasedMinor, 30000); assert.equal(h.wire.voids().length, writes + 1);
});
test("receipt absence, another capability, another production and expiry remain distinct private outcomes", async () => {
  const value = await h.accepted(), returned = await h.returned(value), commandId = returned.receipt.commandId;
  const token = randomBytes(32).toString("base64url"); await h.database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [h.sessionTokenHash(token), value.actor.tenantId, value.supplierAuthority.actor]);
  assert.equal((await recover(token, commandId)).status, 404); const missing = await recover(value.supplierToken, randomUUID()); assert.equal(missing.status, 404); assert.equal((await missing.json()).code, "RENTAL_CLOSEOUT_RECEIPT_NOT_FOUND");
  assert.equal((await get.GET(request("/api/rental-closeout", value.token, undefined, { "x-opening-night-production": randomUUID() }))).status, 409);
  await h.database.pool.query("UPDATE on_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [value.supplierAuthority.sessionHash]); assert.equal((await recover(value.supplierToken, commandId)).status, 401);
});
