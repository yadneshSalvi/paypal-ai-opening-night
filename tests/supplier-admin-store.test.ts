import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { digest } from "../src/domain/hash";
import { supplierIds } from "../src/domain/supplier-contracts";
import { verifyManagedDecline } from "../src/server/supplier-admin/signatures";
import { verifySupplierQuote } from "../src/server/supplier-protocol";
import { supplierAdminHarness } from "./supplier-admin-harness";
import type { SupplierAdminCommand } from "../src/domain/supplier-admin/commands";
import { atVenue } from "../src/domain/time";
import { recordRescueRun } from "../src/domain/commands";
const h = await supplierAdminHarness(); after(h.close);

test("supplier admission uses separate exact owner access and cannot be accepted by its producer", async () => {
  const producer = await h.initial(), owner = await h.invite(producer.authority), own = await h.admin.readSupplierAdminWorkspace(owner.authority);
  assert.notEqual(owner.actor.id, producer.actor.id); assert.deepEqual(owner.actor.roles, ["supplier"]); assert.equal(own.role, "supplier"); assert.equal(own.cards.length, 1); assert.deepEqual(own.originalServices, []); assert.equal(own.cards[0]!.status, "invited");
  const denied = await h.act(producer.authority, { type: "admit", supplierId: owner.supplierId, enrollmentId: owner.result.receipt.recordId, detail: "Producer cannot stand in for the independently admitted supplier owner.", confirmed: true });
  assert.equal(denied.receipt.status, "refused"); assert.equal(denied.receipt.code, "SUPPLIER_ADMIN_SCOPE");
  assert.equal((await h.admin.readSupplierAdminWorkspace(owner.authority)).cards[0]!.status, "invited");
  assert.doesNotMatch(JSON.stringify(own), /sessionHash|document_cipher|privateKey|\/owner#/); assert.equal(own.expiresAt, owner.result.invitation!.expiresAt);
});

test("same command races replay one immutable invitation with unchanged full expiry and owner", async () => {
  const producer = await h.initial(), state = await h.admin.readSupplierAdminWorkspace(producer.authority), envelope = h.envelope(state, { type: "invite", name: "Independent controlled supplier", reference: "Declared admission source record", detail: "Controlled independent invitation race; no real supplier or outreach is claimed.", reviewDigest: state.reviewDigest, confirmed: true });
  const results = await Promise.all([h.admin.executeSupplierAdminCommand(producer.authority, envelope), h.admin.executeSupplierAdminCommand(producer.authority, envelope)]);
  assert.equal(results.filter(value => value.replayed).length, 1); assert.equal(digest(results[0]!.invitation), digest(results[1]!.invitation));
  assert.equal(digest((await h.admin.recoverSupplierAdminCommand(producer.authority, envelope.commandId)).invitation), digest(results[0]!.invitation));
  assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_supplier_admin_records WHERE tenant_id=$1 AND kind='enrollment'", [producer.actor.tenantId])).rows[0].count), 1);
  await assert.rejects(() => h.admin.executeSupplierAdminCommand(producer.authority, { ...envelope, command: { ...envelope.command as Extract<SupplierAdminCommand, { type: "invite" }>, name: "Different name" } }), { code: "IDEMPOTENCY_CONFLICT" });
});

test("an invitation and owner revocation cannot adopt another capability or a changed full expiry", async () => {
  for (const mode of ["invite_session", "invite_expiry", "revoke_invited", "revoke_admitted"] as const) {
    const producer = await h.initial(), owner = await h.invite(producer.authority);
    const admission = { type: "admit" as const, supplierId: owner.supplierId, enrollmentId: owner.result.receipt.recordId, detail: "The original controlled owner accepts only its exact original invitation and fixed expiry.", confirmed: true as const };
    if (mode === "revoke_admitted") await h.must(owner.authority, admission);
    let alternate = owner.authority;
    if (mode === "invite_expiry") await h.database.pool.query("UPDATE on_sessions SET expires_at=expires_at+interval '1 microsecond' WHERE token_hash=$1", [owner.authority.sessionHash]);
    else {
      const token = randomBytes(32).toString("base64url"), sessionHash = h.sessionTokenHash(token);
      await h.database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,$4::timestamptz)", [sessionHash, owner.actor.tenantId, owner.actor, owner.result.invitation!.expiresAt]);
      alternate = { actor: owner.actor, sessionHash };
    }
    const command: SupplierAdminCommand = mode.startsWith("revoke") ? { type: "revoke", supplierId: owner.supplierId, targetId: (await h.admin.readSupplierAdminWorkspace(owner.authority)).cards[0]!.enrollmentId, targetKind: "enrollment", reason: "Different capability must not adopt this supplier's original admission or revocation authority.", confirmed: true } : admission;
    const denied = await h.act(alternate, command); assert.equal(denied.receipt.status, "refused", mode); assert.equal(denied.receipt.code, "SUPPLIER_ADMIN_ACCESS_ENDED", mode);
    const original = await h.admin.readSupplierAdminWorkspace(owner.authority); assert.equal(original.cards[0]!.status, mode === "revoke_admitted" ? "admitted" : "invited");
    if (mode !== "invite_expiry") { const saved = await h.must(owner.authority, command); if (command.type === "revoke") assert.equal(saved.workspace.cards[0]!.status, "revoked"); }
  }
});

