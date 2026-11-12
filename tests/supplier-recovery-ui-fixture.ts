/** UI state fixtures only; no supplier participation, provider call or physical proof. */
import { randomBytes, randomUUID } from "node:crypto";
import { createFixture } from "../src/domain/fixture";
import { atVenue } from "../src/domain/time";
import type { SupplierRecoveryEnvelope, SupplierRecoveryResult, SupplierRecoveryWorkspace, SupplierTermsCard } from "../src/server/supplier-recovery/contracts";
import { supplierRecoveryRequestDigest } from "../src/components/supplier-recovery/recovery";
export function supplierTermsCard(overrides: Partial<SupplierTermsCard> = {}): SupplierTermsCard {
  const base = createFixture(randomUUID()).offers.find(offer => offer.supplierId === "northside")!;
  return { supplierId: "northside", supplier: base.supplier, offerId: base.id, unitId: base.unitId, feeMinor: base.feeMinor, depositMinor: base.depositMinor, deliveryAt: base.deliveryAt, scenarioDeadline: base.expiresAt, reference: null, input: null, actorLabel: null, scenarioAt: null, report: null, usable: false, blockers: ["The initial scenario quote expired. This supplier must publish a new edition with current delivery and expiry times."], inventoryCommitted: false, ...overrides };
}
export function supplierRecoveryUiFixture(overrides: Partial<SupplierRecoveryWorkspace> = {}): SupplierRecoveryWorkspace {
  const tenantId = randomUUID(), now = new Date().toISOString(), cards = createFixture(tenantId).offers.map(offer => supplierTermsCard({ supplierId: offer.supplierId as SupplierTermsCard["supplierId"], supplier: offer.supplier, offerId: offer.id, unitId: offer.unitId, feeMinor: offer.feeMinor, depositMinor: offer.depositMinor, deliveryAt: offer.deliveryAt, scenarioDeadline: offer.expiresAt }));
  return { tenantId, actorId: "producer:controlled-current-terms", sessionFingerprint: "a".repeat(64), expiresAt: new Date(Date.now() + 86400000).toISOString(), serverAt: now, revision: 20, clock: atVenue("17:15"), accessUntil: atVenue("00:45", "2026-11-15"), access: "producer", supplierId: null, cards, history: [], requests: [], preview: { revision: 20, digest: "b".repeat(64), ready: true, blockers: [], retained: [{ id: randomUUID(), supplierId: "brightline", supplier: "Brightline Rentals", unitId: "brightline-console-a", originalPlanVersion: 3, state: "needs_attention", feeMinor: 48000, depositMinor: 30000, verifiedFeeMinor: 48000, feeInstructionPending: false, accepted: true, current: true }], supplierTerms: cards.map(card => ({ supplierId: card.supplierId, termsId: null, termsDigest: null, sourceReportId: null })), disruptionDigest: "d".repeat(64), currentPlanVersion: 3, replacesApprovedPlan: true, program: "full" }, ...overrides };
}
export async function supplierRecoveryResultFixture(source: SupplierRecoveryWorkspace, envelope: SupplierRecoveryEnvelope): Promise<SupplierRecoveryResult> {
  const workspace = structuredClone(source), command = envelope.command, now = new Date().toISOString(), recordId = randomUUID(); workspace.revision++;
  if (command.type === "publish_terms") {
    const card = workspace.cards.find(item => item.offerId === command.offerId)!;
    card.reference = { id: recordId, digest: "e".repeat(64), supplierId: card.supplierId, revision: (card.reference?.revision ?? 0) + 1, publishedAt: now, validUntil: new Date(Date.now() + command.validForMinutes * 60000).toISOString(), sourceReportId: command.sourceReportId, source: "controlled_supplier_terms" };
    Object.assign(card, { input: command, feeMinor: command.feeMinor, depositMinor: command.depositMinor, deliveryAt: command.deliveryAt, scenarioDeadline: command.expiresAt, usable: true, blockers: [], actorLabel: card.supplier + " · scoped supplier access", scenarioAt: workspace.clock });
  }
  if (command.type === "request_quotes") {
    workspace.requests.unshift({ id: recordId, status: "collecting", lastCode: null, outcomes: [], sessionMatches: true, expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), createdAt: now });
    if (workspace.preview) { workspace.preview.ready = false; workspace.preview.blockers = ["Continue the original quote collection before another request."]; }
  }
  const receipt = { commandId: envelope.commandId, action: command.type, requestDigest: await supplierRecoveryRequestDigest(envelope), recordId, revision: workspace.revision, at: now, message: "Controlled original instruction saved. Every physical handoff and payment remains separate." };
  workspace.history.unshift(receipt);
  return { workspace, receipt, replayed: false, ...(command.type === "open_supplier" ? { invitation: { url: "/supplier/access#" + randomBytes(32).toString("base64url"), supplierId: command.supplierId, expiresAt: workspace.expiresAt } } : {}) };
}
