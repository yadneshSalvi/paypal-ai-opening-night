import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { newPendingSettlement, parsePendingSettlement, recoveredSettlement, settlementDataMatches, settlementStorageKey, settlementRequestDigest, definiteSettlementRejection } from "../src/components/settlement/recovery";
import { digest } from "../src/domain/hash";
import { personSettlement, settlementReceipt } from "../src/domain/settlement/commands";
import type { PersonalSettlementData } from "../src/domain/settlement/contracts";
import { settlementFixture } from "./settlement-fixtures";

test("saved settlement recovery binds exact actor, person, scope and typed original envelope", async () => {
  const value = settlementFixture(), identity = { scope: "personal" as const, actorId: value.crew.id, ownerId: "priya" };
  const envelope = { idempotencyKey: randomUUID(), expectedRevision: 0, expectedShowRevision: value.show.revision, command: value.report() }, pending = await newPendingSettlement(identity, envelope), raw = JSON.stringify(pending);
  assert.deepEqual(await parsePendingSettlement(raw, identity), pending);
  for (const other of [{ ...identity, actorId: "crew:priya:other" }, { ...identity, ownerId: "sam" }, { ...identity, scope: "production" as const }]) {
    assert.notEqual(settlementStorageKey(identity), settlementStorageKey(other)); await assert.rejects(() => parsePendingSettlement(raw, other));
  }
  await assert.rejects(() => parsePendingSettlement(JSON.stringify({ ...pending, envelope: { ...envelope, command: value.rate() } }), identity));
  await assert.rejects(() => parsePendingSettlement(JSON.stringify({ ...pending, envelope: { ...envelope, command: { ...envelope.command, detail: "Changed after the exact review was saved." } } }), identity), /instructions changed/);
  await assert.rejects(() => parsePendingSettlement("x".repeat(25001), identity)); await assert.rejects(() => parsePendingSettlement("{", identity));
});
test("browser request identity matches the server canonical digest and covers the entire instruction", async () => {
  const value = settlementFixture(), envelope = { idempotencyKey: randomUUID(), expectedRevision: 0, expectedShowRevision: value.show.revision, command: value.report() };
  assert.equal(await settlementRequestDigest(envelope), digest(envelope));
  assert.equal(await settlementRequestDigest({ command: envelope.command, expectedShowRevision: envelope.expectedShowRevision, expectedRevision: 0, idempotencyKey: envelope.idempotencyKey }), digest(envelope));
  assert.notEqual(await settlementRequestDigest({ ...envelope, expectedShowRevision: envelope.expectedShowRevision + 1 }), digest(envelope));
  assert.notEqual(await settlementRequestDigest({ ...envelope, command: { ...envelope.command, detail: "Different reviewed instructions under the original identity." } }), digest(envelope));
});
test("only an attributed receipt for the original full command resolves an uncertain request", async () => {
  const value = settlementFixture(), identity = { scope: "personal" as const, actorId: value.crew.id, ownerId: "priya" };
  const envelope = { idempotencyKey: randomUUID(), expectedRevision: 0, expectedShowRevision: value.show.revision, command: value.report() }, pending = await newPendingSettlement(identity, envelope), record = value.apply(value.report());
  const data: PersonalSettlementData = { schemaVersion: 1, scope: "personal", actorId: value.crew.id, revision: 1, productionRevision: value.show.revision, serverAt: new Date().toISOString(), production: { title: value.show.title, showDate: value.show.showDate, zone: value.show.zone, clock: value.show.clock, allowedDays: [value.show.showDate], sheet: null }, controlledQa: true, paymentCapability: "separate_payout_review_required", personal: personSettlement(value.show, value.state, "priya"), receipts: [settlementReceipt(record)] };
  assert.equal(settlementDataMatches(data, identity), true); assert.equal(recoveredSettlement(data, pending), null);
  assert.equal(recoveredSettlement({ ...data, receipts: [{ ...data.receipts[0], commandId: envelope.idempotencyKey }] }, pending), null);
  const exact = { ...data, receipts: [{ ...data.receipts[0], commandId: envelope.idempotencyKey, requestDigest: pending.requestDigest }] };
  assert.equal(recoveredSettlement(exact, pending)!.id, record.id);
  assert.equal(recoveredSettlement({ ...exact, actorId: "other" }, pending), null);
  assert.equal(recoveredSettlement({ ...exact, receipts: [{ ...exact.receipts[0], actorId: "other" }] }, pending), null);
  assert.equal(recoveredSettlement({ ...exact, receipts: [{ ...exact.receipts[0], requestDigest: "0".repeat(64) }] }, pending), null);
  assert.equal(recoveredSettlement({ ...exact, personal: { ...exact.personal, person: { ...exact.personal.person, id: "sam" } } }, pending), null);
  assert.equal(recoveredSettlement({ ...exact, receipts: [{ ...exact.receipts[0], kind: "rate" }] }, pending), null);
});
test("unknown outcomes and identity conflicts stay recoverable while definite stale refusals can be reviewed afresh", () => {
  for (const status of [202, 401, 408, 429, 500, 502, 503]) assert.equal(definiteSettlementRejection(status, "UNKNOWN"), false);
  assert.equal(definiteSettlementRejection(409, "IDEMPOTENCY_CONFLICT"), false);
  for (const code of ["SETTLEMENT_REVIEW_STALE", "RATE_VERSION_CHANGED", "PAYABLE_REVIEW_CHANGED"]) assert.equal(definiteSettlementRejection(409, code), true);
  assert.equal(definiteSettlementRejection(400, "INVALID_SETTLEMENT_COMMAND"), true);
});
