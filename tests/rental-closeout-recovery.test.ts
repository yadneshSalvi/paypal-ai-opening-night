import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { canonical } from "../src/domain/canonical";
import { clearCloseout, closeoutRecoveryKey, closeoutRequestDigest, definiteCloseoutRejection, matchesCloseoutReceipt, parseCloseout, prepareCloseout, retainCloseout } from "../src/components/rental-closeout/recovery";
import { rentalUiFixture, rentalResultFixture } from "./rental-closeout-ui-fixture";
const instruction = () => ({ commandId: randomUUID(), expectedRevision: 20, command: { type: "reconcile_closeout" as const, executionId: randomUUID(), intentId: randomUUID() } });
function storage() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }
test("retained closeout bytes match server canonical hashing and bind original identity", async () => {
  const identity = rentalUiFixture(), envelope = instruction(), saved = await prepareCloseout(identity, envelope);
  assert.equal(saved.requestDigest, createHash("sha256").update(canonical(envelope)).digest("hex")); assert.deepEqual(await parseCloseout(JSON.stringify(saved), identity), saved);
  for (const other of [{ ...identity, tenantId: randomUUID() }, { ...identity, actorId: "another-producer" }, { ...identity, sessionFingerprint: "c".repeat(64) }]) { assert.notEqual(closeoutRecoveryKey(identity), closeoutRecoveryKey(other)); await assert.rejects(parseCloseout(JSON.stringify(saved), other), /different production access/); }
});
test("changed amounts, extra fields, whitespace transformations and corrupt retained data are rejected", async () => {
  const identity = rentalUiFixture(), envelope = { ...instruction(), command: { type: "approve_closeout" as const, executionId: randomUUID(), previewDigest: "d".repeat(64), detail: "Reviewed original unit and its exact remaining hold.", confirmed: true as const } }, saved = await prepareCloseout(identity, envelope);
  await assert.rejects(parseCloseout(JSON.stringify({ ...saved, envelope: { ...envelope, expectedRevision: 21 } }), identity), /changed after review/);
  for (const unreviewed of [{ ...envelope, residualMinor: 50000 }, { ...envelope, command: { ...envelope.command, detail: " " + envelope.command.detail } }, { ...envelope, command: { ...envelope.command, returnId: randomUUID() } }]) await assert.rejects(parseCloseout(JSON.stringify({ ...saved, envelope: unreviewed, requestDigest: await closeoutRequestDigest(unreviewed) }), identity));
  await assert.rejects(parseCloseout("{incomplete", identity)); await assert.rejects(parseCloseout(" ".repeat(24001), identity), /recovery limit/);
});
test("each send requires retained-byte readback and cannot replace another pending command", async () => {
  const identity = rentalUiFixture(), saved = await prepareCloseout(identity, instruction()), other = await prepareCloseout(identity, instruction()), memory = storage();
  const raw = retainCloseout(memory, saved); assert.equal(retainCloseout(memory, saved), raw); assert.throws(() => retainCloseout(memory, other), /Another retained instruction/);
  assert.equal(memory.getItem(closeoutRecoveryKey(identity)), raw); assert.throws(() => retainCloseout({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined }, saved), /could not retain/);
});
test("receipt retirement cannot remove another command and preserves failed storage removal", async () => {
  const identity = rentalUiFixture(), saved = await prepareCloseout(identity, instruction()), other = await prepareCloseout(identity, instruction()), memory = storage(), raw = retainCloseout(memory, saved);
  assert.throws(() => clearCloseout(memory, other), /changed in another view/);
  assert.throws(() => clearCloseout({ ...memory, removeItem: () => undefined }, saved), /could not retire/); assert.equal(memory.getItem(closeoutRecoveryKey(identity)), raw);
  clearCloseout(memory, saved); assert.equal(memory.getItem(closeoutRecoveryKey(identity)), null);
});
test("only exact action, original content, capability and coherent revision can confirm a receipt", async () => {
  const identity = rentalUiFixture(), saved = await prepareCloseout(identity, instruction()), result = await rentalResultFixture(identity, saved.envelope); assert.equal(matchesCloseoutReceipt(result, saved), true);
  for (const receipt of [{ ...result.receipt, commandId: randomUUID() }, { ...result.receipt, action: "approve_closeout" }, { ...result.receipt, requestDigest: "f".repeat(64) }, { ...result.receipt, revision: 19 }]) assert.equal(matchesCloseoutReceipt({ ...result, receipt }, saved), false);
  for (const workspace of [{ ...result.workspace, tenantId: randomUUID() }, { ...result.workspace, sessionFingerprint: "f".repeat(64) }, { ...result.workspace, revision: 19 }]) assert.equal(matchesCloseoutReceipt({ ...result, workspace }, saved), false);
});
test("uncertainty and changed ownership preserve recovery; definite validation rejection retires only its original bytes", () => {
  for (const [status, code] of [[503, "UPSTREAM_UNKNOWN"], [401, "SESSION_REQUIRED"], [409, "IDEMPOTENCY_CONFLICT"], [403, "RENTAL_CLOSEOUT_COMMAND_OWNER"]] as const) assert.equal(definiteCloseoutRejection(status, code), false);
  assert.equal(definiteCloseoutRejection(409, "STALE_REVISION"), true); assert.equal(definiteCloseoutRejection(400, "INVALID_RENTAL_CLOSEOUT_COMMAND"), true);
});
