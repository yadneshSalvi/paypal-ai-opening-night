import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { approvedCandidate, buildCostCurve, costAt, holdAt, sampleCostCurve, type CostCurvePlan } from "../src/domain/cost-curve";
import { buildCandidate } from "../src/domain/scheduling";
import { atVenue, plusMinutes } from "../src/domain/time";
import type { Resource, ShowSnapshot, Task } from "../src/domain/contracts";
import { approved, base, disrupted, evidence, withRun } from "./helpers";

/** Independent oracle: walk the day minute by minute and charge each person at most once per minute. */
function minuteOracle(tasks: Pick<Task, "start" | "end" | "resources">[], resources: Resource[], until?: string) {
  let centMinutes = 0;
  for (const person of resources.filter(row => row.kind === "person")) {
    const minutes = new Set<number>();
    for (const task of tasks.filter(row => row.resources.includes(person.id))) for (let at = Date.parse(task.start); at < Math.min(Date.parse(task.end), until ? Date.parse(until) : Infinity); at += 60_000) minutes.add(at);
    centMinutes += minutes.size * person.rateMinor;
  }
  return Math.round(centMinutes / 60);
}
const end = (plan: CostCurvePlan, curve: { endAt: string }) => costAt(plan, curve.endAt);
const baselineTasks = (show: ShowSnapshot) => show.sheets[0].tasks.map(task => ({ ...task, start: task.baselineStart, end: task.baselineEnd }));

test("baseline labour is assigned time × roster rate, with overlapping calls costed once", () => {
  const { show } = base(), curve = buildCostCurve(show);
  assert.equal(curve.baseline.laborMinor, minuteOracle(baselineTasks(show), show.resources));
  assert.equal(curve.baseline.commitmentMinor, 0); assert.equal(curve.baseline.statedCostMinor, null); assert.equal(curve.baseline.hold, null);
  assert.equal(end(curve.baseline, curve), curve.baseline.laborMinor);
  // Alex has rigging checks 10:00–11:20 inside load-in 10:00–11:30: 90 paid minutes, not 170.
  const alexOnly = buildCostCurve({ ...show, resources: show.resources.filter(row => row.id === "alex") });
  assert.equal(costAt(alexOnly.baseline, atVenue("11:30")), Math.round(90 * 3500 / 60));
  // No approved plan: the current plan is the baseline and carries no recovery commitment.
  assert.equal(curve.current.approved, false); assert.equal(curve.current.totalMinor, curve.baseline.totalMinor); assert.equal(curve.candidate, null);
  assert.equal(curve.startAt, atVenue("10:00")); assert.equal(curve.endAt, atVenue("23:30"));
});

test("Protect doors reconciles exactly: $480 rental + $180 overtime + $570 VIP remedies = $1,230", () => {
  const { show } = approved(), candidate = approvedCandidate(show)!, curve = buildCostCurve(show), plan = curve.current;
  assert.equal(candidate.family, "doors"); assert.equal(plan.approved, true); assert.equal(plan.candidateId, candidate.id);
  assert.deepEqual(Object.fromEntries(plan.commitments.map(row => [row.id, row.amountMinor])), { vip_remedies: 57000, rental_fee: 48000, projected_overtime: 18000 });
  assert.equal(plan.commitmentMinor, 123000); assert.equal(plan.commitmentMinor, candidate.cost.totalMinor); assert.equal(plan.statedCostMinor, candidate.cost.totalMinor);
  assert.equal(plan.laborMinor, minuteOracle(show.tasks, show.resources));
  assert.equal(plan.totalMinor, plan.laborMinor + 123000);
  // The last point of the drawn series is the same number as the reconciled total.
  assert.equal(end(plan, curve), plan.totalMinor); assert.equal(curve.points.at(-1)!.currentMinor, plan.totalMinor); assert.equal(curve.points.at(-1)!.baselineMinor, curve.baseline.totalMinor);
  assert.equal(end(plan, curve) - plan.laborMinor, candidate.cost.rentalMinor + candidate.cost.overtimeMinor + candidate.cost.remedyMinor);
  // The deposit is a hold beside the curve, never inside it.
  assert.deepEqual({ amount: plan.hold!.amountMinor, from: plan.hold!.from }, { amount: 30000, from: candidate.patch.tasks.find(task => task.id === "rental-authorized")!.start });
  assert.equal(holdAt(curve, curve.endAt), 30000); assert.equal(plan.totalMinor - plan.laborMinor, 123000);
});

