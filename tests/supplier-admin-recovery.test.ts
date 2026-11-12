import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { adminRecoveryKey, clearAdminPending, matchesAdminReceipt, parseAdminPending, prepareAdminPending, resolveAdminPending, retainAdminPending } from "../src/components/supplier-admin/recovery";
import { supplierAdminHarness } from "./supplier-admin-harness";
const h = await supplierAdminHarness(); after(h.close);
class MemoryStorage { values = new Map<string, string>(); getItem(key: string) { return this.values.get(key) ?? null; } setItem(key: string, value: string) { this.values.set(key, value); } removeItem(key: string) { this.values.delete(key); } }
async function pending() { const p = await h.initial(), state = await h.admin.readSupplierAdminWorkspace(p.authority), envelope = h.envelope(state, { type: "invite", name: "Recovery-controlled supplier", reference: "Controlled exact recovery source", detail: "Retained original producer instruction for controlled response-loss verification; no external message claimed.", reviewDigest: state.reviewDigest, confirmed: true }); return { p, state, envelope, saved: await prepareAdminPending(state, envelope) }; }

test("browser storage binds full exact identity and refuses changed bytes or later expiry adoption", async () => {
  const value = await pending(), storage = new MemoryStorage(); retainAdminPending(storage, value.saved);
  const parsed = await parseAdminPending(storage.getItem(adminRecoveryKey(value.saved))!, value.state);
  assert.equal(parsed.requestDigest, value.saved.requestDigest);
  await assert.rejects(() => parseAdminPending(JSON.stringify(value.saved), { ...value.state, expiresAt: value.state.expiresAt.replace(/\d{6}Z$/, "999999Z") }), /different exact access/);
  await assert.rejects(() => parseAdminPending(JSON.stringify({ ...value.saved, envelope: { ...value.envelope, expectedRevision: 999 } }), value.state), /changed/);
  assert.throws(() => retainAdminPending(storage, { ...value.saved, createdAt: "2026-11-12T00:00:00.000Z" }), /Another original/);
  clearAdminPending(storage, parsed); assert.equal(storage.getItem(adminRecoveryKey(value.saved)), null);
});

test("storage write or readback failure prevents any dispatch and retirement preserves a conflicting file", async () => {
  const value = await pending(), storage = new MemoryStorage(); storage.setItem = () => undefined;
  assert.throws(() => retainAdminPending(storage, value.saved), /Nothing was sent/);
  storage.values.set(adminRecoveryKey(value.saved), "other retained instruction"); assert.throws(() => clearAdminPending(storage, value.saved), /preserved/); assert.equal(storage.values.get(adminRecoveryKey(value.saved)), "other retained instruction");
});

test("actual committed-response loss recovers the original receipt by GET with no new POST", async () => {
  const value = await pending(), storage = new MemoryStorage(); retainAdminPending(storage, value.saved);
  // The actual service commits; the transport hides only its response.
  const result = await h.admin.executeSupplierAdminCommand(value.p.authority, value.envelope), calls: string[] = [];
  const found = await resolveAdminPending(async path => { calls.push("GET " + path); return Response.json(await h.admin.recoverSupplierAdminCommand(value.p.authority, value.envelope.commandId)); }, value.saved, true);
  assert.equal(found.kind, "receipt"); if (found.kind === "receipt") { assert.equal(found.result.receipt.recordId, result.receipt.recordId); assert.equal(matchesAdminReceipt(found.result, value.saved), true); clearAdminPending(storage, value.saved); }
  assert.deepEqual(calls, ["GET /api/supplier-admin/commands/" + value.envelope.commandId]); assert.equal(storage.getItem(adminRecoveryKey(value.saved)), null);
});

test("retry requires original404 then fresh same access and sends the unchanged command exactly once", async () => {
  const value = await pending(), calls: string[] = [];
  const found = await resolveAdminPending(async (path, init) => { calls.push((init?.method ?? "GET") + " " + path); if (path.includes("/commands/")) return Response.json({ code: "SUPPLIER_ADMIN_COMMAND_NOT_FOUND" }, { status: 404 }); if (path === "/api/supplier-admin") return Response.json(await h.admin.readSupplierAdminWorkspace(value.p.authority)); assert.equal(String(init?.body), JSON.stringify(value.envelope)); return Response.json(await h.admin.executeSupplierAdminCommand(value.p.authority, JSON.parse(String(init?.body)))); }, value.saved, true);
  assert.equal(found.kind, "receipt"); assert.deepEqual(calls, ["GET /api/supplier-admin/commands/" + value.envelope.commandId, "GET /api/supplier-admin", "POST /api/supplier-admin/commands"]);
});

test("plain reads never retry and a later capability or unverified404 cannot dispatch", async () => {
  const value = await pending(); let calls = 0;
  assert.equal((await resolveAdminPending(async () => { calls++; return Response.json({ code: "SUPPLIER_ADMIN_COMMAND_NOT_FOUND" }, { status: 404 }); }, value.saved)).kind, "not_received"); assert.equal(calls, 1);
  const actions: string[] = [];
  await assert.rejects(() => resolveAdminPending(async (path, init) => { actions.push(init?.method ?? "GET"); return path.includes("/commands/") ? Response.json({ code: "SUPPLIER_ADMIN_COMMAND_NOT_FOUND" }, { status: 404 }) : Response.json({ ...value.state, expiresAt: "2099-01-01T00:00:00.000000Z" }); }, value.saved, true), /not resent/); assert.deepEqual(actions, ["GET", "GET"]);
  await assert.rejects(() => resolveAdminPending(async () => Response.json({ code: "OTHER_NOT_FOUND" }, { status: 404 }), value.saved, true), /could not be verified/);
});

test("mismatched receipts cannot retire retained instructions; durable refusal remains recoverable", async () => {
  const value = await pending(), result = await h.admin.executeSupplierAdminCommand(value.p.authority, value.envelope);
  assert.equal(matchesAdminReceipt({ ...result, receipt: { ...result.receipt, commandId: randomUUID() } }, value.saved), false);
  assert.equal(matchesAdminReceipt({ ...result, workspace: { ...result.workspace, sessionFingerprint: "b".repeat(64) } }, value.saved), false);
  const changed = h.envelope(result.workspace, { ...value.envelope.command, reviewDigest: "0".repeat(64) } as Extract<typeof value.envelope.command, { type: "invite" }>), original = await prepareAdminPending(result.workspace, changed), refused = await h.admin.executeSupplierAdminCommand(value.p.authority, changed);
  assert.equal(refused.receipt.status, "refused"); assert.equal(matchesAdminReceipt(refused, original), true); assert.equal((await h.admin.recoverSupplierAdminCommand(value.p.authority, changed.commandId)).receipt.code, "SUPPLIER_ADMIN_REVIEW_CHANGED");
});