test("a blocked signed reply rechecks actual database time and cannot outlive either immutable mandate", async () => {
  const producer = await h.initial(), owner = await h.admitted(producer.authority);
  const terms = await h.must(owner.authority, { ...owner.termsCommand, previousId: owner.terms.receipt.recordId, validForMinutes: 1 });
  const mandate = await h.must(owner.authority, { type: "supplier_mandate", supplierId: owner.supplierId, inventoryId: owner.inventory.receipt.recordId, termsId: terms.receipt.recordId, keyId: owner.key.receipt.recordId, bounds: owner.bounds, validForMinutes: 1, detail: "The owner reviews one real minute of immutable authority; a database wait may not extend it.", confirmed: true });
  const rfq = await h.requestQuotes(producer.authority, { ...owner, terms, mandate }), fixedExpiry = rfq.workspace.cards[0]!.rfqs[0]!.data.expiresAt;
  const state = await h.admin.readSupplierAdminWorkspace(producer.authority), envelope = h.envelope(state, { type: "negotiate", supplierId: owner.supplierId, rfqId: rfq.receipt.recordId, previousRoundId: null, feeMinor: 45000, depositMinor: 30000, deliveryAt: owner.bounds.earliestDelivery, confirmed: true });
  const blocker = await h.database.pool.connect(); let pending: Promise<Awaited<ReturnType<typeof h.admin.executeSupplierAdminCommand>>> | undefined;
  try {
    await blocker.query("BEGIN"); await blocker.query("LOCK TABLE on_supplier_quotes IN SHARE MODE");
    pending = h.admin.executeSupplierAdminCommand(producer.authority, envelope);
    let observed = false;
    for (let index = 0; index < 200 && !observed; index++) { observed = Boolean((await h.database.pool.query("SELECT 1 FROM pg_locks WHERE relation='on_supplier_quotes'::regclass AND mode='RowExclusiveLock' AND NOT granted")).rowCount); if (!observed) await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(observed, true, "The actual quote INSERT must be waiting after initial mandate validation");
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(fixedExpiry) - Date.now() + 70)));
    await blocker.query("COMMIT");
    const result = await pending; pending = undefined; assert.equal(result.receipt.status, "refused"); assert.equal(result.receipt.code, "SUPPLIER_MANDATE_EXPIRED");
    assert.equal(result.workspace.cards[0]!.rfqs[0]!.data.expiresAt, fixedExpiry); assert.equal(result.workspace.cards[0]!.rfqs[0]!.rounds.length, 0);
    assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_supplier_quotes WHERE tenant_id=$1", [producer.actor.tenantId])).rows[0].count), 0);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); if (pending) await pending.catch(() => undefined); }
});

test("own inventory and terms are source-backed immutable editions with a stable unit identity", async () => {
  const producer = await h.initial(), owner = await h.admitted(producer.authority), prior = await h.adminLedger.readAdminRecords(h.database.pool, producer.actor.tenantId);
  const next = await h.must(owner.authority, { ...owner.inventoryCommand, previousId: owner.inventory.receipt.recordId, available: false, detail: "Owner withdraws future availability; no original commitment is erased." });
  assert.equal(next.workspace.cards[0]!.units[0]!.inventory.revision, 2); assert.equal(next.workspace.cards[0]!.units[0]!.terms!.inventoryId, owner.inventory.receipt.recordId);
  const after = await h.adminLedger.readAdminRecords(h.database.pool, producer.actor.tenantId);
  for (const record of prior) assert.equal(digest(after.find(value => value.id === record.id)), digest(record));
  for (const table of ["on_supplier_admin_records", "on_supplier_admin_keys", "on_supplier_admin_commands", "on_supplier_admin_invites"]) await assert.rejects(() => h.database.pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [producer.actor.tenantId]), /immutable/);
  const denied = await h.act(owner.authority, { ...owner.inventoryCommand, previousId: next.receipt.recordId, qualifiedDriver: true, driverEvidence: null });
  assert.equal(denied.receipt.status, "refused"); assert.equal(denied.receipt.code, "SUPPLIER_INVENTORY_INVALID");
});

