import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PayoutBatchObservation, PayoutItemObservation } from "@fracture/paypal-core";
import { digest } from "../src/domain/hash";
import { financialSummary } from "../src/domain/finance";
import { payoutEnvelopeSchema, type PayoutGrant, type PayoutRecord, type PayoutState, type RecipientAdmission, type PayoutResult, type PayoutData } from "../src/domain/payouts/contracts";
import { PAYOUT_READ_FRESH_MS, payoutGrantView, payoutPeople, payoutPersonDigest, payoutReview, validatePayoutBatch, validatePayoutItem } from "../src/domain/payouts/policy";
import { projectPayoutEvidence } from "../src/server/payouts/projection";
import type { PayoutPayload } from "../src/server/payouts/store";
import { newPendingPayout, parsePendingPayout, recoveredPayout, payoutStorageKey, definitePayoutRejection } from "../src/components/payouts/recovery";
import { settlementFixture } from "./settlement-fixtures";

function fixture(actualTransport = false) {
  const work = settlementFixture(); work.apply(work.rate()); const report = work.apply(work.report()); work.apply(work.approve(report.id));
  let show = work.show, state: PayoutState = { schemaVersion: 1, revision: 0, records: [] };
  const person = show.resources.find(person => person.id === "priya")!, merchant = "a".repeat(64), time = new Date().toISOString();
  const rawAdmission = { id: "owned-controlled-priya", tenantId: show.tenantId, personId: person.id, label: "Controlled Priya account", recipientType: "EMAIL" as const, receiver: "priya.controlled@payout.invalid", merchantFingerprint: merchant, expiresAt: new Date(Date.now() + 86400000).toISOString(), maxPayoutMinor: 50000, controlledSandbox: true as const };
  const admission: RecipientAdmission = { ...rawAdmission, digest: digest(rawAdmission) };
  function append(payload: PayoutPayload) {
    const record = { ...payload, id: randomUUID(), commandId: randomUUID(), requestDigest: digest(payload), actorId: work.producer.id, recordedAt: time, revision: state.revision + 1, productionRevision: show.revision + 1 } as PayoutRecord;
    state = { ...state, revision: record.revision, records: [...state.records, record] }; show = projectPayoutEvidence({ ...show, revision: record.productionRevision, payoutVersion: state.revision }, state, record); return record;
  }
  append({ kind: "recipient", personId: person.id, personName: person.name, personDigest: payoutPersonDigest(person), version: 1, previousId: null, admission, detail: "Exact controlled recipient reviewed in this domain fixture." });
  const people = () => payoutPeople(show, work.state, state, [admission], merchant), review = payoutReview(show, work.state, state, people(), ["priya"], merchant), items = review.items.map(item => ({ ...item, senderItemId: randomUUID() }));
  const grant = append({ kind: "grant", merchantFingerprint: merchant, expiresAt: new Date(Date.now() + 600000).toISOString(), settlementRevision: work.state.revision, reviewDigest: review.digest, detail: "Domain-only financial projection fixture.", authority: { actor: work.producer, sessionHash: "b".repeat(64) }, items, request: { requestId: randomUUID(), senderBatchId: "domain-fixture-batch", items } }) as PayoutGrant;
  append({ kind: "dispatch", grantId: grant.id, providerRequestDigest: digest(grant.request) });
  const item: PayoutItemObservation = { ...items[0], id: "ITEM-CONTROLLED-1", batchId: "BATCH-CONTROLLED-1", status: "SUCCESS", transactionId: "TX-CONTROLLED-1", fee: { currency: "USD", minor: 25 }, processedAt: time };
  const batch: PayoutBatchObservation = { id: item.batchId, senderBatchId: grant.request.senderBatchId, status: "SUCCESS", money: { currency: "USD", minor: 3500 }, estimatedFees: { currency: "USD", minor: 25 }, items: [item], complete: true };
  function result<T>(value: T): PayoutResult<T> { return { outcome: "succeeded", value, recovered: false, httpStatus: 200, debugId: "controlled-domain", observedAt: time, source: actualTransport ? "live_sandbox" : "sample", transport: actualTransport ? "paypal_https" : "local_fixture" }; }
  const readBatch = (verified = true) => append({ kind: "batch_read", grantId: grant.id, result: result(batch), verified, problem: verified ? null : "CONTROLLED_INCOMPLETE_BATCH" });
  const readItem = (status = "SUCCESS", verified = true, fee: PayoutItemObservation["fee"] = item.fee) => append({ kind: "item_read", grantId: grant.id, senderItemId: item.senderItemId, result: result({ ...item, status, fee }), verified, problem: verified ? null : "CONTROLLED_UNKNOWN_ITEM" });
  return { work, get show() { return show; }, get state() { return state; }, grant, item, batch, people, append, result, readBatch, readItem, admission, merchant };
}
test("pure projection keeps historical success while a newer batch or adverse item withdraws current proof", () => {
  // These are typed domain inputs, not real provider observations or persisted financial evidence.
  const value = fixture(true); value.readBatch(); assert.equal(financialSummary(value.show).crewPaidMinor, 0); value.readItem();
  assert.equal(financialSummary(value.show).crewPaidMinor, 3500); assert.equal(financialSummary(value.show).crewHistoricalPaidMinor, 3500);
  value.readBatch(false); assert.equal(financialSummary(value.show).crewPaidMinor, 0); assert.equal(financialSummary(value.show).crewHistoricalPaidMinor, 3500);
  value.readBatch(); value.readItem(); assert.equal(financialSummary(value.show).crewPaidMinor, 3500); assert.equal(value.show.financialEvidence.length, 1);
  value.readItem("REVERSED"); assert.equal(financialSummary(value.show).crewPaidMinor, 0); assert.equal(financialSummary(value.show).crewHistoricalPaidMinor, 3500); assert.equal(value.show.financialEvidence.length, 1);
  // Same-millisecond reads are ordered by their retained revision, not array accident.
  assert.equal(new Set(value.show.financialObservations!.map(item => item.observedAt)).size, 1);
  assert.equal(value.people().find(person => person.person.id === "priya")!.availableMinor, 3500);
});
test("controlled reads never enter actual money and omitted fees stay unknown", () => {
  const value = fixture(); value.readBatch(); value.readItem("SUCCESS", true, null);
  const view = payoutGrantView(value.show, value.state, value.grant); assert.equal(view.items[0].currentVerified, true); assert.equal(view.items[0].feeMinor, null); assert.equal(value.show.financialEvidence.length, 0); assert.equal(financialSummary(value.show).crewPaidMinor, 0);
  value.readItem("SUCCESS", false); assert.equal(payoutGrantView(value.show, value.state, value.grant).items[0].status, "UNKNOWN"); assert.equal(value.people().find(person => person.person.id === "priya")!.preview, null);
});
test("complete collection, exact recipients, amounts, parents and known status are mandatory", () => {
  const value = fixture(); assert.equal(validatePayoutBatch(value.grant, value.batch, value.batch.id), null); assert.equal(validatePayoutItem(value.grant, value.item.senderItemId, value.item, value.batch), null);
  for (const invalid of [{ ...value.batch, complete: false }, { ...value.batch, senderBatchId: "foreign" }, { ...value.batch, money: { currency: "USD", minor: 3499 } }, { ...value.batch, items: [value.item, value.item] }, { ...value.batch, status: "UNKNOWN_FUTURE_STATUS" }, { ...value.batch, items: [{ ...value.item, receiver: "other.controlled@payout.invalid" }] }]) assert.ok(validatePayoutBatch(value.grant, invalid, value.batch.id));
  for (const invalid of [{ ...value.item, batchId: "foreign" }, { ...value.item, id: "foreign" }, { ...value.item, status: "UNKNOWN_FUTURE_STATUS" }, { ...value.item, fee: { currency: "USD", minor: -1 } }, { ...value.item, money: { currency: "USD", minor: 3501 } }, { ...value.item, processedAt: "not-a-date" }]) assert.ok(validatePayoutItem(value.grant, value.item.senderItemId, invalid, value.batch));
});
test("an approved credit below an already-paid allocation is a visible hold, never an automatic deduction", () => {
  const value = fixture(); value.readBatch(); value.readItem();
  const original = value.work.state.records.find(record => record.kind === "time_report")!;
  const corrected = value.work.apply(value.work.report({ replacesId: original.id, intervals: [{ start: "2026-11-14T11:30:00-06:00", end: "2026-11-14T12:00:00-06:00", unpaidMinutes: 0 }] })); value.work.apply(value.work.approve(corrected.id));
  const person = payoutPeople(value.show, value.work.state, value.state, [value.admission], value.merchant).find(person => person.person.id === "priya")!;
  assert.equal(person.liabilityMinor, 1750); assert.equal(person.allocatedMinor, 3500); assert.equal(person.availableMinor, 0); assert.ok(person.blockers.some(reason => reason.includes("no automatic deduction"))); assert.equal(person.preview, null);
});
test("a new payout cannot use stale earlier-item evidence, an expired admission or altered roster", () => {
  const value = fixture(); value.readBatch(); value.readItem("RETURNED");
  const later = Date.now() + PAYOUT_READ_FRESH_MS + 1000;
  assert.ok(payoutPeople(value.show, value.work.state, value.state, [value.admission], value.merchant, later).find(person => person.person.id === "priya")!.blockers.some(reason => reason.includes("Refresh")));
  const changed = { ...value.show, resources: value.show.resources.map(person => person.id === "priya" ? { ...person, name: "Different roster identity" } : person) };
  assert.equal(payoutPeople(changed, value.work.state, value.state, [value.admission], value.merchant).find(person => person.person.id === "priya")!.preview, null);
  assert.equal(payoutPeople(value.show, value.work.state, value.state, [{ ...value.admission, expiresAt: "2020-01-01T00:00:00Z" }], value.merchant).find(person => person.person.id === "priya")!.preview, null);
});
test("recovery normalizes notes and UUIDs before hashing, then binds actor, production and full receipt", async () => {
  const value = fixture(), identity = { scope: "production" as const, actorId: value.work.producer.id, ownerId: value.show.tenantId }, envelope = { idempotencyKey: randomUUID().toUpperCase(), expectedRevision: 1, expectedSettlementRevision: 3, expectedShowRevision: 5, command: { type: "revoke_payout" as const, grantId: value.grant.id.toUpperCase(), detail: "  Exact original reviewed instruction. \n", confirmed: true as const } }, raw = JSON.stringify(envelope);
  const pending = await newPendingPayout(identity, envelope); assert.equal(pending.requestDigest, digest(payoutEnvelopeSchema.parse(envelope))); assert.equal(pending.envelope.command.type === "revoke_payout" && pending.envelope.command.detail, "Exact original reviewed instruction."); assert.equal(JSON.stringify(envelope), raw); assert.deepEqual(await parsePendingPayout(JSON.stringify(pending), identity), pending);
  await assert.rejects(parsePendingPayout(JSON.stringify({ ...pending, envelope: { ...pending.envelope, expectedSettlementRevision: 4 } }), identity), /changed after review/);
  await assert.rejects(parsePendingPayout(JSON.stringify(pending), { ...identity, ownerId: randomUUID() })); await assert.rejects(parsePendingPayout(JSON.stringify(pending), { ...identity, actorId: "another-producer" })); assert.notEqual(payoutStorageKey(identity), payoutStorageKey({ ...identity, ownerId: randomUUID() }));
  await assert.rejects(parsePendingPayout("x".repeat(25001), identity));
  const receipt = { id: randomUUID(), commandId: pending.envelope.idempotencyKey, actorId: identity.actorId, requestDigest: pending.requestDigest, kind: "grant_revoked" as const, recordedAt: new Date().toISOString(), digest: "c".repeat(64) };
  const data = { schemaVersion: 1, scope: "production", actorId: identity.actorId, tenantId: identity.ownerId, revision: 2, settlementRevision: 3, productionRevision: 6, receipts: [receipt] } as PayoutData;
  assert.deepEqual(recoveredPayout(data, pending), receipt); assert.equal(recoveredPayout({ ...data, receipts: [{ ...receipt, requestDigest: "d".repeat(64) }] }, pending), null); assert.equal(recoveredPayout({ ...data, receipts: [{ ...receipt, kind: "grant" }] }, pending), null); assert.equal(recoveredPayout({ ...data, actorId: "other" }, pending), null);
});
test("uncertain write responses preserve recovery; strict review requests accept no caller amount or receiver", () => {
  for (const status of [401, 408, 429, 500, 502, 503]) assert.equal(definitePayoutRejection(status, "UNKNOWN"), false); assert.equal(definitePayoutRejection(409, "IDEMPOTENCY_CONFLICT"), false); assert.equal(definitePayoutRejection(409, "PAYOUT_REVIEW_STALE"), true);
  const envelope = { idempotencyKey: randomUUID(), expectedRevision: 0, expectedSettlementRevision: 0, expectedShowRevision: 1, command: { type: "approve_payout", personIds: ["priya"], reviewDigest: "a".repeat(64), detail: "Review the exact approved liability and recipient.", reviewedAmounts: true, reviewedRecipients: true, reviewedCredits: true, reviewedFees: true } };
  assert.equal(payoutEnvelopeSchema.safeParse(envelope).success, true);
  for (const extra of [{ amountMinor: 1 }, { receiver: "caller@payout.invalid" }, { reviewedCredits: false }, { reviewedFees: false }]) assert.equal(payoutEnvelopeSchema.safeParse({ ...envelope, command: { ...envelope.command, ...extra } }).success, false);
});
