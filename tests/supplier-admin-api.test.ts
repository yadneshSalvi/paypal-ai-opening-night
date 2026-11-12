import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { supplierIds } from "../src/domain/supplier-contracts";
import { supplierRecoveryCommandSchema } from "../src/domain/supplier-recovery-command";
import { PRODUCTION_SCOPE_HEADER } from "../src/domain/rehearsal-contracts";
import { supplierHeaders } from "../src/server/supplier-protocol";
import type { SupplierRequest } from "../src/server/supplier-protocol";
import { supplierAdminHarness } from "./supplier-admin-harness";
const h = await supplierAdminHarness(); after(h.close);
const read = await import("../src/app/api/supplier-admin/route"), commands = await import("../src/app/api/supplier-admin/commands/route"), recovery = await import("../src/app/api/supplier-admin/commands/[id]/route"), rpc = await import("../src/app/api/supplier-admin/rpc/[supplier]/route"), legacyRpc = await import("../src/app/api/enrolled-suppliers/[supplier]/rpc/route");
function request(path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) { return new Request("http://127.0.0.1:4619" + path, { method: body === undefined ? "GET" : "POST", headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(body === undefined ? {} : { Origin: "http://127.0.0.1:4619", "Content-Type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }

test("desk and original receipts require authenticated exact access and private no-store responses", async () => {
  assert.equal((await read.GET(request("/api/supplier-admin"))).status, 401);
  const p = await h.initial(), response = await read.GET(request("/api/supplier-admin", p.token)), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.actorId, p.actor.id); assert.match(response.headers.get("Cache-Control")!, /no-store/); assert.equal(response.headers.get("Referrer-Policy"), "no-referrer"); assert.doesNotMatch(JSON.stringify(body), /sessionHash|privateKey|document_cipher/);
  const unknown = await recovery.GET(request("/api/supplier-admin/commands/" + randomUUID(), p.token), { params: Promise.resolve({ id: randomUUID() }) }); assert.equal(unknown.status, 404); assert.equal((await unknown.json()).code, "SUPPLIER_ADMIN_COMMAND_NOT_FOUND");
});

test("same-origin, production scope, strict bodies and fixed proof reject arbitrary request expansion", async () => {
  const p = await h.initial(), state = await h.admin.readSupplierAdminWorkspace(p.authority), envelope = h.envelope(state, { type: "invite", name: "Controlled API supplier", reference: "Declared owned API source", detail: "Controlled supplier API admission proof only; no outreach or physical identity claim.", reviewDigest: state.reviewDigest, confirmed: true });
  assert.equal((await commands.POST(request("/api/supplier-admin/commands", p.token, envelope, { Origin: "http://localhost:4619" }))).status, 403);
  assert.equal((await commands.POST(request("/api/supplier-admin/commands", p.token, envelope, { [PRODUCTION_SCOPE_HEADER]: randomUUID() }))).status, 409);
  assert.equal((await commands.POST(request("/api/supplier-admin/commands", p.token, { ...envelope, endpoint: "http://169.254.169.254" }))).status, 400);
  assert.equal((await commands.POST(request("/api/supplier-admin/commands", p.token, { ...envelope, expiresAt: new Date(state.expiresAt).toISOString() }))).status, 400);
  assert.equal((await commands.POST(request("/api/supplier-admin/commands", p.token, { ...envelope, sessionFingerprint: "f".repeat(64) }))).status, 409);
  assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_supplier_admin_records WHERE tenant_id=$1", [p.actor.tenantId])).rows[0].count), 0);
});

test("a real admission command and GET recovery return one original invitation without renewing it", async () => {
  const p = await h.initial(), state = await h.admin.readSupplierAdminWorkspace(p.authority), envelope = h.envelope(state, { type: "invite", name: "Controlled API supplier", reference: "Controlled current producer source", detail: "Producer reviews the actual source before creating a separate controlled supplier owner access.", reviewDigest: state.reviewDigest, confirmed: true });
  const saved = await commands.POST(request("/api/supplier-admin/commands", p.token, envelope)), result = await saved.json(); assert.equal(saved.status, 200); assert.equal(result.receipt.status, "completed");
  const got = await recovery.GET(request("/api/supplier-admin/commands/" + envelope.commandId, p.token), { params: Promise.resolve({ id: envelope.commandId }) }), recovered = await got.json();
  assert.equal(got.status, 200); assert.equal(recovered.invitation.url, result.invitation.url); assert.equal(recovered.invitation.expiresAt, result.invitation.expiresAt); assert.equal(recovered.replayed, true);
});

test("managed ids cannot enter the unchanged three-service RPC or legacy supplier-opening command", async () => {
  const id = `enrolled-${randomUUID()}` as const, p = await h.initial(); assert.deepEqual(supplierIds, ["brightline", "northside", "sister"]);
  assert.equal(supplierRecoveryCommandSchema.safeParse({ type: "open_supplier", supplierId: id, confirmed: true }).success, false);
  const body: SupplierRequest = { version: 1, requestId: randomUUID(), tenantId: p.actor.tenantId, actorId: p.actor.id, action: { type: "quote" } };
  const response = await legacyRpc.POST(new Request(`http://127.0.0.1:4619/api/enrolled-suppliers/${id}/rpc`, { method: "POST", headers: supplierHeaders(id, body), body: JSON.stringify(body) }), { params: Promise.resolve({ supplier: id }) });
  assert.equal(response.status, 404); assert.equal((await response.json()).code, "SUPPLIER_NOT_ENROLLED");
});

test("managed RPC rejects syntax-only enrollment and keeps independent request scope", async () => {
  const p = await h.initial(), id = `enrolled-${randomUUID()}` as const, state = await h.admin.readSupplierAdminWorkspace(p.authority);
  const body: SupplierRequest = { version: 1, requestId: randomUUID(), tenantId: p.actor.tenantId, actorId: p.actor.id, action: { type: "hold", quoteId: randomUUID(), planDigest: "a".repeat(64), expectedRevision: state.revision, acceptCaptureTerms: true, producerAccess: { sessionHash: p.authority.sessionHash, expiresAt: state.expiresAt } } };
  const call = new Request(`http://127.0.0.1:4619/api/supplier-admin/rpc/${id}`, { method: "POST", headers: supplierHeaders(id, body), body: JSON.stringify(body) });
  const result = await rpc.POST(call, { params: Promise.resolve({ supplier: id }) }); assert.equal(result.status, 403); assert.equal((await result.json()).code, "SUPPLIER_NOT_ADMITTED");
  assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_supplier_admin_requests WHERE tenant_id=$1", [p.actor.tenantId])).rows[0].count), 0);
});

test("managed HTTP service holds the exact approved quote once and replays only its immutable request", async () => {
  const p = await h.initial(), q = await h.quoted(p.authority), plan = await h.realPlan(p.authority, q), state = await h.admin.readSupplierAdminWorkspace(p.authority), supplierId = q.owner.supplierId;
  const body: SupplierRequest = { version: 1, requestId: randomUUID(), tenantId: p.actor.tenantId, actorId: p.actor.id, action: { type: "hold", quoteId: plan.quote.id, planDigest: plan.show.approvedPlan!.digest, expectedRevision: state.revision, acceptCaptureTerms: true, producerAccess: { sessionHash: p.authority.sessionHash, expiresAt: state.expiresAt } } };
  const call = () => rpc.POST(new Request(`http://127.0.0.1:4619/api/supplier-admin/rpc/${supplierId}`, { method: "POST", headers: supplierHeaders(supplierId, body), body: JSON.stringify(body) }), { params: Promise.resolve({ supplier: supplierId }) });
  const first = await call(), firstBody = await first.json(), duplicate = await call(), duplicateBody = await duplicate.json();
  assert.equal(first.status, 200); assert.equal(duplicate.status, 200); assert.equal(firstBody.result.execution.id, duplicateBody.result.execution.id); assert.equal(firstBody.signature, duplicateBody.signature);
  assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_supplier_admin_requests WHERE tenant_id=$1", [p.actor.tenantId])).rows[0].count), 1);
  await assert.rejects(() => h.database.pool.query("DELETE FROM on_supplier_admin_requests WHERE tenant_id=$1", [p.actor.tenantId]), /immutable/);
});
