import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { digest } from "../src/domain/hash";
import { clearConsent, consentDigest, consentRecoveryKey, matchesConsentReceipt, parsePendingConsent, prepareConsent, producerClientScope, retainConsent, reviewerClientScope } from "../src/components/plan-consents/recovery";
import { consentUiFixture, uiConsentResult, uiInvitation } from "./plan-consents-ui-fixtures";
const memory = () => { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; };

test("canonical consent instructions bind exact original token fingerprint and microsecond expiry", async () => {
  const { workspace } = consentUiFixture(), scope = producerClientScope(workspace), command = uiInvitation(workspace), pending = await prepareConsent(scope, command);
  assert.equal(pending.requestDigest, digest(command)); assert.deepEqual(await parsePendingConsent(JSON.stringify(pending), scope), pending);
  for (const changed of [{ ...scope, id: "different-actor" }, { ...scope, fingerprint: "f".repeat(64) }, { ...scope, expiresAt: scope.expiresAt.replace(/000Z$/, "001Z") }, { ...scope, tenantId: randomUUID() }]) await assert.rejects(parsePendingConsent(JSON.stringify(pending), changed), /different original/);
  await assert.rejects(prepareConsent({ ...scope, fingerprint: "f".repeat(64) }, command), /different original/);
});
test("changed bytes, unknown authority fields and normalization cannot silently alter a saved instruction", async () => {
  const { workspace } = consentUiFixture(), scope = producerClientScope(workspace), command = uiInvitation(workspace), pending = await prepareConsent(scope, command);
  const changed = { ...command, expectedRevision: command.expectedRevision + 1 };
  await assert.rejects(parsePendingConsent(JSON.stringify({ ...pending, envelope: changed }), scope), /changed after review/);
  for (const body of [{ ...command, verifiedConsent: true }, { ...command, command: { ...command.command, representativeName: " Controlled Representative " } }]) await assert.rejects(parsePendingConsent(JSON.stringify({ ...pending, envelope: body, requestDigest: await consentDigest(body) }), scope));
  await assert.rejects(parsePendingConsent(" ".repeat(26001), scope), /recovery limit/);
});
test("browser storage must retain exact bytes and cannot replace or clear another pending instruction", async () => {
  const { workspace } = consentUiFixture(), scope = producerClientScope(workspace), saved = await prepareConsent(scope, uiInvitation(workspace)), other = await prepareConsent(scope, uiInvitation(workspace)), storage = memory();
  retainConsent(storage, saved); retainConsent(storage, saved); assert.equal(storage.getItem(consentRecoveryKey(scope)), JSON.stringify(saved));
  assert.throws(() => retainConsent(storage, other), /earlier instruction/); assert.throws(() => clearConsent(storage, other), /Another view/);
  assert.throws(() => retainConsent({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined }, saved), /could not retain/);
  assert.throws(() => clearConsent({ ...storage, removeItem: () => undefined }, saved), /could not retire/); clearConsent(storage, saved); assert.equal(storage.values.size, 0);
});
test("a receipt must preserve body digest, action, original scope, expiry and request identity", async () => {
  const { workspace } = consentUiFixture(), instruction = uiInvitation(workspace), pending = await prepareConsent(producerClientScope(workspace), instruction), saved = await uiConsentResult(workspace, instruction);
  assert.equal(await matchesConsentReceipt(saved, pending), true);
  for (const receipt of [{ ...saved.receipt, commandId: randomUUID() }, { ...saved.receipt, scopeId: "f".repeat(64) }, { ...saved.receipt, action: "revoke" }, { ...saved.receipt, expiresAt: saved.receipt.expiresAt.replace(/000Z$/, "001Z") }, { ...saved.receipt, result: { ...saved.receipt.result, message: "Changed message" } }]) assert.equal(await matchesConsentReceipt({ ...saved, receipt }, pending), false);
});
test("reviewer records and receipts cannot be confused with the producer or another artist decision", async () => {
  const { workspace, reader } = consentUiFixture(), scope = reviewerClientScope(reader);
  const command = { version: 1 as const, commandId: randomUUID(), requestId: reader.review.requestId, reviewDigest: reader.reviewDigest, expiresAt: reader.review.expiresAt, capabilityFingerprint: reader.capabilityFingerprint, decision: "approve" as const, declaredName: reader.review.representative.invitedName, authorityConfirmed: true as const, contentReviewed: true as const, statement: "Reviewed this exact controlled proposal without asserting real identity." };
  const saved = await prepareConsent(scope, command), result = await uiConsentResult(reader, command);
  assert.equal(await matchesConsentReceipt(result, saved), true); await assert.rejects(parsePendingConsent(JSON.stringify(saved), producerClientScope(workspace)), /different original/);
  const decision = { ...result.receipt.result.decision!, decision: "decline" as const }, forged = { ...result.receipt, result: { ...result.receipt.result, decision } }, { receiptDigest: _old, ...content } = forged;
  assert.equal(await matchesConsentReceipt({ receipt: { ...content, receiptDigest: await consentDigest(content) }, replayed: true }, saved), false);
});