test("one supplier cannot claim a second supplier's original unit or publish another owner's editions", async () => {
  const producer = await h.initial(), owner = await h.admitted(producer.authority), other = await h.admitted(producer.authority);
  const cross = await h.act(other.authority, { ...owner.inventoryCommand, previousId: owner.inventory.receipt.recordId });
  assert.equal(cross.receipt.code, "SUPPLIER_ADMIN_SCOPE");
  const original = (await h.store.getShow(producer.actor.tenantId)).offers[0]!;
  const conflict = await h.act(owner.authority, { ...owner.inventoryCommand, previousId: null, unitId: original.unitId });
  assert.equal(conflict.receipt.code, "SUPPLIER_INVENTORY_OWNERSHIP");
});

test("keys are independent; rotation and revocation preserve old signature verification but block new admission", async () => {
  const producer = await h.initial(), value = await h.quoted(producer.authority), other = await h.admitted(producer.authority);
  const quote = value.round.data.outcome.kind === "quote" ? value.round.data.outcome.quote : null; assert.ok(quote); assert.equal(verifySupplierQuote(quote), true);
  const untouched = other.key.workspace.cards[0]!.key!.fingerprint;
  const rotated = await h.must(value.owner.authority, { type: "rotate_key", supplierId: value.owner.supplierId, previousKeyId: value.owner.key.receipt.recordId, detail: "Controlled owner rotates only this supplier's independent key; historical verification remains retained.", confirmed: true });
  assert.notEqual(rotated.workspace.cards[0]!.key!.fingerprint, untouched); assert.notEqual(rotated.workspace.cards[0]!.key!.id, value.owner.key.receipt.recordId);
  await h.must(value.owner.authority, { type: "revoke", supplierId: value.owner.supplierId, targetId: value.owner.key.receipt.recordId, targetKind: "key", reason: "Retire the original key for future signing without erasing its historical public verification material.", confirmed: true });
  assert.equal(verifySupplierQuote(quote), true);
  const refused = await h.act(producer.authority, { type: "accept_quote", supplierId: value.owner.supplierId, rfqId: value.rfq.receipt.recordId, roundId: value.round.id, quoteDigest: quote.termsDigest, confirmed: true });
  assert.equal(refused.receipt.status, "refused"); assert.equal(refused.receipt.code, "SUPPLIER_ADMIN_SOURCE_CHANGED");
  const own = await h.admin.readSupplierAdminWorkspace(value.owner.authority); assert.equal(own.cards[0]!.keyHistory[0]!.status, "revoked"); assert.equal(own.cards[0]!.rfqs[0]!.rounds[0]!.verified, true);
  assert.equal((await h.admin.readSupplierAdminWorkspace(other.authority)).cards[0]!.key!.fingerprint, untouched);
});

test("bounded disjoint mandates return signed declines and enforce the fixed round cap", async () => {
  const producer = await h.initial(), owner = await h.admitted(producer.authority, { feeMinMinor: 47000, maxRounds: 2 }), rfq = await h.requestQuotes(producer.authority, owner, { feeMaxMinor: 45000, maxRounds: 2 });
  const first = await h.negotiate(producer.authority, owner, rfq.receipt.recordId), second = await h.negotiate(producer.authority, owner, rfq.receipt.recordId);
  for (const result of [first, second]) { assert.equal(result.receipt.status, "completed"); const round = result.workspace.cards[0]!.rfqs[0]!.rounds.at(-1)!; assert.equal(round.data.outcome.kind, "declined"); if (round.data.outcome.kind === "declined") { assert.equal(round.data.outcome.decline.code, "BOUNDS_DO_NOT_OVERLAP"); assert.equal(verifyManagedDecline(round.data.outcome.decline), true); } }
  const third = await h.negotiate(producer.authority, owner, rfq.receipt.recordId); assert.equal(third.receipt.status, "refused"); assert.equal(third.receipt.code, "SUPPLIER_NEGOTIATION_ROUNDS");
  assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_supplier_quotes WHERE tenant_id=$1", [producer.actor.tenantId])).rows[0].count), 0);
});

