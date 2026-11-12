import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AdminAuthority, AdminWorkspace, ManagedSupplierId } from "../src/domain/supplier-admin/contracts";
import type { SupplierAdminCommand, SupplierAdminEnvelope } from "../src/domain/supplier-admin/commands";
import { recordRescueRun } from "../src/domain/commands";
import { atVenue, plusMinutes } from "../src/domain/time";
import { rentalHarness } from "./rental-closeout-harness";

export async function supplierAdminHarness(options: Parameters<typeof rentalHarness>[0] = {}) {
  if (process.env.OPENING_NIGHT_SUPPLIER_ADMIN_QA !== "1") throw new Error("Dedicated supplier-admin guard required");
  const h = await rentalHarness({ ...options, realEngine: true, appOrigin: "http://127.0.0.1:4619" });
  const admin = await import("../src/server/supplier-admin/service"), ledger = await import("../src/server/supplier-admin/store"), engine = await import("../src/server/engine");
  const authority = (value: { actor: import("../src/domain/contracts").Actor; token: string }): AdminAuthority => ({ actor: value.actor, sessionHash: h.sessionTokenHash(value.token) });
  const envelope = (state: AdminWorkspace, command: SupplierAdminCommand): SupplierAdminEnvelope => ({ commandId: randomUUID(), expectedRevision: state.revision, sessionFingerprint: state.sessionFingerprint, expiresAt: state.expiresAt, command });
  async function act(access: AdminAuthority, command: SupplierAdminCommand) { return admin.executeSupplierAdminCommand(access, envelope(await admin.readSupplierAdminWorkspace(access), command)); }
  async function must(access: AdminAuthority, command: SupplierAdminCommand) { const result = await act(access, command); assert.equal(result.receipt.status, "completed", `${result.receipt.code}: ${result.receipt.message}`); return result; }
  async function initial() { const value = await h.store.createSession(undefined, "supplier-admin-controlled:" + randomUUID()); await h.command(value.actor, { type: "load_incidents" }); return { ...value, authority: authority(value) }; }
  async function invite(producer: AdminAuthority) {
    const state = await admin.readSupplierAdminWorkspace(producer), result = await must(producer, { type: "invite", name: "Copper Wing Rentals · controlled", reference: "Owned controlled supplier admission record", detail: "Producer declares a fictional supplier owner for isolated application qualification; no outreach or real identity verification claimed.", reviewDigest: state.reviewDigest, confirmed: true });
    assert.ok(result.invitation); const token = result.invitation.url.split("#")[1]!, actor = (await h.store.getActor(token))!;
    return { token, actor, authority: authority({ token, actor }), supplierId: result.invitation.supplierId, result };
  }
  async function admitted(producer: AdminAuthority, options: { available?: boolean; driver?: boolean | null; condition?: boolean | null; feeMinMinor?: number; maxRounds?: number; earliestDelivery?: string } = {}) {
    const owner = await invite(producer), supplierId = owner.supplierId, own = owner.authority;
    await must(own, { type: "admit", supplierId, enrollmentId: owner.result.receipt.recordId, detail: "Separate controlled supplier owner accepts only this original invitation and its fixed access; no real company participation is claimed.", confirmed: true });
    const key = await must(own, { type: "rotate_key", supplierId, previousKeyId: null, detail: "Controlled supplier owner explicitly authorizes an independent signer for this admitted scope.", confirmed: true });
    let state = key.workspace; const from = state.clock, earliest = options.earliestDelivery ?? (Date.parse(plusMinutes(from, 20)) > Date.parse(atVenue("17:15")) ? plusMinutes(from, 20) : atVenue("17:15")), latest = plusMinutes(earliest, 20);
    const inventoryCommand = { type: "inventory" as const, supplierId, previousId: null, unitId: "CW-" + randomUUID().slice(0, 8), label: "Controlled touring console", model: "Controlled compatible LX desk", owned: true as const, available: options.available ?? true, availableFrom: from, availableUntil: state.accessUntil,
      compatible: true, qualifiedDriver: options.driver === undefined ? true : options.driver, conditionVerified: options.condition === undefined ? true : options.condition,
      capabilityEvidence: "Declared controlled capability source: cue import, touring data output and appropriate power; not physical certification.", driverEvidence: options.driver === null || options.driver === false ? null : "Declared controlled driver roster source; no real driver's participation claimed.", conditionEvidence: options.condition === null || options.condition === false ? null : "Declared controlled condition source; physical delivery inspection remains pending.", reference: "Owned controlled inventory source", detail: "Individually identified fictional unit owned by this controlled supplier; existing rentals and their obligations remain separate.", confirmed: true as const };
    const inventory = await must(own, inventoryCommand);
    const termsCommand = { type: "terms" as const, supplierId, previousId: null, inventoryId: inventory.receipt.recordId, feeMinor: 48000, depositMinor: 30000, earliestDelivery: earliest, latestDelivery: latest, scenarioDeadline: plusMinutes(from, 10), validForMinutes: 15,
      cancellation: "A provisional hold expires independently. No payment or physical handoff follows a quote. Original rental obligations require separate review.", reference: "Controlled owned supplier term sheet", detail: "Supplier owner publishes source-attributed current fee, deposit and delivery terms for this exact controlled unit.", confirmed: true as const };
    const terms = await must(own, termsCommand); state = terms.workspace;
    const bounds = { feeMinMinor: options.feeMinMinor ?? 40000, feeMaxMinor: 48000, depositMinMinor: 20000, depositMaxMinor: 30000, earliestDelivery: earliest, latestDelivery: latest, maxRounds: options.maxRounds ?? 3 };
    const mandate = await must(own, { type: "supplier_mandate", supplierId, inventoryId: inventory.receipt.recordId, termsId: terms.receipt.recordId, keyId: key.receipt.recordId, bounds, validForMinutes: 15, detail: "Separate supplier owner delegates only these fixed fee, deposit, delivery and round bounds to its local signing service.", confirmed: true });
    return { ...owner, key, inventory, terms, mandate, bounds, inventoryCommand, termsCommand };
  }
  async function requestQuotes(producer: AdminAuthority, owner: Awaited<ReturnType<typeof admitted>>, overrides: Partial<Extract<SupplierAdminCommand, { type: "request_quotes" }>["bounds"]> = {}) {
    const state = await admin.readSupplierAdminWorkspace(producer);
    return must(producer, { type: "request_quotes", supplierId: owner.supplierId, supplierMandateId: owner.mandate.receipt.recordId, reviewDigest: state.reviewDigest, bounds: { ...owner.bounds, feeMinMinor: 0, depositMinMinor: 0, ...overrides }, validForMinutes: 15, detail: "Producer reviews exact current production, supplier sources and retained commitments before authorizing this separately bounded quote request.", confirmed: true });
  }
  async function negotiate(producer: AdminAuthority, owner: Awaited<ReturnType<typeof admitted>>, rfqId: string, overrides: Partial<Extract<SupplierAdminCommand, { type: "negotiate" }>> = {}) {
    const state = await admin.readSupplierAdminWorkspace(producer), rfq = state.cards.find(value => value.id === owner.supplierId)!.rfqs.find(value => value.id === rfqId)!;
    return act(producer, { type: "negotiate", supplierId: owner.supplierId, rfqId, previousRoundId: rfq.rounds.at(-1)?.id ?? null, feeMinor: 45000, depositMinor: 30000, deliveryAt: owner.bounds.earliestDelivery, confirmed: true, ...overrides });
  }
  async function quoted(producer: AdminAuthority, options: Parameters<typeof admitted>[1] = {}) {
    const owner = await admitted(producer, options), rfq = await requestQuotes(producer, owner), reply = await negotiate(producer, owner, rfq.receipt.recordId);
    assert.equal(reply.receipt.status, "completed", reply.receipt.message);
    const round = reply.workspace.cards.find(value => value.id === owner.supplierId)!.rfqs[0]!.rounds[0]!;
    return { owner, rfq, reply, round };
  }
  async function realPlan(producer: AdminAuthority, value: Awaited<ReturnType<typeof quoted>>) {
    assert.equal(value.round.data.outcome.kind, "quote"); if (value.round.data.outcome.kind !== "quote") throw new Error("Expected controlled quote");
    const quote = value.round.data.outcome.quote;
    const admission = await must(producer, { type: "accept_quote", supplierId: value.owner.supplierId, rfqId: value.rfq.receipt.recordId, roundId: value.round.id, quoteDigest: quote.termsDigest, confirmed: true });
    let show = await h.store.getShow(producer.actor.tenantId), before = JSON.stringify(show), candidates = await engine.generateCandidates(show);
    assert.equal(JSON.stringify(show), before, "actual engine mutated the input");
    const candidate = candidates.find(item => item.family === "doors" && item.patch.offerId === quote.offer.id)!;
    assert.equal(candidate.report.engine?.status, "passed", candidate.report.engine?.reason ?? "Actual engine report missing");
    assert.equal(candidate.report.status, "feasible_with_approval", candidate.report.issues.map(item => item.code).join(","));
    show = (await h.store.transactCommand(producer.actor, randomUUID(), show.revision, { type: "supplier-admin-real-engine" }, current => recordRescueRun(current, producer.actor, candidates))).show;
    show = await h.command(producer.actor, { type: "approve", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: candidate.approvals.map(item => item.id) });
    return { admission, quote, candidate, candidates, show };
  }
  return { ...h, admin, adminLedger: ledger, engine, authority, envelope, act, must, initial, invite, admitted, requestQuotes, negotiate, quoted, realPlan };
}