test("commitments land at their scenario instants and step the curve by their exact amount", () => {
  const { show } = approved(), candidate = approvedCandidate(show)!, curve = buildCostCurve(show), plan = curve.current;
  const at = Object.fromEntries(plan.commitments.map(row => [row.id, row.at]));
  assert.equal(at.vip_remedies, show.events.findLast(event => event.type === "rescue.approved")!.fixtureAt);
  assert.equal(at.rental_fee, plusMinutes(show.offers[0].deliveryAt, 5)); assert.equal(at.rental_fee, atVenue("17:20"));
  assert.equal(at.projected_overtime, candidate.patch.crewFinishAt); assert.equal(at.projected_overtime, atVenue("23:30"));
  for (const row of plan.commitments) assert.equal(costAt(plan, row.at) - costAt(plan, row.at, false), row.amountMinor, row.id);
  // A step is drawn as two points at the same instant.
  const rental = curve.points.filter(point => point.at === at.rental_fee); assert.equal(rental.length, 2); assert.equal(rental[1].currentMinor - rental[0].currentMinor, 48000); assert.equal(rental[1].baselineMinor, rental[0].baselineMinor);
  assert.equal(holdAt(curve, plusMinutes(plan.hold!.from, -1)), 0); assert.equal(holdAt(curve, plan.hold!.from), 30000);
  // Mid-curve readings agree with the independent oracle to the cent.
  for (const time of ["12:00", "15:25", "17:19", "17:20", "19:00", "22:15"]) {
    const due = plan.commitments.filter(row => Date.parse(row.at) <= Date.parse(atVenue(time))).reduce((sum, row) => sum + row.amountMinor, 0);
    assert.equal(costAt(plan, atVenue(time)), minuteOracle(show.tasks, show.resources, atVenue(time)) + due, time);
    assert.equal(costAt(curve.baseline, atVenue(time)), minuteOracle(baselineTasks(show), show.resources, atVenue(time)), time);
  }
  let previous = -1; for (const point of curve.points) { assert.ok(point.currentMinor >= previous); previous = point.currentMinor; }
});

test("a planned cost is modeled until a verified provider record exists, and never more than recorded", () => {
  const { show } = approved(), modeled = buildCostCurve(show).current;
  assert.deepEqual(modeled.commitments.map(row => [row.confirmation, row.confirmedMinor]), [["modeled", 0], ["modeled", 0], ["modeled", 0]]);
  assert.equal(modeled.hold!.authorizedMinor, 0);
  const authorization = evidence(show, { kind: "authorization", purpose: "rental", amountMinor: 78000 });
  show.financialEvidence.push(authorization, evidence(show, { kind: "capture", purpose: "rental", amountMinor: 48000, parentId: authorization.providerResourceId }));
  // A replayed capture is not provider-verified money.
  show.financialEvidence.push(evidence(show, { kind: "capture", purpose: "rental", amountMinor: 48000, source: "replay" }));
  for (let index = 0; index < 2; index++) {
    const id = randomUUID(), capture = evidence(show, { ticketId: id });
    show.tickets.push({ id, tier: "vip", admissionMinor: 3500, perkMinor: 1500, captureId: capture.providerResourceId, source: "live_sandbox", refundedMinor: 1500, status: "partially_refunded" });
    show.financialEvidence.push(capture, evidence(show, { kind: "refund", purpose: "vip_remedy", amountMinor: 1500, parentId: capture.providerResourceId, ticketId: id }));
  }
  const plan = buildCostCurve(show).current, by = Object.fromEntries(plan.commitments.map(row => [row.id, row]));
  assert.deepEqual([by.rental_fee.confirmation, by.rental_fee.confirmedMinor], ["confirmed", 48000]);
  assert.deepEqual([by.vip_remedies.confirmation, by.vip_remedies.confirmedMinor], ["partly_confirmed", 3000]);
  assert.deepEqual([by.projected_overtime.confirmation, by.projected_overtime.confirmedMinor], ["modeled", 0]);
  assert.equal(plan.hold!.authorizedMinor, 30000); assert.equal(plan.hold!.releasedMinor, 0);
  // Confirmation never changes the planned curve.
  assert.equal(plan.commitmentMinor, 123000); assert.equal(plan.totalMinor, modeled.totalMinor);
});

test("a previewed candidate is drawn beside the baseline and reconciles to its own stated cost", () => {
  const { show } = withRun();
  for (const [family, offerIndex, total] of [["doors", 0, 123000], ["budget", 1, 114000]] as const) {
    const candidate = buildCandidate(show, show.offers[offerIndex], family), curve = buildCostCurve(show, candidate), plan = curve.candidate!;
    assert.equal(candidate.cost.totalMinor, total); assert.equal(plan.commitmentMinor, total); assert.equal(plan.approved, false);
    assert.equal(plan.laborMinor, minuteOracle(candidate.patch.tasks, show.resources));
    assert.equal(end(plan, curve), plan.laborMinor + total); assert.equal(curve.points.at(-1)!.candidateMinor, plan.totalMinor);
    assert.ok(plan.commitments.every(row => row.confirmation === "modeled" && row.confirmedMinor === 0));
    assert.equal(plan.commitments.find(row => row.id === "vip_remedies")!.at, candidate.patch.tasks.find(task => task.id === "rental-authorized")!.start);
    // Nothing is approved, so the current plan carries no commitment and the hold shown is the preview's.
    assert.equal(curve.current.commitmentMinor, 0); assert.equal(holdAt(curve, curve.endAt), 30000);
  }
  // The approved candidate is never duplicated as a preview.
  const done = approved().show; assert.equal(buildCostCurve(done, approvedCandidate(done)).candidate, null);
});

test("the table sampling ends on the reconciled totals", () => {
  const { show } = approved(), curve = buildCostCurve(show), rows = sampleCostCurve(curve, 60);
  assert.equal(rows[0].at, curve.startAt); assert.equal(rows.at(-1)!.at, curve.endAt);
  assert.equal(rows.at(-1)!.currentMinor, curve.current.totalMinor); assert.equal(rows.at(-1)!.baselineMinor, curve.baseline.totalMinor); assert.equal(rows.at(-1)!.holdMinor, 30000);
  assert.equal(rows.length, 15);
  // Disrupted but unapproved: still no commitment.
  assert.equal(buildCostCurve(disrupted().show).current.commitmentMinor, 0);
});