test("unknown driver evidence and withdrawn inventory produce signed refusals without invented capacity", async () => {
  for (const options of [{ driver: null }, { available: false }]) {
    const producer = await h.initial(), value = await h.quoted(producer.authority, options), outcome = value.round.data.outcome;
    assert.equal(outcome.kind, "declined"); if (outcome.kind === "declined") assert.equal(outcome.decline.code, options.driver === null ? "EVIDENCE_MISSING" : "UNIT_UNAVAILABLE");
    assert.equal((await h.store.getShow(producer.actor.tenantId)).offers.length, 3); assert.equal((await h.store.getShow(producer.actor.tenantId)).rentalExecutions?.length, 0);
  }
});

test("out-of-mandate counters and stale reviewed production sources become durable original refusals", async () => {
  const producer = await h.initial(), owner = await h.admitted(producer.authority), rfq = await h.requestQuotes(producer.authority, owner);
  const outside = await h.negotiate(producer.authority, owner, rfq.receipt.recordId, { feeMinor: 48001 }); assert.equal(outside.receipt.code, "SUPPLIER_NEGOTIATION_OUTSIDE_MANDATE");
  await h.invite(producer.authority);
  const stale = await h.negotiate(producer.authority, owner, rfq.receipt.recordId); assert.equal(stale.receipt.code, "SUPPLIER_RFQ_SOURCE_CHANGED");
  assert.equal((await h.admin.recoverSupplierAdminCommand(producer.authority, stale.receipt.commandId)).receipt.status, "refused");
});

test("real signed quote enters the actual engine and approved reservation service; missing merchant blocks checkout before egress", async () => {
  const producer = await h.initial(), value = await h.quoted(producer.authority), plan = await h.realPlan(producer.authority, value), beforeCalls = h.wire.calls.length;
  assert.equal(plan.candidates.length, 16); assert.deepEqual(supplierIds, ["brightline", "northside", "sister"]);
  const held = await h.must(producer.authority, { type: "reserve", supplierId: value.owner.supplierId, quoteId: plan.quote.id, planDigest: plan.show.approvedPlan!.digest, acceptCaptureTerms: true, confirmed: true });
  const show = await h.store.getShow(producer.actor.tenantId), execution = show.rentalExecutions!.find(item => item.id === held.receipt.recordId)!;
  assert.equal(execution.supplierId, value.owner.supplierId); assert.equal(execution.quoteId, plan.quote.id); assert.equal(execution.feeMinor, 45000); assert.equal(execution.state, "held"); assert.equal(execution.authorizationId, null); assert.equal(execution.paymentRootId, null);
  await assert.rejects(() => h.paymentService.handlePayment(producer.actor, { type: "rental_checkout", expectedRevision: show.revision }, "http://127.0.0.1:4619"), { code: "SELLER_NOT_QUALIFIED" });
  assert.equal(h.wire.calls.length, beforeCalls); assert.match(held.workspace.cards[0]!.enrollment.merchant.message, /no matching verified merchant/i);
  const released = await h.must(producer.authority, { type: "release", supplierId: value.owner.supplierId, executionId: execution.id, confirmed: true }); assert.equal(released.workspace.cards[0]!.retained[0]!.state, "cancelled");
});

test("a supplier source or key change after actual engine approval blocks the new hold", async () => {
  const producer = await h.initial(), value = await h.quoted(producer.authority), plan = await h.realPlan(producer.authority, value);
  await h.must(value.owner.authority, { type: "revoke", supplierId: value.owner.supplierId, targetId: value.owner.key.receipt.recordId, targetKind: "key", reason: "Current key revoked before a new capacity commitment. Historical reply remains retained.", confirmed: true });
  const refused = await h.act(producer.authority, { type: "reserve", supplierId: value.owner.supplierId, quoteId: plan.quote.id, planDigest: plan.show.approvedPlan!.digest, acceptCaptureTerms: true, confirmed: true });
  assert.equal(refused.receipt.status, "refused"); assert.equal(refused.receipt.code, "MANAGED_RFQ_SOURCE_CHANGED"); assert.equal((await h.store.getShow(producer.actor.tenantId)).rentalExecutions!.length, 0); assert.equal(verifySupplierQuote(plan.quote), true);
});

