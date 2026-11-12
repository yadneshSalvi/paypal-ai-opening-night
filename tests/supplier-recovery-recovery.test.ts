import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { canonical } from "../src/domain/canonical";
import { clearSupplierRecovery, definiteSupplierRecoveryRejection, matchesSupplierRecoveryReceipt, parseSupplierRecovery, prepareSupplierRecovery, retainSupplierRecovery, supplierRecoveryRecoveryKey, supplierRecoveryRequestDigest } from "../src/components/supplier-recovery/recovery";
import { supplierRecoveryResultFixture, supplierRecoveryUiFixture } from "./supplier-recovery-ui-fixture";
const instruction = () => ({ commandId: randomUUID(), expectedRevision: 20, command: { type: "request_quotes" as const, previewDigest: "b".repeat(64), detail: "Reviewed the current disruption and every original obligation.", confirmed: true as const } });
function storage() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }
test("current-source recovery uses the server canonical digest and exact production, actor and capability", async () => {
  const identity = supplierRecoveryUiFixture(), envelope = instruction(), saved = await prepareSupplierRecovery(identity, envelope);
  assert.equal(saved.requestDigest, createHash("sha256").update(canonical(envelope)).digest("hex")); assert.deepEqual(await parseSupplierRecovery(JSON.stringify(saved), identity), saved);
  for (const other of [{ ...identity, tenantId: randomUUID() }, { ...identity, actorId: "another-producer" }, { ...identity, sessionFingerprint: "c".repeat(64) }]) { assert.notEqual(supplierRecoveryRecoveryKey(identity), supplierRecoveryRecoveryKey(other)); await assert.rejects(parseSupplierRecovery(JSON.stringify(saved), other), /different production access/); }
});
test("changed terms, whitespace rewriting, extra fields and corrupt recovery files cannot be sent", async () => {
  const identity = supplierRecoveryUiFixture(), envelope = instruction(), saved = await prepareSupplierRecovery(identity, envelope);
  await assert.rejects(parseSupplierRecovery(JSON.stringify({ ...saved, envelope: { ...envelope, expectedRevision: 21 } }), identity), /changed after review/);
  for (const unreviewed of [{ ...envelope, automaticApproval: true }, { ...envelope, command: { ...envelope.command, detail: " " + envelope.command.detail } }, { ...envelope, command: { ...envelope.command, feeMinor: 9999 } }]) await assert.rejects(parseSupplierRecovery(JSON.stringify({ ...saved, envelope: unreviewed, requestDigest: await supplierRecoveryRequestDigest(unreviewed) }), identity));
  await assert.rejects(parseSupplierRecovery("{incomplete", identity)); await assert.rejects(parseSupplierRecovery(" ".repeat(24001), identity), /recovery limit/);
});
test("every retry needs exact retained-byte readback and cannot overwrite or retire another instruction", async () => {
  const identity = supplierRecoveryUiFixture(), saved = await prepareSupplierRecovery(identity, instruction()), other = await prepareSupplierRecovery(identity, instruction()), memory = storage(), raw = retainSupplierRecovery(memory, saved);
  assert.equal(retainSupplierRecovery(memory, saved), raw); assert.throws(() => retainSupplierRecovery(memory, other), /Another retained instruction/); assert.throws(() => clearSupplierRecovery(memory, other), /changed in another view/);
  assert.throws(() => retainSupplierRecovery({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined }, saved), /could not retain/);
  assert.throws(() => clearSupplierRecovery({ ...memory, removeItem: () => undefined }, saved), /could not retire/); assert.equal(memory.getItem(supplierRecoveryRecoveryKey(identity)), raw);
  clearSupplierRecovery(memory, saved); assert.equal(memory.getItem(supplierRecoveryRecoveryKey(identity)), null);
});
test("only a matching receipt can confirm the action and retire its original source review", async () => {
  const identity = supplierRecoveryUiFixture(), saved = await prepareSupplierRecovery(identity, instruction()), result = await supplierRecoveryResultFixture(identity, saved.envelope); assert.equal(matchesSupplierRecoveryReceipt(result, saved), true);
  for (const receipt of [{ ...result.receipt, commandId: randomUUID() }, { ...result.receipt, action: "publish_terms" }, { ...result.receipt, requestDigest: "f".repeat(64) }, { ...result.receipt, revision: 19 }]) assert.equal(matchesSupplierRecoveryReceipt({ ...result, receipt }, saved), false);
  for (const workspace of [{ ...result.workspace, tenantId: randomUUID() }, { ...result.workspace, sessionFingerprint: "f".repeat(64) }, { ...result.workspace, revision: 19 }]) assert.equal(matchesSupplierRecoveryReceipt({ ...result, workspace }, saved), false);
});
test("private supplier invitation recovery admits only the exact local path and requested scope", async () => {
  const identity = supplierRecoveryUiFixture(), envelope = { commandId: randomUUID(), expectedRevision: 20, command: { type: "open_supplier" as const, supplierId: "northside" as const, confirmed: true as const } }, saved = await prepareSupplierRecovery(identity, envelope), result = await supplierRecoveryResultFixture(identity, envelope);
  assert.equal(matchesSupplierRecoveryReceipt(result, saved), true);
  for (const invitation of [undefined, { ...result.invitation!, supplierId: "sister" }, { ...result.invitation!, url: "https://untrusted.example/supplier/access#" + "a".repeat(43) }, { ...result.invitation!, url: "javascript:alert(1)" }, { ...result.invitation!, expiresAt: "not-a-date" }]) assert.equal(matchesSupplierRecoveryReceipt({ ...result, invitation }, saved), false);
});
test("uncertainty, expiry and changed ownership preserve the retained instruction", () => {
  for (const [status, code] of [[503, "UNKNOWN"], [401, "SUPPLIER_RECOVERY_SESSION_ENDED"], [409, "IDEMPOTENCY_CONFLICT"], [403, "SUPPLIER_RECOVERY_COMMAND_OWNER"]] as const) assert.equal(definiteSupplierRecoveryRejection(status, code), false);
  assert.equal(definiteSupplierRecoveryRejection(409, "STALE_REVISION"), true); assert.equal(definiteSupplierRecoveryRejection(400, "INVALID_PLANNING_COMMAND"), true);
});
