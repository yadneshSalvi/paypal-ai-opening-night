import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { atVenue } from "../src/domain/time";
import { applicableRate, calculatePay, personSettlement } from "../src/domain/settlement/commands";
import { personalSettlementEnvelopeSchema, producerSettlementEnvelopeSchema } from "../src/domain/settlement/contracts";
import { minutePay, parseHourlyRate } from "../src/domain/settlement/money";
import { settlementFixture } from "./settlement-fixtures";

const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === wanted);
test("money calculations use integer minutes and round each agreed component once", () => {
  assert.equal(parseHourlyRate("35.01"), 3501); assert.equal(parseHourlyRate("0.01"), 1);
  for (const input of ["3e2", "1,000", "35.001", "-1", "0", "Infinity", ""]) assert.equal(parseHourlyRate(input), null);
  assert.equal(minutePay(61, 3501), 3559); assert.equal(minutePay(1, 30), 1);
  assert.deepEqual(calculatePay(2, { hourlyMinor: 33, overtimeHourlyMinor: 45, regularMinutes: 1 }), { workedMinutes: 2, regularMinutes: 1, overtimeMinutes: 1, regularMinor: 1, overtimeMinor: 1, totalMinor: 2, currency: "USD", rounding: "half_up_per_component" });
  assert.throws(() => minutePay(60.5, 3500)); assert.throws(() => minutePay(1441, 3500));
});
test("reports do not infer approved rates from roster estimates or make provider and physical claims", () => {
  const value = settlementFixture(), before = structuredClone(value.show), report = value.apply(value.report());
  assert.equal(report.kind, "time_report"); assert.equal(report.source, "controlled_client");
  const person = personSettlement(value.show, value.state, "priya"); assert.equal(person.rates.length, 0); assert.equal(person.reports[0].preview, null); assert.match(person.reports[0].reviewBlockers.join(" "), /rate agreement/);
  assert.deepEqual(value.show.tasks, before.tasks); assert.deepEqual(value.show.financialEvidence, before.financialEvidence); assert.equal(person.approvedBalanceMinor, 0);
});
test("reported breaks reduce work once and daily overtime is calculated across all intervals", () => {
  const value = settlementFixture(); value.apply(value.rate({ regularMinutes: 240 }));
  const report = value.apply(value.report({ intervals: [{ start: atVenue("08:00"), end: atVenue("12:00"), unpaidMinutes: 30 }, { start: atVenue("12:30"), end: atVenue("15:00"), unpaidMinutes: 0 }] }));
  const payable = value.apply(value.approve(report.id)); assert.equal(payable.kind, "payable"); if (payable.kind !== "payable") return;
  assert.equal(payable.calculation.workedMinutes, 360); assert.equal(payable.calculation.regularMinutes, 240); assert.equal(payable.calculation.overtimeMinutes, 120); assert.equal(payable.deltaMinor, 24500);
});
test("a second same-day report must name the exact correction chain", () => {
  const value = settlementFixture(), first = value.apply(value.report());
  assert.throws(() => value.apply(value.report()), code("TIME_CORRECTION_CHANGED"));
  assert.throws(() => value.apply(value.report({ replacesId: randomUUID() })), code("TIME_CORRECTION_CHANGED"));
  const next = value.apply(value.report({ replacesId: first.id })); assert.equal(next.kind, "time_report"); if (next.kind === "time_report") assert.equal(next.version, 2);
  assert.equal(value.state.records.filter(item => item.kind === "time_report").length, 2);
});
test("positive, negative and zero corrections retain original payables and post only the delta", () => {
  const value = settlementFixture(); value.apply(value.rate());
  let report = value.apply(value.report()); const original = value.apply(value.approve(report.id)); const originalCopy = structuredClone(original);
  for (const [end, delta, liability] of [["13:00", 1750, 5250], ["12:00", -3500, 1750], ["12:00", 0, 1750]] as const) {
    report = value.apply(value.report({ replacesId: report.id, intervals: [{ start: atVenue("11:30"), end: atVenue(end), unpaidMinutes: 0 }] }));
    assert.equal(personSettlement(value.show, value.state, "priya").pendingReports, 1);
    const command = value.approve(report.id), payable = value.apply(command); assert.equal(payable.kind, "payable"); if (payable.kind !== "payable") continue;
    assert.equal(payable.deltaMinor, delta); assert.equal(payable.calculation.totalMinor, liability); assert.equal(personSettlement(value.show, value.state, "priya").approvedBalanceMinor, liability);
    assert.throws(() => value.apply(command), code("TIME_REPORT_ALREADY_APPROVED"));
  }
  assert.deepEqual(value.state.records.find(item => item.id === original.id), originalCopy); assert.equal(personSettlement(value.show, value.state, "priya").creditAdjustments, 1); assert.equal(value.show.financialEvidence.length, 0);
});
test("effective rate versions never silently recalculate an earlier approved liability", () => {
  const value = settlementFixture(), rate = value.apply(value.rate()), report = value.apply(value.report()), first = value.apply(value.approve(report.id));
  value.apply(value.rate({ previousRateId: rate.id, effectiveFrom: "2026-11-15", hourlyMinor: 4500, overtimeHourlyMinor: 6750 }));
  assert.equal(applicableRate(value.state, "priya", "2026-11-14")!.id, rate.id); assert.equal(personSettlement(value.show, value.state, "priya").approvedBalanceMinor, 3500);
  const nextRate = value.state.records.at(-1)!; value.apply(value.rate({ previousRateId: nextRate.id, hourlyMinor: 4000, overtimeHourlyMinor: 6000 }));
  assert.deepEqual(value.state.records.find(item => item.id === first.id), first);
  const correction = value.apply(value.report({ replacesId: report.id })), preview = personSettlement(value.show, value.state, "priya").reports.find(item => item.report.id === correction.id)!.preview!;
  assert.equal(preview.deltaMinor, 500); assert.ok(preview.warnings.some(item => item.includes("rate changed")));
});
test("stale roster, rate and exact calculation references hold payable approval", () => {
  const value = settlementFixture(), rate = value.apply(value.rate()), report = value.apply(value.report()), command = value.approve(report.id);
  assert.throws(() => value.apply({ ...command, reviewDigest: "a".repeat(64) }), code("PAYABLE_REVIEW_CHANGED"));
  value.apply(value.rate({ previousRateId: rate.id, hourlyMinor: 4000, overtimeHourlyMinor: 6000 }));
  assert.throws(() => value.apply(command), code("PAYABLE_REVIEW_CHANGED"));
  value.show.resources.find(item => item.id === "priya")!.role = "Revised assigned role";
  assert.equal(personSettlement(value.show, value.state, "priya").reports[0].preview, null); assert.throws(() => value.apply(command), code("PAYABLE_REVIEW_BLOCKED"));
});
test("requested changes preserve the original and require a new personal submission", () => {
  const value = settlementFixture(); value.apply(value.rate()); const report = value.apply(value.report());
  value.apply({ type: "request_time_changes", reportId: report.id, detail: "Please explain the work outside the published calls." });
  assert.equal(personSettlement(value.show, value.state, "priya").reports[0].status, "changes_requested");
  assert.throws(() => value.apply({ type: "request_time_changes", reportId: report.id, detail: "Please clarify the reported work once again." }), code("TIME_CHANGES_ALREADY_REQUESTED"));
  const correction = value.apply(value.report({ replacesId: report.id })); value.apply(value.approve(correction.id));
  assert.equal(personSettlement(value.show, value.state, "priya").approvedBalanceMinor, 3500); assert.equal(value.state.records.filter(item => item.kind === "changes_requested").length, 1);
});
test("time is bounded, minute-aligned, nonoverlapping and completed within scenario time", () => {
  const invalid = [
    { start: atVenue("12:30"), end: atVenue("11:30"), unpaidMinutes: 0 },
    { start: atVenue("11:30"), end: atVenue("12:30"), unpaidMinutes: 60 },
    { start: atVenue("15:00"), end: atVenue("16:00"), unpaidMinutes: 0 },
    { start: "2026-11-14T17:30:01Z", end: atVenue("12:30"), unpaidMinutes: 0 },
  ];
  for (const interval of invalid) { const value = settlementFixture(); assert.throws(() => value.apply(value.report({ intervals: [interval] }))); assert.equal(value.state.revision, 0); }
  const overlap = settlementFixture(); assert.throws(() => overlap.apply(overlap.report({ intervals: [{ start: atVenue("11:00"), end: atVenue("12:00"), unpaidMinutes: 0 }, { start: atVenue("11:30"), end: atVenue("13:00"), unpaidMinutes: 0 }] })), code("TIME_INTERVAL_INVALID"));
  const midnight = settlementFixture(); midnight.setClock(atVenue("10:00", "2026-11-15"));
  midnight.apply(midnight.report({ intervals: [{ start: atVenue("23:00"), end: atVenue("01:00", "2026-11-15"), unpaidMinutes: 0 }] }));
  assert.throws(() => midnight.apply(midnight.report({ serviceDay: "2026-11-15", intervals: [{ start: atVenue("00:30", "2026-11-15"), end: atVenue("02:00", "2026-11-15"), unpaidMinutes: 0 }] })), code("TIME_REPORT_OVERLAP"));
});
test("only the assigned capability reports; producer review cannot be delegated through the body", () => {
  const value = settlementFixture(); assert.throws(() => value.apply(value.report(), value.producer), code("CREW_CAPABILITY_REQUIRED"));
  assert.throws(() => value.apply(value.rate(), value.crew), code("SETTLEMENT_PRODUCER_REQUIRED"));
  assert.throws(() => value.apply(value.rate(), { ...value.producer, roles: ["stage_manager"] }), code("SETTLEMENT_PRODUCER_REQUIRED"));
  const envelope = { idempotencyKey: randomUUID(), expectedRevision: 0, expectedShowRevision: 1, command: value.report() };
  assert.equal(personalSettlementEnvelopeSchema.safeParse({ ...envelope, personId: "sam" }).success, false);
  assert.equal(personalSettlementEnvelopeSchema.safeParse({ ...envelope, command: { ...envelope.command, confirmed: false } }).success, false);
  assert.equal(producerSettlementEnvelopeSchema.safeParse(envelope).success, false);
});
