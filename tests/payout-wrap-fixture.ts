import { randomUUID } from "node:crypto";
import type { PayoutBatchObservation, PayoutItemObservation } from "@fracture/paypal-core";
import { digest } from "../src/domain/hash";
import type { PayoutGrant, PayoutRecord, PayoutState, RecipientAdmission, PayoutResult } from "../src/domain/payouts/contracts";
import { payoutPeople, payoutPersonDigest, payoutReview } from "../src/domain/payouts/policy";
import { projectPayoutEvidence } from "../src/server/payouts/projection";
import type { PayoutPayload } from "../src/server/payouts/store";
import { settlementFixture } from "./settlement-fixtures";
export function payoutWrapFixture(actualTransport = false) {
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