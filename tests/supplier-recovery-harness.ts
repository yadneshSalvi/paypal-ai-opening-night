import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Actor } from "../src/domain/contracts";
import type { SupplierRecoveryAuthority } from "../src/server/supplier-recovery/contracts";
import type { SupplierRecoveryCommand, SupplierRecoveryEnvelope, SupplierTermInput } from "../src/domain/supplier-recovery-command";
import type { SupplierId } from "../src/domain/supplier-contracts";
import { recordRescueRun } from "../src/domain/commands";
import { plusMinutes } from "../src/domain/time";
import { rentalHarness } from "./rental-closeout-harness";

export async function supplierRecoveryHarness(options: Parameters<typeof rentalHarness>[0] = {}) {
  const h = await rentalHarness({ ...options, appOrigin: "http://127.0.0.1:4586" });
  const service = await import("../src/server/supplier-recovery/service"), ledger = await import("../src/server/supplier-recovery/store");
  const rfq = await import("../src/server/supplier-rfq"), protocol = await import("../src/server/supplier-protocol"), rpc = await import("../src/app/api/enrolled-suppliers/[supplier]/rpc/route");
  const disruption = await import("../src/server/disruptions/service"), engine = await import("../src/server/engine");
  const transport: import("../src/server/supplier-protocol").SupplierTransport = request => rpc.POST(request, { params: Promise.resolve({ supplier: new URL(request.url).pathname.split("/").at(-2)! }) });
  async function act(authority: SupplierRecoveryAuthority, command: SupplierRecoveryCommand, envelope?: SupplierRecoveryEnvelope) {
    const state = await service.readSupplierRecoveryWorkspace(authority);
    return service.executeSupplierRecoveryCommand(authority, envelope ?? { commandId: randomUUID(), expectedRevision: state.revision, command });
  }
  async function initial() {
    const session = await h.store.createSession(undefined, "supplier-recovery-controlled:" + randomUUID());
    await h.command(session.actor, { type: "load_incidents" }); await h.command(session.actor, { type: "advance", time: "17:15" });
    return { ...session, authority: { actor: session.actor, sessionHash: h.sessionTokenHash(session.token) } };
  }
  async function openSupplier(authority: SupplierRecoveryAuthority, supplierId: SupplierId) {
    const saved = await act(authority, { type: "open_supplier", supplierId, confirmed: true });
    assert.ok(saved.invitation); const token = saved.invitation.url.split("#")[1]!; const actor = (await h.store.getActor(token))!;
    return { token, actor, authority: { actor, sessionHash: h.sessionTokenHash(token) }, saved };
  }
  async function terms(authority: SupplierRecoveryAuthority, overrides: Partial<SupplierTermInput> = {}) {
    const state = await service.readSupplierRecoveryWorkspace(authority), card = state.cards[0]!;
    const command: SupplierTermInput = { type: "publish_terms", offerId: card.offerId, previousTermId: card.reference?.id ?? null, sourceReportId: card.report?.id ?? null,
      deliveryAt: plusMinutes(state.clock, 20), expiresAt: plusMinutes(state.clock, 15), validForMinutes: 15,
      feeMinor: card.feeMinor, depositMinor: card.depositMinor, compatible: true, qualifiedDriver: true, conditionVerified: true,
      capabilityEvidence: "Controlled fixture capability sheet: compatible desk, cue import and touring outputs.", driverEvidence: "Controlled fixture qualified driver roster; no actual driver participation claimed.", conditionEvidence: "Controlled fixture pre-dispatch condition sheet; actual handoff and inspection remain pending.",
      reference: "Controlled current-terms source " + randomUUID().slice(0, 8), detail: "Controlled supplier offers its enrolled unit with the reviewed current delivery time and separate original obligations.", confirmed: true, ...overrides };
    return { envelope: { commandId: randomUUID(), expectedRevision: state.revision, command }, state };
  }
  async function publish(authority: SupplierRecoveryAuthority, overrides: Partial<SupplierTermInput> = {}) {
    const prepared = await terms(authority, overrides); return service.executeSupplierRecoveryCommand(authority, prepared.envelope);
  }
  async function requestQuotes(authority: SupplierRecoveryAuthority) {
    const state = await service.readSupplierRecoveryWorkspace(authority); assert.equal(state.preview?.ready, true, state.preview?.blockers.join("; "));
    return act(authority, { type: "request_quotes", previewDigest: state.preview!.digest, detail: "Producer reviewed current controlled supplier facts and every original commitment before requesting replacement quotes.", confirmed: true });
  }
  async function report(authority: SupplierRecoveryAuthority, supplierId: SupplierId, availability: "available" | "unavailable" | "delayed" = "unavailable") {
    const show = await h.store.getShow(authority.actor.tenantId), offer = show.offers.find(item => item.supplierId === supplierId)!;
    const execution = show.rentalExecutions?.findLast(item => item.offerId === offer.id && item.offerRevision === offer.revision);
    return disruption.executeDisruptionCommand(authority, { idempotencyKey: randomUUID(), expectedRevision: show.revision, command: { type: "report", offerId: offer.id, offerRevision: offer.revision, executionId: execution?.id ?? null, availability, earliestAt: availability === "unavailable" ? null : plusMinutes(show.clock, 10), observedAt: new Date().toISOString(), reference: "Controlled supplier report " + randomUUID().slice(0, 8), detail: "Controlled supplier availability report for this exact enrolled unit; no actual equipment or participant claim.", confirmed: true } });
  }
  async function realPlan(actor: Actor, supplierId: SupplierId = "northside") {
    let show = await h.store.getShow(actor.tenantId); const candidates = await engine.generateCandidates(show);
    const candidate = candidates.find(item => item.family === "doors" && item.patch.offerId.includes(supplierId))!;
    assert.equal(candidate.report.engine?.status, "passed", candidate.report.engine?.reason ?? "engine report missing");
    assert.equal(candidate.report.status, "feasible_with_approval", candidate.report.issues.map(issue => issue.code).join("; "));
    show = (await h.store.transactCommand(actor, randomUUID(), show.revision, { type: "controlled-real-engine-result" }, current => recordRescueRun(current, actor, candidates))).show;
    return { show, candidate, candidates };
  }
  return { ...h, recovery: service, recoveryLedger: ledger, rfq, protocol, transport, disruption, engine, recoveryAct: act, initial, openSupplier, terms, publish, requestQuotes, report, realPlan };
}
