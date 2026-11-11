import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { approved, evidence } from "./helpers";
import { projectExecutionMilestones } from "../src/domain/milestones";
import { timelineProjection } from "../src/domain/adapters";
import { currentActual, financialSummary, uniqueActual } from "../src/domain/finance";
import { readiness } from "../src/domain/readiness";
import { atVenue } from "../src/domain/time";
import type { FinancialObservation, ShowSnapshot } from "../src/domain/contracts";

function rental() {
  const { show } = approved();
  show.financialEvidence.push(evidence(show, { kind: "authorization", purpose: "rental", providerResourceId: "AUTH-FIXTURE", amountMinor: 78000, recordedAt: "2026-11-10T12:00:00Z" }), evidence(show, { kind: "capture", purpose: "rental", providerResourceId: "CAPTURE-FIXTURE", amountMinor: 48000, parentId: "AUTH-FIXTURE", recordedAt: "2026-11-10T13:00:00Z" }));
  return show;
}
function observation(overrides: Partial<FinancialObservation> = {}): FinancialObservation {
  return { id: randomUUID(), seller: "brightline", kind: "capture", providerResourceId: "CAPTURE-FIXTURE", status: "COMPLETED", amountMinor: 48000, currency: "USD", parentId: "AUTH-FIXTURE", observedAt: "2026-11-11T12:00:00Z", transport: "paypal_https", ...overrides };
}
const state = (show: ShowSnapshot, id: string) => projectExecutionMilestones(show).tasks.find(task => task.id === id)?.state;
test("the scenario clock never completes money or delivery milestones", () => {
  const { show } = approved(); show.clock = atVenue("23:30");
  for (const id of ["rental-authorized", "rental-delivery", "rental-captured", "lx-focus", "lx-program"]) assert.notEqual(state(show, id), "complete");
});
test("actual current receipts complete only their own money milestones and native dependency styles", () => {
  const show = projectExecutionMilestones(rental());
  assert.equal(state(show, "rental-authorized"), "complete"); assert.equal(state(show, "rental-captured"), "complete"); assert.notEqual(state(show, "rental-delivery"), "complete");
  const native = timelineProjection(show.tasks, show.dependencies, show.resources);
  assert.equal(native.dependencies.find(edge => edge.from === "rental-captured")?.lineStyle, "solid");
  assert.equal(native.dependencies.find(edge => edge.from === "rental-delivery")?.lineStyle, "dashed");
  assert.equal(native.tasks.find(task => task.id === "rental-captured")?.percentDone, 100);
});
test("a capture reversal withdraws readiness without deleting historical captured revenue", () => {
  const show = rental(); show.financialObservations = [observation({ status: "REVERSED" })];
  assert.equal(uniqueActual(show).length, 2); assert.equal(currentActual(show).length, 1);
  assert.equal(financialSummary(show).rentalCapturedMinor, 48000); assert.equal(financialSummary(show).disputedEvidenceCount, 1);
  assert.equal(readiness(show, "DOORS").gates.find(gate => gate.id === "capture")?.complete, false);
  assert.equal(state(show, "rental-captured"), "blocked");
});
test("valid residual void preserves the original780 authorization and480 capture", () => {
  const show = rental(); show.financialEvidence.push(evidence(show, { kind: "void", purpose: "deposit", providerResourceId: "AUTH-FIXTURE", parentId: "AUTH-FIXTURE", amountMinor: 30000, recordedAt: "2026-11-10T14:00:00Z" }));
  show.financialObservations = [observation({ kind: "authorization", providerResourceId: "AUTH-FIXTURE", status: "VOIDED", amountMinor: 78000, parentId: null }), observation()];
  assert.equal(currentActual(show).length, 3); assert.equal(readiness(show, "DOORS").gates.find(gate => gate.id === "authorization")?.complete, true);
  assert.equal(financialSummary(show).releasedMinor, 30000); assert.equal(financialSummary(show).rentalCapturedMinor, 48000); assert.equal(financialSummary(show).remainingRentalAuthorizationMinor, 0);
});
test("an unexplained void, mismatched amount, or wrong currency cannot clear financial readiness", () => {
  for (const overrides of [{ status: "VOIDED", kind: "authorization" as const, providerResourceId: "AUTH-FIXTURE", amountMinor: 78000 }, { amountMinor: 47000 }, { currency: "EUR" }]) {
    const show = rental(); show.financialObservations = [observation(overrides)]; assert.equal(currentActual(show).length, 1);
  }
});
test("local verification fixtures, foreign merchants and older reads cannot replace real current evidence", () => {
  for (const overrides of [{ transport: "local_fixture" as const }, { seller: "venue" as const }, { observedAt: "2026-11-09T00:00:00Z" }]) {
    const show = rental(); show.financialObservations = [observation({ status: "REVERSED", ...overrides })]; assert.equal(currentActual(show).length, 2);
  }
});
test("current unknown or excess refund history cannot satisfy an exact15 perk remedy", () => {
  const { show } = approved(); show.tickets.push({ id: "ticket-fixture", tier: "vip", admissionMinor: 3500, perkMinor: 1500, captureId: "TICKET-CAPTURE", source: "live_sandbox", refundedMinor: 1500, status: "partially_refunded" });
  show.financialEvidence.push(evidence(show, { providerResourceId: "TICKET-CAPTURE", ticketId: "ticket-fixture", recordedAt: "2026-11-10T13:00:00Z" }), evidence(show, { kind: "refund", purpose: "vip_remedy", providerResourceId: "TICKET-REFUND", ticketId: "ticket-fixture", parentId: "TICKET-CAPTURE", amountMinor: 1500, recordedAt: "2026-11-10T14:00:00Z" }));
  for (const refundedMinor of [null, 3000, 5000]) { show.financialObservations = [observation({ seller: "venue", providerResourceId: "TICKET-CAPTURE", status: "PARTIALLY_REFUNDED", amountMinor: 5000, refundedMinor })]; assert.equal(financialSummary(show).refundedVipCount, 0); }
  show.financialObservations = [observation({ seller: "venue", providerResourceId: "TICKET-CAPTURE", status: "PARTIALLY_REFUNDED", amountMinor: 5000, refundedMinor: 1500 })];
  assert.equal(financialSummary(show).refundedVipCount, 1);
  assert.equal(financialSummary(show).grossCapturedMinor, 5000); assert.equal(financialSummary(show).ledgerTicketNetMinor, 3500);
});
test("an adverse signed wakeup blocks affected readiness until a fresh read resolves the requirement", () => {
  const show = rental(); show.financialObservations = [observation()];
  show.financialChecks = [{ id: "signed-update", seller: "brightline", eventType: "PAYMENT.CAPTURE.REVERSED", resources: [{ kind: "capture", id: "CAPTURE-FIXTURE" }], status: "pending", receivedAt: "2026-11-11T12:01:00Z", revision: show.revision + 1, resolvedAt: null, transport: "paypal_https" }];
  assert.equal(state(show, "rental-captured"), "blocked"); assert.equal(financialSummary(show).rentalCapturedMinor, 48000);
  show.financialChecks[0]!.status = "resolved"; show.financialChecks[0]!.resolvedAt = "2026-11-11T12:02:00Z";
  assert.equal(state(show, "rental-captured"), "complete");
});
