import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { capabilityFingerprint, emptyOutbox, prepareReadbackAttempt, queueReadback, readbackEnvelope, readCache, readOutbox, recoveredReadback, rejectStaleReadback, retireLegacyCrewStorage, saveCache, saveOutbox, sameReview, storageKeys, type CrewStorage } from "../src/components/crew/storage";
import { crewData } from "../src/server/crew/projection";
import { crewAck, crewActor, crewPublished } from "./crew-fixtures";

class MemoryStorage implements CrewStorage {
  readonly data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
const expires = new Date(Date.now() + 86400000).toISOString();
function personal() { const { show } = crewPublished(); const actor = crewActor(show, "priya"); return { show, actor, data: crewData(show, actor, expires) }; }

test("full SHA256 capability fingerprints separate equal prefixes without retaining raw bearers", async () => {
  const first = "SameFirst16Chars_" + randomBytes(20).toString("base64url");
  const second = "SameFirst16Chars_" + randomBytes(20).toString("base64url");
  const a = await capabilityFingerprint(first), b = await capabilityFingerprint(second);
  assert.equal(a.length, 64); assert.notEqual(a, b); assert.notEqual(storageKeys(a).cache, storageKeys(b).cache);
  const storage = new MemoryStorage(); saveCache(storage, a, personal().data); saveOutbox(storage, emptyOutbox(a));
  const persisted = JSON.stringify([...storage.data]); assert.equal(persisted.includes(first), false); assert.equal(persisted.includes(second), false);
  assert.equal(readCache(storage, b), null);
});
test("versioned scoped cache rejects invalid JSON, wrong capability, broad snapshots and expired access", () => {
  const storage = new MemoryStorage(), fingerprint = "a".repeat(64), { data } = personal();
  const now = Date.now(); const valid = saveCache(storage, fingerprint, data, new Date(now).toISOString());
  assert.deepEqual(readCache(storage, fingerprint, now)?.data, data);
  for (const invalid of ["{broken", JSON.stringify({ ...valid, version: 1 }), JSON.stringify({ ...valid, capabilityFingerprint: "b".repeat(64) }), JSON.stringify({ ...valid, data: { ...data, financialEvidence: [] } }), JSON.stringify({ ...valid, cachedAt: new Date(now + 120000).toISOString() })]) {
    storage.setItem(storageKeys(fingerprint).cache, invalid); assert.equal(readCache(storage, fingerprint, now), null);
  }
  saveCache(storage, fingerprint, data); assert.equal(readCache(storage, fingerprint, Date.parse(expires) + 1), null);
});
test("queued historical readbacks and their immutable identity survive a page reload", () => {
  const { data } = personal(), storage = new MemoryStorage(), fingerprint = "c".repeat(64);
  const pending = queueReadback(data, data.sheet.changes.map(change => change.taskId), true);
  const outbox = { ...emptyOutbox(fingerprint), readbacks: [pending] }; saveOutbox(storage, outbox);
  const reloaded = readOutbox(storage, fingerprint);
  assert.deepEqual(reloaded.readbacks[0], pending); assert.equal(reloaded.readbacks[0]!.status, "queued"); assert.equal(reloaded.readbacks[0]!.command.offline, true);
  assert.throws(() => readbackEnvelope(pending), /first attempt revision/);
});
test("an ambiguous response keeps exactly the first attempted revision, UUID and payload on replay", () => {
  const { data } = personal(), fingerprint = "d".repeat(64), storage = new MemoryStorage();
  const pending = queueReadback(data, data.sheet.changes.map(change => change.taskId), false);
  const attempted = prepareReadbackAttempt(pending, data.show.revision);
  saveOutbox(storage, { ...emptyOutbox(fingerprint), readbacks: [attempted] });
  const reloaded = readOutbox(storage, fingerprint).readbacks[0]!;
  const replay = prepareReadbackAttempt(reloaded, data.show.revision + 40);
  assert.equal(JSON.stringify(readbackEnvelope(replay)), JSON.stringify(readbackEnvelope(attempted)));
  assert.equal(replay.idempotencyKey, pending.idempotencyKey); assert.deepEqual(replay.command, pending.command);
});
test("only a definite stale rejection permits revision refresh under the original readback identity", () => {
  const { data } = personal(), pending = queueReadback(data, data.sheet.changes.map(change => change.taskId), true);
  const attempted = prepareReadbackAttempt(pending, data.show.revision), rejected = rejectStaleReadback(attempted);
  const retry = prepareReadbackAttempt(rejected, data.show.revision + 2);
  assert.equal(retry.expectedRevision, data.show.revision + 2); assert.equal(retry.idempotencyKey, pending.idempotencyKey); assert.deepEqual(retry.command, pending.command);
  assert.deepEqual(retry.rejectedRevisions, [data.show.revision]);
  assert.throws(() => rejectStaleReadback(pending), /no attempted revision/);
});
test("server receipts recover exact historical readbacks while legacy or another person's history cannot", () => {
  const { show, actor, data } = personal();
  const old = show.sheets[0]!, reviewed = { ...data, sheet: { ...data.sheet, version: old.version, digest: old.digest, changes: [] } };
  const pending = queueReadback(reviewed, [], true);
  const recorded = crewAck(show, actor.personId!, old, actor, pending.idempotencyKey);
  const current = crewData(recorded, actor, expires), recovered = recoveredReadback(current, pending);
  assert.equal(recovered?.current, false); assert.equal(recovered?.commandId, pending.idempotencyKey);
  assert.equal(recoveredReadback({ ...current, person: { ...current.person, id: "sam" } }, pending), null);
  assert.equal(recoveredReadback({ ...current, acknowledgments: current.acknowledgments.map(ack => ({ ...ack, attribution: "legacy_record" as const, commandId: null })) }, pending), null);
});
test("new published context requires new review and cannot reuse old change confirmations", () => {
  const { data } = personal();
  assert.throws(() => queueReadback(data, [], false), /every changed/);
  const reviewed = { ...data, sheet: { ...data.sheet, version: data.sheet.version + 1, digest: "f".repeat(64), changes: [{ taskId: "new-personal-call", name: "Revised call", before: "19:00", after: "19:10", reason: "New publication" }] } };
  const oldSeen = data.sheet.changes.map(change => change.taskId);
  assert.throws(() => queueReadback(reviewed, oldSeen, false), /every changed/);
  assert.equal(sameReview(data.review, { ...data.review!, sheetVersion: reviewed.sheet.version, sheetDigest: reviewed.sheet.digest }), false);
  for (const changed of [{ policyVersion: data.review!.policyVersion + 1 }, { planDigest: "e".repeat(64) }, { planVersion: data.review!.planVersion + 1 }]) assert.equal(sameReview(data.review, { ...data.review!, ...changed }), false);
});
test("storage failures and malformed queues fail before a new command can leave without its recovery identity", () => {
  const storage = new MemoryStorage(), fingerprint = "e".repeat(64);
  storage.setItem(storageKeys(fingerprint).outbox, "invalid"); assert.throws(() => readOutbox(storage, fingerprint), /could not be verified/);
  assert.throws(() => saveOutbox({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined }, emptyOutbox(fingerprint)), /retain the readback identity/);
  assert.throws(() => saveOutbox({ getItem: () => null, setItem: () => { throw new Error("Quota exceeded"); }, removeItem: () => undefined }, emptyOutbox(fingerprint)), /Quota exceeded/);
});
test("uncertain live actions persist one exact reviewed envelope and never become offline readbacks", () => {
  const { data } = personal(), storage = new MemoryStorage(), fingerprint = "f".repeat(64);
  const envelope = { idempotencyKey: randomUUID(), expectedRevision: data.show.revision, command: { type: "attest" as const, kind: "cue_signed_off" as const, review: data.review!, detail: "Reviewed cue checks in the controlled fixture.", confirmed: true as const } };
  saveOutbox(storage, { ...emptyOutbox(fingerprint), live: { personId: data.person.id, createdAt: new Date().toISOString(), envelope } });
  assert.deepEqual(readOutbox(storage, fingerprint).live!.envelope, envelope); assert.equal(readOutbox(storage, fingerprint).readbacks.length, 0);
});
test("upgrade removes the broad legacy cache but preserves unbound drafts without inventing a replay identity", async () => {
  const storage = new MemoryStorage(), token = randomBytes(32).toString("base64url"), fingerprint = await capabilityFingerprint(token);
  const oldCache = `opening-night-sheet:${token.slice(0, 16)}`, oldPending = `opening-night-pending:${token.slice(0, 16)}`;
  storage.setItem(oldCache, JSON.stringify({ show: { resources: ["all crew"], financialEvidence: ["private provider data"] } }));
  const rawDraft = JSON.stringify({ sheetVersion: 2, sheetDigest: "c".repeat(64), seenTaskIds: ["focus"] });
  storage.setItem(oldPending, rawDraft);
  const retained = retireLegacyCrewStorage(storage, token, fingerprint);
  assert.equal(storage.getItem(oldCache), null); assert.equal(storage.getItem(oldPending), null);
  assert.equal(retained?.rawDraft, rawDraft); assert.equal(retained?.capabilityFingerprint, fingerprint);
  assert.deepEqual(retireLegacyCrewStorage(storage, token, fingerprint), retained);
  assert.equal(readOutbox(storage, fingerprint).readbacks.length, 0);
  assert.equal(JSON.stringify([...storage.data]).includes("private provider data"), false);
  assert.equal(JSON.stringify([...storage.data]).includes(token), false);
});
test("legacy draft preservation failure never drops the original pending review", () => {
  const storage = new MemoryStorage(), token = "d".repeat(43), fingerprint = "e".repeat(64), oldKey = `opening-night-pending:${token.slice(0, 16)}`;
  storage.setItem(oldKey, "{malformed older draft");
  const blocked = { getItem: (key: string) => storage.getItem(key), setItem: () => { throw new Error("Quota exceeded"); }, removeItem: (key: string) => storage.removeItem(key) };
  assert.throws(() => retireLegacyCrewStorage(blocked, token, fingerprint), /Quota exceeded/);
  assert.equal(storage.getItem(oldKey), "{malformed older draft");
  assert.equal(retireLegacyCrewStorage(storage, token, fingerprint)?.rawDraft, "{malformed older draft");
});