test("full microsecond expiry binding refuses same-token extension and a different session cannot adopt an original command", async () => {
  const producer = await h.initial(), state = await h.admin.readSupplierAdminWorkspace(producer.authority), original = h.envelope(state, { type: "invite", name: "Expiry-bound controlled supplier", reference: "Controlled exact-expiry source", detail: "This original instruction binds the full fixed producer capability expiry.", reviewDigest: state.reviewDigest, confirmed: true });
  await h.database.pool.query("UPDATE on_sessions SET expires_at=expires_at+interval '1 microsecond' WHERE token_hash=$1", [producer.authority.sessionHash]);
  await assert.rejects(() => h.admin.executeSupplierAdminCommand(producer.authority, original), { code: "SUPPLIER_ADMIN_REVIEW_ACCESS" });
  const current = await h.admin.readSupplierAdminWorkspace(producer.authority); assert.notEqual(current.expiresAt, state.expiresAt);
  const command = h.envelope(current, { ...original.command, reviewDigest: current.reviewDigest } as SupplierAdminCommand); const saved = await h.admin.executeSupplierAdminCommand(producer.authority, command);
  const token = randomBytes(32).toString("base64url"), hash = h.sessionTokenHash(token);
  await h.database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [hash, producer.actor.tenantId, producer.actor]);
  await assert.rejects(() => h.admin.recoverSupplierAdminCommand({ actor: producer.actor, sessionHash: hash }, saved.receipt.commandId), { code: "SUPPLIER_ADMIN_COMMAND_NOT_FOUND" });
  await assert.rejects(() => h.admin.executeSupplierAdminCommand({ actor: producer.actor, sessionHash: hash }, command), { code: "SUPPLIER_ADMIN_REVIEW_ACCESS" });
});

test("managed enrollment and quote admission preserve original accepted SDK-controlled money, signatures and obligations", async () => {
  const original = await h.accepted({ replacePlan: false, captureFee: true }), value = await h.quoted(original.authority), before = await h.store.getShow(original.actor.tenantId);
  const originalExecution = before.rentalExecutions!.find(item => item.id === original.executionId)!, originalMoney = digest(before.financialEvidence), oldQuotes = (await h.database.pool.query("SELECT document FROM on_supplier_quotes WHERE tenant_id=$1 AND supplier_id IN ('brightline','northside','sister') ORDER BY id", [original.actor.tenantId])).rows;
  const calls = h.wire.calls.length, plan = await h.realPlan(original.authority, value);
  await h.must(original.authority, { type: "reserve", supplierId: value.owner.supplierId, quoteId: plan.quote.id, planDigest: plan.show.approvedPlan!.digest, acceptCaptureTerms: true, confirmed: true });
  const after = await h.store.getShow(original.actor.tenantId);
  assert.equal(digest(after.financialEvidence), originalMoney); assert.equal(digest(after.rentalExecutions!.find(item => item.id === original.executionId)), digest(originalExecution));
  assert.equal(digest((await h.database.pool.query("SELECT document FROM on_supplier_quotes WHERE tenant_id=$1 AND supplier_id IN ('brightline','northside','sister') ORDER BY id", [original.actor.tenantId])).rows), digest(oldQuotes));
  assert.equal(h.wire.calls.length, calls); assert.equal((await h.service.readCloseoutWorkspace(original.supplierAuthority)).rentals.some(item => item.id === original.executionId), true);
});

test("racing holds create one actual reservation and cannot borrow a later command identity", async () => {
  const producer = await h.initial(), value = await h.quoted(producer.authority), plan = await h.realPlan(producer.authority, value), state = await h.admin.readSupplierAdminWorkspace(producer.authority);
  const command = { type: "reserve" as const, supplierId: value.owner.supplierId, quoteId: plan.quote.id, planDigest: plan.show.approvedPlan!.digest, acceptCaptureTerms: true as const, confirmed: true as const };
  const results = await Promise.all([h.admin.executeSupplierAdminCommand(producer.authority, h.envelope(state, command)), h.admin.executeSupplierAdminCommand(producer.authority, h.envelope(state, command))]);
  assert.equal(results.filter(value => value.receipt.status === "completed").length, 1); assert.equal(results.filter(value => value.receipt.status === "refused").length, 1);
  assert.equal(Number((await h.database.pool.query("SELECT count(*) FROM on_rental_executions WHERE tenant_id=$1", [producer.actor.tenantId])).rows[0].count), 1);
});

