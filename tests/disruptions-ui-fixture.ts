import { randomUUID } from "node:crypto";
import type { CancellationPreview, DisruptionEnvelope, DisruptionMode, DisruptionResult, DisruptionWorkspace } from "../src/server/disruptions/contracts";
import { disruptionRequestDigest } from "../src/components/disruptions/recovery";

export function disruptionUiFixture(overrides: Partial<DisruptionWorkspace> = {}): DisruptionWorkspace {
  const now = new Date().toISOString(), executionId = randomUUID();
  const offers: DisruptionWorkspace["offers"] = [
    { id: "brightline-current", revision: 2, supplierId: "brightline", supplier: "Brightline Rentals", unitId: "LX-204", deliveryAt: "2026-11-14T23:15:00Z", executionId, executionState: "reconfirmation_required" },
    { id: "northside-current", revision: 1, supplierId: "northside", supplier: "Northside AV", unitId: "NS-009", deliveryAt: "2026-11-14T23:45:00Z", executionId: null, executionState: null },
    { id: "sister-current", revision: 1, supplierId: "sister", supplier: "Sister Venue", unitId: "SV-001", deliveryAt: "2026-11-15T00:20:00Z", executionId: null, executionState: null },
  ];
  return {
    tenantId: randomUUID(), actorId: "producer:ui-review", sessionFingerprint: "a".repeat(64), access: "producer", expiresAt: new Date(Date.now() + 3600000).toISOString(), revision: 12, clock: "2026-11-14T22:10:00Z", providerActionsEnabled: false, offers,
    reports: [{ id: randomUUID(), offerId: offers[0]!.id, offerRevision: 2, supplierId: "brightline", unitId: "LX-204", executionId, availability: "delayed", earliestAt: "2026-11-15T03:00:00Z", observedAt: now, recordedAt: now, reference: "Controlled supplier call 014", detail: "The controlled source reports an unavailable driver until the later delivery window.", actorId: "producer:ui-review", attribution: "production_operator", source: "controlled_client", revision: 11 }],
    assessments: [{ id: randomUUID(), createdAt: now, sourceDigest: "b".repeat(64), disruptionDigest: "c".repeat(64), baseRevision: 11, runId: randomUUID(), candidateIds: Array.from({ length: 12 }, (_, index) => `candidate-${index + 1}`), generated: 12, feasible: 0, pending: 0, infeasible: 12, conclusion: "no_feasible_candidate", reasons: [{ code: "CONSOLE_DELIVERY", count: 8 }, { code: "CURFEW", count: 7 }], enginePassed: 12, engineUnavailable: 0, scope: "Three enrolled offers × four deterministic running-order families. This bounded search is not a proof about every possible production.", source: "deterministic_enumerator" }],
    assessmentIsCurrent: true, decision: null, remedies: [], historicalDecisions: [],
    rentalCommitments: [{ id: executionId, supplier: "Brightline Rentals", unitId: "LX-204", state: "reconfirmation_required", authorizationMinor: 78000, capturedMinor: 0, canCancel: true, blocker: null }, { id: randomUUID(), supplier: "Retained captured supplier", unitId: "PA-100", state: "returned", authorizationMinor: 60000, capturedMinor: 48000, canCancel: false, blocker: "Captured rental fees remain actual costs; review the original capture and supplier terms separately." }],
    obligations: [
      { label: "Supplier commitment", detail: "Original authorizations and captured rental fees remain on the supplier ledger.", amountMinor: 78000, href: "/execution" },
      { label: "Crew obligations", detail: "Published calls, earned work, settlement lines and payout instructions remain recorded.", amountMinor: null, href: "/crew" },
      { label: "House and audience", detail: "The notice is internal. Audience delivery and physical safety need their own evidence.", amountMinor: null, href: "/wrap" },
      { label: "Original payment history", detail: "Every capture and prior refund remains visible in the original ledger.", amountMinor: 13500, href: "/box-office" },
    ], ...overrides,
  };
}
export function disruptionPreviewFixture(workspace: DisruptionWorkspace, mode: DisruptionMode, admissionRefundMinor: number): CancellationPreview {
  return { digest: "d".repeat(64), revision: workspace.revision, mode, admissionRefundMinor, ready: true, capturedTickets: 3, admissionMinor: admissionRefundMinor * 3, perkMinor: 1500, newRefundMinor: admissionRefundMinor * 3 + 1500, alreadyRefundedMinor: 1500, preservedAdmissionMinor: (3500 - admissionRefundMinor) * 3, blockers: [], obligations: workspace.obligations,
    lines: [{ ticketId: "T-001", tier: "standard", captureReference: "••••111111", priorRefundMinor: 0, admissionMinor: admissionRefundMinor, perkMinor: 0, amountMinor: admissionRefundMinor }, { ticketId: "T-002", tier: "vip", captureReference: "••••222222", priorRefundMinor: 1500, admissionMinor: admissionRefundMinor, perkMinor: 0, amountMinor: admissionRefundMinor }, { ticketId: "T-003", tier: "vip", captureReference: "••••333333", priorRefundMinor: 0, admissionMinor: admissionRefundMinor, perkMinor: 1500, amountMinor: admissionRefundMinor + 1500 }] };
}
export async function disruptionResultFixture(workspace: DisruptionWorkspace, envelope: DisruptionEnvelope, overrides: Partial<DisruptionResult> = {}): Promise<DisruptionResult> {
  return { workspace: { ...workspace, revision: Math.max(workspace.revision, envelope.expectedRevision + 1) }, receipt: { commandId: envelope.idempotencyKey, action: envelope.command.type, requestDigest: await disruptionRequestDigest(envelope), recordId: randomUUID(), revision: envelope.expectedRevision + 1, message: "The reviewed controlled instruction is recorded; original provider results remain separate.", at: new Date().toISOString() }, replayed: false, ...overrides };
}
