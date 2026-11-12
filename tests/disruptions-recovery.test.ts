import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { canonical } from "../src/domain/canonical";
import { clearDisruption, definiteDisruptionRejection, disruptionRecoveryKey, disruptionRequestDigest, matchesDisruptionReceipt, parseDisruption, prepareDisruption, retainDisruption } from "../src/components/disruptions/recovery";
import { admissionAmountMinor } from "../src/components/disruptions/shared";
import { disruptionResultFixture, disruptionUiFixture } from "./disruptions-ui-fixture";

const envelope = () => ({ idempotencyKey: randomUUID(), expectedRevision: 12, command: { type: "assess" as const } });
function memoryStorage() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }
test("reviewed disruption bytes hash exactly like the server canonical JSON", async () => {
  const workspace = disruptionUiFixture(), command = envelope(), pending = await prepareDisruption(workspace, command);
  assert.equal(pending.requestDigest, createHash("sha256").update(canonical(command)).digest("hex"));
  assert.equal(await disruptionRequestDigest({ command: command.command, expectedRevision: 12, idempotencyKey: command.idempotencyKey }), pending.requestDigest);
  assert.deepEqual(await parseDisruption(JSON.stringify(pending), workspace), pending);
});
test("the retained instruction is bound to tenant, actor and exact session fingerprint", async () => {
  const workspace = disruptionUiFixture(), pending = await prepareDisruption(workspace, envelope()), raw = JSON.stringify(pending);
  for (const identity of [{ ...workspace, tenantId: randomUUID() }, { ...workspace, actorId: "producer:another" }, { ...workspace, sessionFingerprint: "f".repeat(64) }]) {
    await assert.rejects(parseDisruption(raw, identity), /different production access/);
    assert.notEqual(disruptionRecoveryKey(workspace), disruptionRecoveryKey(identity));
  }
});
test("tampered, extra-field and noncanonical envelopes are never adopted", async () => {
  const workspace = disruptionUiFixture(), pending = await prepareDisruption(workspace, envelope());
  await assert.rejects(parseDisruption(JSON.stringify({ ...pending, envelope: { ...pending.envelope, expectedRevision: 13 } }), workspace), /changed after review/);
  const extra = { ...pending.envelope, extra: "must never be stripped" };
  await assert.rejects(parseDisruption(JSON.stringify({ ...pending, envelope: extra, requestDigest: await disruptionRequestDigest(extra) }), workspace));
  await assert.rejects(parseDisruption(JSON.stringify({ ...pending, extra: "unreviewed metadata" }), workspace));
  await assert.rejects(parseDisruption("{corrupt", workspace));
  await assert.rejects(parseDisruption(" ".repeat(24001), workspace), /recovery limit/);
});
test("a storage write is read back and cannot overwrite another reviewed instruction", async () => {
  const workspace = disruptionUiFixture(), first = await prepareDisruption(workspace, envelope()), second = await prepareDisruption(workspace, envelope()), storage = memoryStorage();
  const raw = retainDisruption(storage, first); assert.equal(storage.getItem(disruptionRecoveryKey(workspace)), raw);
  assert.equal(retainDisruption(storage, first), raw);
  assert.throws(() => retainDisruption(storage, second), /Another retained instruction/);
  assert.equal(storage.getItem(disruptionRecoveryKey(workspace)), raw);
  const swallowing = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  assert.throws(() => retainDisruption(swallowing, first), /could not retain/);
});
test("a receipt cannot retire another instruction and a removal failure preserves recovery", async () => {
  const workspace = disruptionUiFixture(), first = await prepareDisruption(workspace, envelope()), second = await prepareDisruption(workspace, envelope()), storage = memoryStorage();
  const raw = retainDisruption(storage, first);
  assert.throws(() => clearDisruption(storage, second), /changed in another view/);
  assert.throws(() => clearDisruption({ ...storage, removeItem: () => { throw new Error("Controlled removal failure"); } }, first), /Controlled removal failure/);
  assert.equal(storage.getItem(disruptionRecoveryKey(workspace)), raw);
  clearDisruption(storage, first); assert.equal(storage.getItem(disruptionRecoveryKey(workspace)), null);
});
test("only the matching receipt action, content hash and exact session can confirm a result", async () => {
  const workspace = disruptionUiFixture(), pending = await prepareDisruption(workspace, envelope()), result = await disruptionResultFixture(workspace, pending.envelope);
  assert.equal(matchesDisruptionReceipt(result, pending), true);
  for (const receipt of [{ ...result.receipt, commandId: randomUUID() }, { ...result.receipt, action: "report" }, { ...result.receipt, requestDigest: "0".repeat(64) }, { ...result.receipt, revision: 10 }]) assert.equal(matchesDisruptionReceipt({ ...result, receipt }, pending), false);
  assert.equal(matchesDisruptionReceipt({ ...result, workspace: { ...result.workspace, sessionFingerprint: "e".repeat(64) } }, pending), false);
  assert.equal(matchesDisruptionReceipt({ ...result, workspace: { ...result.workspace, tenantId: randomUUID() } }, pending), false);
  assert.equal(matchesDisruptionReceipt({ ...result, workspace: { ...result.workspace, revision: 1 } }, pending), false);
});
test("unknown financial outcomes and identity conflicts are never treated as a definite rejection", () => {
  assert.equal(definiteDisruptionRejection(503, "UPSTREAM_ERROR"), false);
  assert.equal(definiteDisruptionRejection(409, "IDEMPOTENCY_CONFLICT"), false);
  assert.equal(definiteDisruptionRejection(403, "DISRUPTION_COMMAND_OWNERSHIP"), false);
  assert.equal(definiteDisruptionRejection(401, "SESSION_REQUIRED"), false);
  assert.equal(definiteDisruptionRejection(409, "STALE_REVISION"), true);
});
test("admission policy parses exact cents without rounding or accepting exponent syntax", () => {
  for (const [input, expected] of [["0", 0], ["0.01", 1], ["12.35", 1235], ["35.00", 3500], ["8.5", 850]] as const) assert.equal(admissionAmountMinor(input), expected);
  for (const input of ["", "-1", "35.01", "2.345", "1e1", "12,35", " 12", "NaN", "100"]) assert.equal(admissionAmountMinor(input), null);
});