test("original fixed capability expiry ends supplier mandates and RFQs without renewing either", async () => {
  const producer = await h.initial(), token = randomBytes(32).toString("base64url"), short = { actor: producer.actor, sessionHash: h.sessionTokenHash(token) };
  // A declared negative-test capability gets its one fixed short expiry before any positive service action.
  await h.database.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '3 seconds')", [short.sessionHash, producer.actor.tenantId, producer.actor]);
  const owner = await h.admitted(short), rfq = await h.requestQuotes(short, owner), deadline = Date.parse(rfq.workspace.cards[0]!.rfqs[0]!.data.expiresAt);
  assert.ok(deadline <= Date.parse((await h.admin.readSupplierAdminWorkspace(short)).expiresAt));
  await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now() + 70)));
  await assert.rejects(() => h.admin.readSupplierAdminWorkspace(owner.authority), { code: "SUPPLIER_ADMIN_ACCESS_ENDED" });
  const readback = await h.admin.readSupplierAdminWorkspace(producer.authority); assert.equal(readback.cards[0]!.status, "expired"); assert.equal(readback.cards[0]!.rfqs[0]!.status, "expired");
  const refused = await h.negotiate(producer.authority, owner, rfq.receipt.recordId);
  assert.equal(refused.receipt.status, "refused"); assert.equal(refused.receipt.code, "SUPPLIER_MANDATE_EXPIRED");
  assert.equal(refused.workspace.cards[0]!.rfqs[0]!.rounds.length, 0);
});

test("a signed earlier delivery remains infeasible when the actual authorization dependency cannot clear", async () => {
  const producer = await h.initial(), value = await h.quoted(producer.authority, { earliestDelivery: atVenue("15:45") });
  assert.equal(value.round.data.outcome.kind, "quote"); if (value.round.data.outcome.kind !== "quote") throw new Error("Expected controlled quote");
  const quote = value.round.data.outcome.quote;
  await h.must(producer.authority, { type: "accept_quote", supplierId: value.owner.supplierId, rfqId: value.rfq.receipt.recordId, roundId: value.round.id, quoteDigest: quote.termsDigest, confirmed: true });
  let show = await h.store.getShow(producer.actor.tenantId), candidates = await h.engine.generateCandidates(show), candidate = candidates.find(value => value.family === "doors" && value.patch.offerId === quote.offer.id)!;
  assert.equal(candidate.report.status, "infeasible"); assert.equal(candidate.report.engine!.status, "rejected"); assert.ok(candidate.report.issues.some(issue => issue.code === "DEPENDENCY_ORDER"));
  show = (await h.store.transactCommand(producer.actor, randomUUID(), show.revision, { type: "supplier-admin-early-negative-engine" }, current => recordRescueRun(current, producer.actor, candidates))).show;
  await assert.rejects(() => h.command(producer.actor, { type: "approve", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: candidate.approvals.map(value => value.id) }), { code: "PLAN_NOT_FEASIBLE" });
  assert.equal((await h.store.getShow(producer.actor.tenantId)).rentalExecutions!.length, 0);
});

test("deposit concessions require overlapping independent mandates and stay inside both limits", async () => {
  const producer = await h.initial(), owner = await h.admitted(producer.authority), rfq = await h.requestQuotes(producer.authority, owner, { depositMaxMinor: 25000 });
  const agreed = await h.negotiate(producer.authority, owner, rfq.receipt.recordId, { depositMinor: 25000 });
  const first = agreed.workspace.cards[0]!.rfqs[0]!.rounds[0]!.data.outcome; assert.equal(first.kind, "quote"); if (first.kind === "quote") assert.equal(first.quote.offer.depositMinor, 25000);
  const declined = await h.negotiate(producer.authority, owner, rfq.receipt.recordId, { depositMinor: 15000 });
  const second = declined.workspace.cards[0]!.rfqs[0]!.rounds[1]!.data.outcome; assert.equal(second.kind, "declined"); if (second.kind === "declined") assert.equal(second.decline.code, "BOUNDS_DO_NOT_OVERLAP");
});

