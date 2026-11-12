import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { approved, evidence, publishForTest, testEngine } from "./helpers";
import { disruptionDigest, operatingDigest, refundAllocation, summarizeAssessment, type SupplierDisruption } from "../src/domain/disruptions";
import { enumerateCandidates, planningDigest } from "../src/domain/scheduling";
import { readiness } from "../src/domain/readiness";
import { currentCrewReview, personalCalls, personalRest } from "../src/domain/crew/policy";
import { calendarProjection, timelineProjection } from "../src/domain/adapters";
import { taskExecutionPresentation } from "../src/domain/task-presentation";
import { taskAriaLabel } from "../src/domain/labels";
import { atVenue } from "../src/domain/time";
import { financialSummary } from "../src/domain/finance";

function report(offer: { id: string; revision: number; supplierId: string; unitId: string }, availability: SupplierDisruption["availability"] = "unavailable"): SupplierDisruption {
  return { id: randomUUID(), offerId: offer.id, offerRevision: offer.revision, supplierId: offer.supplierId, unitId: offer.unitId, executionId: null, availability, earliestAt: availability === "unavailable" ? null : atVenue("21:30"), observedAt: new Date().toISOString(), recordedAt: new Date().toISOString(), reference: "Controlled supplier report", detail: "The original unit cannot meet this delivery window.", actorId: "supplier:controlled", attribution: "supplier_client", source: "controlled_client", revision: 7 };
}
test("supplier facts invalidate the source digest and use the later time without rewriting the quote", () => {
  const { show } = approved(), offer = show.offers.find(item => item.supplierId === "brightline")!, original = structuredClone(offer), before = planningDigest(show);
  show.supplierDisruptions = [report(offer, "delayed")];
  const candidates = enumerateCandidates(show), candidate = candidates.find(item => item.family === "doors" && item.patch.offerId === offer.id)!;
  assert.notEqual(planningDigest(show), before); assert.deepEqual(offer, original);
  assert.equal(candidate.patch.tasks.find(task => task.id === "rental-delivery")!.start, atVenue("21:30"));
  assert.ok(candidate.report.issues.some(issue => issue.code === "SUPPLIER_TERMS_RECONFIRMATION"));
  assert.ok(candidate.report.issues.some(issue => issue.code === "DOORS_SEQUENCE"));
});
test("all current offers withdrawn yields twelve bounded infeasible results, retaining real-engine status separately", () => {
  const { show } = approved(); show.supplierDisruptions = show.offers.map(offer => report(offer));
  const candidates = enumerateCandidates(show); candidates.forEach(candidate => { candidate.report.engine = testEngine(candidate); });
  const assessment = summarizeAssessment(candidates);
  assert.equal(assessment.generated, 12); assert.equal(assessment.feasible, 0); assert.equal(assessment.infeasible, 12); assert.equal(assessment.conclusion, "no_feasible_candidate");
  assert.equal(assessment.reasons.find(reason => reason.code === "SUPPLIER_UNAVAILABLE")!.count, 12);
  candidates[0]!.report.engine!.status = "unavailable";
  assert.equal(summarizeAssessment(candidates).conclusion, "evidence_pending");
});
test("a supplier reconfirmation needs newly signed terms before an old quote can become approvable", () => {
  const { show } = approved(), offer = show.offers[0]!;
  show.supplierDisruptions = [report(offer, "available")];
  assert.ok(enumerateCandidates(show).filter(candidate => candidate.patch.offerId === offer.id).every(candidate => candidate.report.issues.some(issue => issue.code === "SUPPLIER_TERMS_RECONFIRMATION")));
  offer.revision++; offer.deliveryAt = atVenue("21:30");
  assert.ok(enumerateCandidates(show).filter(candidate => candidate.patch.offerId === offer.id).every(candidate => !candidate.report.issues.some(issue => issue.code === "SUPPLIER_TERMS_RECONFIRMATION")));
});
test("old cue and crew review clearance withdraws while original receipts and signed history survive", () => {
  const { show } = publishForTest(); show.crewProtocol = 1;
  assert.ok(currentCrewReview(show));
  const evidenceBefore = structuredClone(show.financialEvidence), sheetsBefore = structuredClone(show.sheets);
  show.supplierDisruptions = [report(show.offers.find(offer => offer.supplierId === "brightline")!)];
  assert.equal(currentCrewReview(show), null);
  for (const scope of ["DOORS", "SUPPORT_START", "HEADLINER_START"] as const) { const result = readiness(show, scope); assert.equal(result.ready, false); assert.equal(result.gates.find(gate => gate.id === "disruption")!.complete, false); }
  assert.deepEqual(show.financialEvidence, evidenceBefore); assert.deepEqual(show.sheets, sheetsBefore);
  assert.notEqual(show.sheets.at(-1)!.operatingDigest, operatingDigest(show));
});
test("refund allocation separates prior VIP compensation from new admission compensation", () => {
  const { show } = approved(), ticketId = randomUUID(), captureId = "CONTROLLED-ORIGINAL";
  show.tickets.push({ id: ticketId, tier: "vip", admissionMinor: 3500, perkMinor: 1500, captureId, refundedMinor: 2500, source: "live_sandbox", status: "partially_refunded" });
  show.financialEvidence.push(evidence(show, { ticketId, providerResourceId: captureId }), evidence(show, { kind: "refund", purpose: "vip_remedy", parentId: captureId, ticketId, amountMinor: 1500 }), evidence(show, { kind: "refund", purpose: "event_remedy", parentId: captureId, ticketId, amountMinor: 1000, allocation: { decisionId: randomUUID(), admissionMinor: 1000, perkMinor: 0 } }));
  const allocation = refundAllocation(show, ticketId); assert.equal(allocation.admissionMinor, 1000); assert.equal(allocation.perkMinor, 1500); assert.equal(allocation.unallocatedMinor, 0);
  const finance = financialSummary(show); assert.equal(finance.grossCapturedMinor, 5000); assert.equal(finance.ledgerTicketNetMinor, 2500); assert.equal(finance.settledTicketRefundMinor, 2500);
  const prior = disruptionDigest(show); show.supplierDisruptions = [report(show.offers[0]!)]; assert.notEqual(disruptionDigest(show), prior);
});

test("cancelled calls are explicit in native, accessible and personal projections without erasing the shift", () => {
  const { show } = publishForTest(), originalRest = personalRest(show, "sam");
  const task = show.tasks.find(item => item.id === "headliner")!, original = structuredClone(task);
  task.cancellation = { decisionId: randomUUID(), reason: "Headliner cancelled after the supplier disruption." };
  show.sheets.at(-1)!.tasks = structuredClone(show.tasks);
  assert.equal(taskExecutionPresentation(show, task).label, "Cancelled");
  assert.match(taskAriaLabel(task), /^Cancelled\. Original call retained\./);
  for (const projection of [timelineProjection(show.tasks, show.dependencies, show.resources).tasks, calendarProjection(show.tasks, show.resources).events]) {
    const projected = projection.find(item => item.id === task.id)!;
    assert.match(projected.name, /^Cancelled · /); assert.equal(projected.startDate, original.start); assert.equal(projected.endDate, original.end);
  }
  assert.match(personalCalls(show, "sam").find(item => item.id === task.id)!.name, /^Cancelled · /);
  assert.deepEqual(personalRest(show, "sam"), originalRest);
});
