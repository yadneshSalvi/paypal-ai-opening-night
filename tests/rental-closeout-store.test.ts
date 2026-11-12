/** Controlled installed-SDK verification; no actual provider or physical qualification. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { currentActual, financialSummary, uniqueActual } from "../src/domain/finance";
import type { Actor } from "../src/domain/contracts";
import { rentalExecutionDigest } from "../src/domain/rental-closeout";
import { rentalHarness } from "./rental-closeout-harness";
const h = await rentalHarness(); after(h.close);
const origin = process.env.APP_BASE_URL ?? "http://127.0.0.1:4580";
async function capability(actor: Actor) {
  const token = randomBytes(32).toString("base64url"), authority = { actor, sessionHash: h.sessionTokenHash(token) };
  await h.database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [authority.sessionHash, actor.tenantId, actor]);
  return authority;
}

test("historical accepted rental returns after a replacement snapshot and closes only its original residual hold", async () => {
  const value = await h.accepted(), before = await h.store.getShow(value.actor.tenantId), writes = h.wire.voids().length;
  const returned = await h.returned(value), originalReturn = returned.workspace.rentals[0]!.returns[0]!;
  assert.equal(originalReturn.planVersion, value.original.planVersion); assert.equal(returned.workspace.rentals[0]!.currentPlan, false);
  assert.equal(originalReturn.source, "attributed_controlled_supplier"); assert.equal(h.wire.voids().length, writes);
  const approved = await h.approve(value);
  assert.equal(approved.intent.planVersion, value.original.planVersion); assert.equal(approved.intent.planDigest, value.original.approvedPlan!.digest);
  assert.equal(approved.intent.parentId, value.root.id); assert.equal(approved.intent.rentalReturnId, originalReturn.id);
  assert.equal(approved.intent.approvedSessionHash, value.authority.sessionHash); assert.equal(approved.intent.command.approval.expiresAt, approved.grant.expiresAt);
  assert.equal(approved.preview.acceptedFeeMinor, 48000); assert.equal(approved.preview.residualMinor, 30000);
  assert.equal((await h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "dispatch")).status, "complete");
  assert.equal((await h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "readback")).status, "complete");
  assert.equal(h.wire.voids().length, writes + 1); assert.ok(h.wire.voids().at(-1)!.durable); assert.equal(h.wire.voids().at(-1)!.requestId, approved.intent.command.providerRequestId);
  const final = await h.store.getShow(value.actor.tenantId), finance = financialSummary(final), desk = await h.service.readCloseoutWorkspace(value.authority);
  assert.equal(finance.rentalCapturedMinor, 48000); assert.equal(finance.releasedMinor, 30000); assert.equal(finance.remainingRentalAuthorizationMinor, 0);
  assert.equal(final.planVersion, before.planVersion); assert.deepEqual(final.approvedPlan, before.approvedPlan); assert.deepEqual(final.tasks, before.tasks); assert.deepEqual(final.crewAttestations, before.crewAttestations);
  assert.ok(!final.facts.some(fact => fact.kind === "return_accepted" && fact.planVersion === final.planVersion));
  assert.equal(final.financialEvidence.filter(item => item.kind === "refund" && item.purpose === "rental").length, 0);
  assert.equal(desk.rentals[0]!.closeout!.state, "complete"); assert.equal(desk.rentals[0]!.historicalFeeMinor, 48000); assert.equal(desk.rentals[0]!.releasedMinor, 30000);
});
test("current rentals remain in use until scheduled return; modern reviews cannot use the legacy release path", async () => {
  const value = await h.accepted({ replacePlan: false });
  const desk = await h.service.readCloseoutWorkspace(value.supplierAuthority); assert.equal(desk.rentals[0]!.canRecordReturn, false); assert.match(desk.rentals[0]!.returnBlocker!, /still in use/);
  await assert.rejects(() => h.returned(value), /still in use/);
  await h.command(value.actor, { type: "advance", time: "23:30" });
  await h.returned(value); const beforeApproval = await h.store.getShow(value.actor.tenantId);
  await assert.rejects(() => h.paymentService.handlePayment(value.actor, { type: "release_rental_hold", intentId: value.root.id, expectedRevision: beforeApproval.revision }, origin), { code: "RENTAL_CLOSEOUT_REVIEW_REQUIRED" });
  const approved = await h.approve(value), show = await h.store.getShow(value.actor.tenantId);
  await assert.rejects(() => h.paymentService.handlePayment(value.actor, { type: "release_rental_hold", intentId: value.root.id, expectedRevision: show.revision }, origin), /different exact session|different retained approval/);
  assert.equal((await h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "dispatch")).status, "complete");
});
test("damage retains original observations and requires a corrected undamaged inspection before review", async () => {
  const value = await h.accepted(); const damage = await h.returned(value, "damage_reported");
  let preview = await h.service.previewRentalCloseout(value.authority, value.executionId, damage.workspace.revision); assert.equal(preview.ready, false); assert.match(preview.blockers.join(" "), /reported damage/);
  const corrected = await h.returned(value); const rental = corrected.workspace.rentals[0]!;
  assert.equal(rental.returns.length, 2); assert.equal(rental.returns[0]!.condition, "damage_reported"); assert.equal(rental.returns[1]!.previousId, rental.returns[0]!.id);
  preview = await h.service.previewRentalCloseout(value.authority, value.executionId, corrected.workspace.revision); assert.equal(preview.ready, true);
  await assert.rejects(() => h.database.pool.query("UPDATE on_rental_return_records SET digest='changed' WHERE tenant_id=$1", [value.actor.tenantId]), /immutable/);
  const execution = (await h.store.getShow(value.actor.tenantId)).rentalExecutions![0]!; assert.equal(rental.executionDigest, rentalExecutionDigest(execution));
});
test("a later damage observation invalidates an unused exact approval without erasing its original return", async () => {
  const value = await h.accepted(); await h.returned(value); const approved = await h.approve(value), writes = h.wire.voids().length;
  await h.returned(value, "damage_reported");
  await assert.rejects(() => h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "dispatch"), /original accepted unit|return or producer/);
  assert.equal(h.wire.voids().length, writes); assert.equal((await h.service.readCloseoutWorkspace(value.authority)).rentals[0]!.returns.length, 2);
});
test("exact command recovery is idempotent, body-bound, session-bound and immutable", async () => {
  const value = await h.accepted(), desk = await h.service.readCloseoutWorkspace(value.supplierAuthority), rental = desk.rentals[0]!;
  const envelope = { commandId: randomUUID(), expectedRevision: desk.revision, command: { type: "record_return" as const, executionId: rental.id, executionDigest: rental.executionDigest, previousInspectionId: null, observedAt: new Date().toISOString(), condition: "undamaged" as const, detail: "Controlled exact original-unit inspection for request recovery verification.", confirmed: true as const } };
  const [first, duplicate] = await Promise.all([h.service.executeCloseoutCommand(value.supplierAuthority, envelope), h.service.executeCloseoutCommand(value.supplierAuthority, envelope)]);
  assert.equal(Number(first.replayed) + Number(duplicate.replayed), 1); assert.deepEqual(first.receipt, duplicate.receipt);
  assert.deepEqual(await h.service.findCloseoutReceipt(value.supplierAuthority, envelope.commandId), first.receipt);
  await assert.rejects(() => h.service.executeCloseoutCommand(value.supplierAuthority, { ...envelope, command: { ...envelope.command, detail: "Changed instructions cannot reuse the original identity." } }), /different terms/);
  const newToken = randomBytes(32).toString("base64url"), other = { actor: value.supplierAuthority.actor, sessionHash: h.sessionTokenHash(newToken) };
  await h.database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [other.sessionHash, other.actor.tenantId, other.actor]);
  await assert.rejects(() => h.service.findCloseoutReceipt(other, envelope.commandId), /No saved receipt/);
  await assert.rejects(() => h.service.executeCloseoutCommand(other, envelope), /different exact capability/);
  await assert.rejects(() => h.database.pool.query("DELETE FROM on_rental_closeout_commands WHERE tenant_id=$1", [value.actor.tenantId]), /immutable/);
});
test("a source or revision change invalidates the exact preview before any grant is saved", async () => {
  const value = await h.accepted(); await h.returned(value);
  const before = await h.store.getShow(value.actor.tenantId), preview = await h.service.previewRentalCloseout(value.authority, value.executionId, before.revision);
  await h.command(value.actor, { type: "advance", time: "17:20" });
  await assert.rejects(() => h.act(value.authority, { type: "approve_closeout", executionId: value.executionId, previewDigest: preview.digest, detail: "The old review must not authorize a current changed production.", confirmed: true }), /fresh exact preview/);
  assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_rental_closeout_grants WHERE tenant_id=$1", [value.actor.tenantId])).rows[0].count), 0);
});
test("a fresh extra provider capture blocks closure even when local fee and preview remain unchanged", async () => {
  const value = await h.accepted(); await h.returned(value); const approved = await h.approve(value), writes = h.wire.voids().length;
  h.wire.orders.get(value.orderId)!.purchase_units[0].payments.captures.push({ id: "CONTROLLED-EXTRA-CAPTURE", status: "PENDING", amount: { currency_code: "USD", value: "1.00" } });
  await assert.rejects(() => h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "dispatch"), /remaining amount changed/);
  assert.equal(h.wire.voids().length, writes); assert.equal(financialSummary(await h.store.getShow(value.actor.tenantId)).releasedMinor, 0);
});
test("an intervening capture after void prevents a fabricated full residual release", async () => {
  const value = await h.accepted(); await h.returned(value); const approved = await h.approve(value), writes = h.wire.voids().length;
  h.wire.afterVoid = () => { h.wire.afterVoid = null; h.wire.orders.get(value.orderId)!.purchase_units[0].payments.captures.push({ id: "CONTROLLED-CAPTURE-BETWEEN-READS", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }); };
  await assert.rejects(() => h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "dispatch"), /not counted as released/);
  assert.equal(h.wire.voids().length, writes + 1); assert.equal(financialSummary(await h.store.getShow(value.actor.tenantId)).releasedMinor, 0);
  const desk = await h.service.readCloseoutWorkspace(value.authority); assert.equal(desk.rentals[0]!.closeout!.state, "needs_attention"); assert.equal(desk.rentals[0]!.closeout!.code, "CLOSURE_CURRENT_READ_REQUIRED");
  await assert.rejects(() => h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "readback"), /not counted as released/);
  assert.equal(h.wire.voids().length, writes + 1);
});
test("lost void response recovers the same original operation without another write", async () => {
  const value = await h.accepted(); await h.returned(value); const approved = await h.approve(value), writes = h.wire.voids().length; h.wire.voidFault = "lost";
  await h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "dispatch");
  assert.equal((await h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "readback")).status, "complete");
  assert.equal(h.wire.voids().length, writes + 1); assert.equal(financialSummary(await h.store.getShow(value.actor.tenantId)).releasedMinor, 30000);
});
test("a stopped original approval cannot dispatch or be replaced; readback stays available", async () => {
  const value = await h.accepted(); await h.returned(value); const approved = await h.approve(value), writes = h.wire.voids().length;
  await h.act(value.authority, { type: "stop_closeout", grantId: approved.grant.id, detail: "Producer stopped this unused original authority for a separate review.", confirmed: true });
  await assert.rejects(() => h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "dispatch"), /cannot start another write/);
  assert.equal(h.wire.voids().length, writes); const desk = await h.service.readCloseoutWorkspace(value.authority); assert.equal(desk.rentals[0]!.closeout!.state, "stopped"); assert.equal(desk.rentals[0]!.canReviewClosure, false);
  const read = await h.act(value.authority, { type: "reconcile_closeout", executionId: value.executionId, intentId: approved.intent.id }); assert.equal(read.receipt.recordId, approved.intent.id);
});
test("exact approving capability is rechecked after provider reads, before a void", async () => {
  const value = await h.accepted(); await h.returned(value); const approved = await h.approve(value), writes = h.wire.voids().length;
  h.wire.before = async call => { if (call.method === "GET" && call.path === "/v2/payments/captures/" + approved.grant.captureId) { h.wire.before = null; await h.database.pool.query("UPDATE on_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [value.authority.sessionHash]); } };
  await assert.rejects(() => h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "dispatch"), /expired or was revoked|no longer active/);
  assert.equal(h.wire.voids().length, writes);
});

test("later adverse original read withdraws current release but preserves its original historical receipt", async () => {
  const value = await h.accepted(); await h.returned(value); const approved = await h.approve(value), writes = h.wire.voids().length;
  await h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "dispatch");
  const valid = await h.store.getShow(value.actor.tenantId), originalReceipt = uniqueActual(valid).find(item => item.rentalCloseoutId === approved.grant.id)!;
  assert.equal(originalReceipt.amountMinor, 30000); assert.equal(currentActual(valid).find(item => item.id === originalReceipt.id)?.amountMinor, 30000);
  const captures = h.wire.orders.get(value.orderId)!.purchase_units[0].payments.captures;
  captures.push({ id: "CONTROLLED-LATER-ADVERSE-CAPTURE", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } });
  await assert.rejects(() => h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "readback"), /not counted as released/);
  const adverse = await h.store.getShow(value.actor.tenantId), desk = await h.service.readCloseoutWorkspace(value.authority);
  assert.deepEqual(uniqueActual(adverse).find(item => item.id === originalReceipt.id), originalReceipt); assert.ok(!currentActual(adverse).some(item => item.id === originalReceipt.id));
  assert.equal(desk.rentals[0]!.historicalReleasedMinor, 30000); assert.equal(desk.rentals[0]!.releasedMinor, 0); assert.equal(desk.rentals[0]!.closeout!.state, "needs_attention");
  captures.pop(); await h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "readback");
  assert.equal((await h.service.readCloseoutWorkspace(value.authority)).rentals[0]!.releasedMinor, 30000); assert.equal(h.wire.voids().length, writes + 1);
  await assert.rejects(() => h.database.pool.query("DELETE FROM on_rental_closeout_reads WHERE tenant_id=$1", [value.actor.tenantId]), /immutable/);
});

test("a late-finishing older read cannot restore proof withdrawn by a later-started read", async () => {
  const value = await h.accepted(); await h.returned(value); const approved = await h.approve(value);
  await h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "dispatch");
  const observations = await import("../src/server/rental-closeout/observations"), slow = await observations.beginCloseoutRead(), later = await observations.beginCloseoutRead();
  const provider = h.wire.provider(), order = await provider.read("order", value.orderId, h.signal()), authorization = await provider.read("authorization", approved.grant.authorizationId, h.signal()), capture = await provider.read("capture", approved.grant.captureId, h.signal());
  await observations.recordCloseoutRead(approved.intent, later, { verified: false, code: "CONTROLLED_LATER_READ_UNAVAILABLE", order: null, authorization: null, capture: null });
  await observations.recordCloseoutRead(approved.intent, slow, { verified: true, code: null, order, authorization, capture });
  const show = await h.store.getShow(value.actor.tenantId), check = show.rentalCloseoutChecks!.find(item => item.grantId === approved.grant.id)!;
  assert.equal(check.id, later.id); assert.equal(check.verified, false); assert.equal((await h.service.readCloseoutWorkspace(value.authority)).rentals[0]!.releasedMinor, 0);
  assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_rental_closeout_reads WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [value.actor.tenantId, [slow.id, later.id]])).rows[0].count), 2);
});

test("a refused void requires explicit retry by its original exact capability and retains its provider request identity", async () => {
  const value = await h.accepted(); await h.returned(value); const approved = await h.approve(value), writes = h.wire.voids().length; h.wire.voidFault = "refused";
  assert.equal((await h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "dispatch")).status, "needs_attention");
  let desk = await h.service.readCloseoutWorkspace(value.authority); assert.equal(desk.rentals[0]!.closeout!.canRetry, true);
  await h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "readback"); assert.equal(h.wire.voids().length, writes + 1);
  const replacement = await capability(value.actor), retry = { type: "retry_closeout" as const, grantId: approved.grant.id, intentId: approved.intent.id, confirmed: true as const };
  await assert.rejects(() => h.act(replacement, retry), /original approving capability/);
  await assert.rejects(() => h.paymentService.handlePayment(value.actor, { type: "retry_refused", intentId: approved.intent.id }, origin), /exact session/);
  const receipt = await h.act(value.authority, retry); assert.equal(receipt.receipt.recordId, approved.intent.id);
  assert.equal((await h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "retry", approved.grant.id)).status, "complete");
  desk = await h.service.readCloseoutWorkspace(value.authority); assert.equal(desk.rentals[0]!.closeout!.state, "complete"); assert.equal(h.wire.voids().length, writes + 2);
  assert.equal(new Set(h.wire.voids().slice(writes).map(call => call.requestId)).size, 1); assert.ok(h.wire.voids().slice(writes).every(call => call.durable));
});

test("an unknown void never offers or queues an explicit retry", async () => {
  const value = await h.accepted(); await h.returned(value); const approved = await h.approve(value), writes = h.wire.voids().length; h.wire.voidFault = "unknown";
  await h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "dispatch");
  const desk = await h.service.readCloseoutWorkspace(value.authority); assert.equal(desk.rentals[0]!.closeout!.canRetry, false);
  await assert.rejects(() => h.act(value.authority, { type: "retry_closeout", grantId: approved.grant.id, intentId: approved.intent.id, confirmed: true }), /proved refused or undispatched/);
  await h.worker.runRentalCloseoutWork(value.actor.tenantId, approved.intent.id, h.signal(), "readback"); assert.equal(h.wire.voids().length, writes + 1); assert.equal(financialSummary(await h.store.getShow(value.actor.tenantId)).releasedMinor, 0);
});

test("readback cannot dispatch an original fee left prepared when the plan changed", async () => {
  const value = await h.accepted({ captureFee: false }), writes = h.wire.calls.filter(call => call.method === "POST").length;
  const queued = await h.act(value.supplierAuthority, { type: "reconcile_closeout", executionId: value.executionId, intentId: value.feeIntentId }); assert.equal(queued.receipt.recordId, value.feeIntentId);
  assert.deepEqual(await h.worker.runRentalCloseoutWork(value.actor.tenantId, value.feeIntentId, h.signal(), "readback"), { status: "needs_attention", code: "NOT_DISPATCHED" });
  await assert.rejects(() => h.worker.runRentalCloseoutWork(value.actor.tenantId, value.feeIntentId, h.signal(), "dispatch"), /exact retained hold-closure approval/);
  assert.equal(h.wire.calls.filter(call => call.method === "POST").length, writes); assert.equal(financialSummary(await h.store.getShow(value.actor.tenantId)).rentalCapturedMinor, 0);
});

test("supplier, production, crew and execution capabilities cannot cross the original rental's boundary", async () => {
  const value = await h.accepted(), other = await h.store.createSession(undefined, "retained-rental-other:" + randomUUID());
  const otherAuthority = { actor: other.actor, sessionHash: h.sessionTokenHash(other.token) };
  assert.equal((await h.service.readCloseoutWorkspace(otherAuthority)).rentals.length, 0);
  await assert.rejects(() => h.service.previewRentalCloseout(otherAuthority, value.executionId, other.show.revision), { code: "EXECUTION_NOT_FOUND", status: 404 });
  const northside = await capability({ ...value.supplierAuthority.actor, id: "controlled:northside:" + randomUUID(), supplierId: "northside" });
  assert.equal((await h.service.readCloseoutWorkspace(northside)).rentals.length, 0);
  await assert.rejects(() => h.act(northside, { type: "reconcile_closeout", executionId: value.executionId, intentId: value.feeIntentId }), /own supplier|outside/);
  const desk = await h.service.readCloseoutWorkspace(value.supplierAuthority), rental = desk.rentals[0]!;
  const returnCommand = { type: "record_return" as const, executionId: rental.id, executionDigest: rental.executionDigest, previousInspectionId: null, observedAt: new Date().toISOString(), condition: "undamaged" as const, detail: "A producer cannot replace this original supplier inspection.", confirmed: true as const };
  await assert.rejects(() => h.act(value.authority, returnCommand), /own supplier/);
  await assert.rejects(() => h.service.previewRentalCloseout(value.supplierAuthority, value.executionId, desk.revision), /producer must separately/);
  for (const actor of [{ ...value.actor, roles: ["foh"] as Actor["roles"] }, { ...value.actor, personId: "sam" }, { ...value.actor, executionId: value.executionId }, { ...value.supplierAuthority.actor, roles: ["supplier", "producer"] as Actor["roles"] }]) {
    const authority = await capability({ ...actor, id: "controlled:invalid-scope:" + randomUUID() });
    await assert.rejects(() => h.service.readCloseoutWorkspace(authority), /current producer, stage manager or own supplier/);
  }
});