test("an embedded replacement public key cannot substitute for the admitted database signer", async () => {
  const producer = await h.initial(), value = await h.quoted(producer.authority), plan = await h.realPlan(producer.authority, value), crypto = await import("../src/server/supplier-admin/signatures"), adapter = await import("../src/server/supplier-admin/adapters"), keys = crypto.generateSupplierKey();
  const { signature: _signature, termsDigest: _termsDigest, ...content } = plan.quote;
  const forgedContent = { ...content, adminSource: { ...content.adminSource!, publicKey: keys.publicKey, keyFingerprint: keys.fingerprint } }, forged = crypto.signManagedQuote({ ...forgedContent, termsDigest: digest(forgedContent) }, keys.privateKey);
  assert.equal(crypto.verifyManagedQuoteSignature(forged), true, "A standalone signature proves possession only; database admission remains necessary");
  const expiresAt = (await h.admin.readSupplierAdminWorkspace(producer.authority)).expiresAt, db = await h.database.pool.connect();
  try { await db.query("BEGIN"); await assert.rejects(() => adapter.requireManagedQuoteCurrent(db, plan.show, producer.actor, forged, { sessionHash: producer.authority.sessionHash, expiresAt }), { code: "SUPPLIER_ADMIN_SOURCE_CHANGED" }); } finally { await db.query("ROLLBACK"); db.release(); }
});

test("refreshing the original three preserves managed quote identity and old hold while requiring a distinct current-source negotiation", async () => {
  const producer = await h.initial(), value = await h.quoted(producer.authority), plan = await h.realPlan(producer.authority, value);
  const hold = await h.must(producer.authority, { type: "reserve", supplierId: value.owner.supplierId, quoteId: plan.quote.id, planDigest: plan.show.approvedPlan!.digest, acceptCaptureTerms: true, confirmed: true });
  await h.must(producer.authority, { type: "release", supplierId: value.owner.supplierId, executionId: hold.receipt.recordId, confirmed: true });
  const before = await h.store.getShow(producer.actor.tenantId), oldHold = (await h.database.pool.query("SELECT * FROM on_resource_holds WHERE id=$1", [hold.receipt.recordId])).rows[0], originalQuote = (await h.database.pool.query("SELECT document FROM on_supplier_quotes WHERE id=$1", [plan.quote.id])).rows[0]!.document;
  const rfq = await import("../src/server/supplier-rfq"), legacyRpc = await import("../src/app/api/enrolled-suppliers/[supplier]/rpc/route"), id = randomUUID();
  await rfq.beginSupplierRfq(producer.actor, id, before.revision); assert.equal((await rfq.collectSupplierRfq(producer.actor.tenantId, id, h.signal(), request => legacyRpc.POST(request, { params: Promise.resolve({ supplier: new URL(request.url).pathname.split("/").at(-2)! }) }))).status, "complete");
  let show = await h.store.getShow(producer.actor.tenantId), managed = show.offers.find(offer => offer.id === plan.quote.offer.id)!;
  assert.equal(show.offers.length, 4); assert.equal(managed.serviceQuote!.id, plan.quote.id); assert.equal(managed.serviceQuote!.validUntil, plan.quote.validUntil); assert.equal(managed.expiresAt, plan.quote.offer.expiresAt); assert.equal(managed.status, plan.quote.offer.status); assert.equal(digest(managed.serviceQuote!.adminSource), digest(plan.quote.adminSource)); assert.equal(managed.serviceQuote!.reviewRequired!.code, "MANAGED_RFQ_SOURCE_CHANGED");
  assert.ok(Date.parse(managed.serviceQuote!.validUntil) > Date.now()); assert.equal(digest((await h.database.pool.query("SELECT document FROM on_supplier_quotes WHERE id=$1", [plan.quote.id])).rows[0]!.document), digest(originalQuote)); assert.equal(digest((await h.database.pool.query("SELECT * FROM on_resource_holds WHERE id=$1", [hold.receipt.recordId])).rows[0]), digest(oldHold));
  const candidates = await h.engine.generateCandidates(show), stale = candidates.find(candidate => candidate.family === "doors" && candidate.patch.offerId === managed.id)!;
  assert.equal(stale.report.status, "infeasible"); assert.ok(stale.report.issues.some(issue => issue.code === "MANAGED_RFQ_SOURCE_CHANGED"));
  show = (await h.store.transactCommand(producer.actor, randomUUID(), show.revision, { type: "supplier-admin-current-source-engine" }, current => recordRescueRun(current, producer.actor, candidates))).show;
  await assert.rejects(() => h.command(producer.actor, { type: "approve", candidateId: stale.id, candidateDigest: stale.digest, approvals: stale.approvals.map(value => value.id) }), { code: "PLAN_NOT_FEASIBLE" });
  const refused = await h.act(producer.authority, { type: "reserve", supplierId: value.owner.supplierId, quoteId: plan.quote.id, planDigest: plan.show.approvedPlan!.digest, acceptCaptureTerms: true, confirmed: true }); assert.equal(refused.receipt.status, "refused");
  const freshRfq = await h.requestQuotes(producer.authority, value.owner), freshReply = await h.negotiate(producer.authority, value.owner, freshRfq.receipt.recordId), freshRound = freshReply.workspace.cards[0]!.rfqs.find(row => row.id === freshRfq.receipt.recordId)!.rounds[0]!;
  const refreshed = await h.realPlan(producer.authority, { ...value, rfq: freshRfq, reply: freshReply, round: freshRound }); assert.notEqual(refreshed.quote.id, plan.quote.id);
  assert.equal(refreshed.show.offers.find(offer => offer.id === managed.id)!.serviceQuote!.reviewRequired, undefined);
  const distinct = await h.must(producer.authority, { type: "reserve", supplierId: value.owner.supplierId, quoteId: refreshed.quote.id, planDigest: refreshed.show.approvedPlan!.digest, acceptCaptureTerms: true, confirmed: true }); assert.notEqual(distinct.receipt.recordId, hold.receipt.recordId);
  assert.equal(digest((await h.database.pool.query("SELECT document FROM on_supplier_quotes WHERE id=$1", [plan.quote.id])).rows[0]!.document), digest(originalQuote)); assert.equal(digest((await h.database.pool.query("SELECT * FROM on_resource_holds WHERE id=$1", [hold.receipt.recordId])).rows[0]), digest(oldHold));
});

