/** Transport and authority boundaries only; these inputs do not represent paid tickets. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { audienceEnvelopeSchema, type AudienceEnvelope } from "../src/domain/audience/contracts";
import { audienceRecoveryKey, clearAudienceJournal, parseAudienceJournal, prepareAudienceCommand, prepareAudienceWork, retainAudienceJournal } from "../src/components/audience/recovery";

const access = () => ({ tenantId: randomUUID(), actorId: "controlled-contract-input", sessionFingerprint: "a".repeat(64), expiresAt: "2090-01-01T00:00:00.123456Z" });
const envelope = (identity: ReturnType<typeof access>): AudienceEnvelope => ({ commandId: randomUUID(), expectedRevision: 1, sessionFingerprint: identity.sessionFingerprint, sessionExpiresAt: identity.expiresAt, command: { type: "create_invite", ticketId: randomUUID(), receiptDigest: "b".repeat(64), validForMinutes: 60, confirmed: true } });
function storage() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }

test("recovery retains only exact access identity and fixed microsecond expiry, never the complete workspace", async () => {
  const identity = access(), body = envelope(identity), rich = { ...identity, tickets: ["PRIVATE-WORKSPACE-MUST-NOT-BE-RETAINED"], revision: 17 };
  const saved = await prepareAudienceCommand(rich, body), raw = JSON.stringify(saved);
  assert.equal(raw.includes("PRIVATE-WORKSPACE"), false); assert.equal(saved.expiresAt, identity.expiresAt);
  assert.deepEqual(await parseAudienceJournal(raw, identity), saved);
  const narrowed = { ...identity, expiresAt: "2090-01-01T00:00:00.123455Z" };
  assert.equal(Date.parse(identity.expiresAt), Date.parse(narrowed.expiresAt));
  await assert.rejects(parseAudienceJournal(raw, narrowed), /fixed expiry/);
  await assert.rejects(prepareAudienceCommand(narrowed, body), /fixed access expiry/);
});

test("changed retained content, command expiry or foreign identity cannot become an explicit retry", async () => {
  const identity = access(), saved = await prepareAudienceCommand(identity, envelope(identity));
  assert.equal(saved.kind, "command"); if (saved.kind !== "command") return;
  await assert.rejects(parseAudienceJournal(JSON.stringify({ ...saved, envelope: { ...saved.envelope, command: { ...saved.envelope.command, validForMinutes: 61 } } }), identity), /changed after review/);
  await assert.rejects(parseAudienceJournal(JSON.stringify({ ...saved, envelope: { ...saved.envelope, sessionExpiresAt: "2090-01-01T00:00:00.123455Z" } }), identity), /original exact producer access and fixed access expiry/);
  for (const foreign of [{ ...identity, tenantId: randomUUID() }, { ...identity, actorId: "other-producer" }, { ...identity, sessionFingerprint: "c".repeat(64) }]) await assert.rejects(parseAudienceJournal(JSON.stringify(saved), foreign), /different exact producer access/);
  await assert.rejects(parseAudienceJournal("x".repeat(48001), identity), /recovery bound/);
});

test("work recovery binds the original pass and expiry without authorizing a new automatic dispatch", async () => {
  const identity = access(), saved = await prepareAudienceWork(identity, randomUUID(), "d".repeat(64), "e".repeat(64));
  assert.equal(saved.kind, "work"); assert.deepEqual(await parseAudienceJournal(JSON.stringify(saved), identity), saved);
  await assert.rejects(parseAudienceJournal(JSON.stringify({ ...saved, commandId: randomUUID() }), identity), /changed after review/);
  await assert.rejects(parseAudienceJournal(JSON.stringify(saved), { ...identity, expiresAt: "2090-01-01T00:00:00.123455Z" }), /fixed expiry/);
});

test("durable retention refuses overwriting an original instruction and retirement cannot erase a competing file", async () => {
  const identity = access(), first = await prepareAudienceCommand(identity, envelope(identity)), other = await prepareAudienceCommand(identity, envelope(identity)), store = storage();
  const raw = retainAudienceJournal(store, first), key = audienceRecoveryKey(first); assert.equal(store.getItem(key), raw);
  assert.throws(() => retainAudienceJournal(store, other), /Another original instruction/); assert.equal(store.getItem(key), raw);
  store.setItem(key, JSON.stringify(other)); assert.throws(() => clearAudienceJournal(store, first), /changed in another view/); assert.equal(store.getItem(key), JSON.stringify(other));
  clearAudienceJournal(store, other); assert.equal(store.getItem(key), null);
  assert.throws(() => retainAudienceJournal({ ...store, setItem: () => {} }, first), /could not retain/);
});

test("strict commands bound recipients, consent, fixed expiry, content and each delivery pass", () => {
  const identity = access(), common = envelope(identity), draft = { type: "draft_message", kind: "event_update", recipientIds: [randomUUID()], sourceDigest: "f".repeat(64), templateVersion: "audience-v1", note: "Controlled schema input", validForMinutes: 15 };
  assert.equal(audienceEnvelopeSchema.safeParse({ ...common, command: draft }).success, true);
  const bad = [
    { ...common, sessionExpiresAt: undefined },
    { ...common, sessionFingerprint: undefined },
    { ...common, sessionExpiresAt: "not-a-date" },
    { ...common, command: { ...common.command, confirmed: false } },
    { ...common, command: { ...common.command, captureId: "UNTRUSTED-SUPPLIED-CAPTURE" } },
    { ...common, command: { ...draft, recipientIds: [] } },
    { ...common, command: { ...draft, recipientIds: [draft.recipientIds[0], draft.recipientIds[0]] } },
    { ...common, command: { ...draft, recipientIds: Array.from({ length: 401 }, () => randomUUID()) } },
    { ...common, command: { ...draft, note: "x".repeat(1201) } },
    { ...common, command: { ...draft, validForMinutes: 31 } },
    { ...common, command: { type: "deliver_message", approvalId: randomUUID(), approvalDigest: "f".repeat(64), limit: 11, confirmed: true } },
  ];
  for (const value of bad) assert.equal(audienceEnvelopeSchema.safeParse(value).success, false);
});