test("new supplier source editions never replay or erase an original unknown SDK-controlled closure", async () => {
  const original = await h.accepted({ replacePlan: false, captureFee: true }), value = await h.quoted(original.authority), plan = await h.realPlan(original.authority, value);
  const held = await h.must(original.authority, { type: "reserve", supplierId: value.owner.supplierId, quoteId: plan.quote.id, planDigest: plan.show.approvedPlan!.digest, acceptCaptureTerms: true, confirmed: true });
  // The old unit's actual reviewed replacement plan now permits its separately attributed historical return.
  await h.returned(original); const closure = await h.approve(original);
  h.wire.voidFault = "unknown"; await h.worker.runRentalCloseoutWork(original.actor.tenantId, closure.intent.id, h.signal(), "dispatch");
  const oldDesk = await h.service.readCloseoutWorkspace(original.authority), oldRental = oldDesk.rentals.find(value => value.id === original.executionId)!;
  assert.equal(oldRental.closeout!.canRetry, false); assert.equal(oldRental.releasedMinor, 0);
  const operationRows = () => h.database.pool.query("SELECT row_to_json(t)::text AS row FROM paycore_operations t ORDER BY row_to_json(t)::text");
  const before = digest((await operationRows()).rows), calls = h.wire.calls.length, oldIntent = await h.payments.readIntent(original.actor.tenantId, closure.intent.id);
  const currentHold = (await h.database.pool.query("SELECT document FROM on_rental_executions WHERE id=$1", [held.receipt.recordId])).rows[0]!.document;
  await h.must(value.owner.authority, { type: "rotate_key", supplierId: value.owner.supplierId, previousKeyId: value.owner.key.receipt.recordId, detail: "Owner rotates a future signer while the original unknown closure and separate current unit remain retained.", confirmed: true });
  const inventory = await h.must(value.owner.authority, { ...value.owner.inventoryCommand, previousId: value.owner.inventory.receipt.recordId, available: false });
  await h.must(value.owner.authority, { ...value.owner.termsCommand, previousId: value.owner.terms.receipt.recordId, inventoryId: inventory.receipt.recordId });
  await h.invite(original.authority);
  assert.equal(digest((await operationRows()).rows), before); assert.equal(digest(await h.payments.readIntent(original.actor.tenantId, closure.intent.id)), digest(oldIntent)); assert.equal(h.wire.calls.length, calls);
  const after = await h.service.readCloseoutWorkspace(original.authority), retained = after.rentals.find(value => value.id === original.executionId)!;
  assert.equal(retained.closeout!.canRetry, false); assert.equal(retained.releasedMinor, 0); assert.equal(retained.closeout!.intentId, oldRental.closeout!.intentId);
  assert.equal(digest((await h.database.pool.query("SELECT document FROM on_rental_executions WHERE id=$1", [held.receipt.recordId])).rows[0]!.document), digest(currentHold));
});
