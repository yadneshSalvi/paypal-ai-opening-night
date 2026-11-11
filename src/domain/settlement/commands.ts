import { Temporal } from "@js-temporal/polyfill";
import { DomainError, type Actor, type Resource, type ShowSnapshot } from "../contracts";
import { requireCrewPerson } from "../crew/policy";
import { digest } from "../hash";
import { atZone } from "../time";
import { minutePay } from "./money";
import type { ApprovedRate, Payable, PayableReview, PersonSettlement, ReportedInterval, ReportView, SettlementCommand, SettlementReceipt, SettlementRecord, SettlementRecordContext, SettlementState, TimeReport } from "./contracts";

export const emptySettlement = (): SettlementState => ({ schemaVersion: 1, revision: 0, records: [] });
export function requireSettlementProducer(actor: Actor) {
  if (actor.personId || actor.executionId || actor.supplierId || !actor.roles.includes("producer") || actor.roles.includes("crew")) throw new DomainError("SETTLEMENT_PRODUCER_REQUIRED", "Only the producer can approve rates and crew liabilities.", 403);
}
export function settlementDays(show: ShowSnapshot) { return [show.showDate, Temporal.PlainDate.from(show.showDate).add({ days: 1 }).toString()]; }
const personDigest = (person: Resource) => digest({ id: person.id, name: person.name, role: person.role, kind: person.kind, skills: [...person.skills].sort() });
const reports = (state: SettlementState) => state.records.filter((record): record is TimeReport => record.kind === "time_report");
const payables = (state: SettlementState) => state.records.filter((record): record is Payable => record.kind === "payable");
export const rates = (state: SettlementState) => state.records.filter((record): record is ApprovedRate => record.kind === "rate");
export function currentReport(state: SettlementState, personId: string, day: string) { return reports(state).findLast(report => report.personId === personId && report.serviceDay === day) ?? null; }
export function applicableRate(state: SettlementState, personId: string, day: string) { return rates(state).findLast(rate => rate.personId === personId && rate.effectiveFrom <= day) ?? null; }
function previousPayable(state: SettlementState, report: TimeReport) {
  const dayReports = new Set(reports(state).filter(item => item.personId === report.personId && item.serviceDay === report.serviceDay).map(item => item.id));
  return payables(state).findLast(item => dayReports.has(item.reportId)) ?? null;
}
function ownedPerson(show: ShowSnapshot, personId: string) {
  const person = show.resources.find(item => item.id === personId && item.kind === "person");
  if (!person) throw new DomainError("SETTLEMENT_PERSON_NOT_FOUND", "This person is not on this production’s roster.", 404);
  return person;
}
function minuteInstant(value: string) {
  try { const instant = Temporal.Instant.from(value); if (instant.epochMilliseconds % 60000 !== 0) throw new Error(); return instant; }
  catch { throw new DomainError("TIME_MINUTE_REQUIRED", "Report start and finish times to the exact minute.", 400); }
}
function validateIntervals(show: ShowSnapshot, state: SettlementState, personId: string, day: string, intervals: ReportedInterval[]) {
  if (!settlementDays(show).includes(day)) throw new DomainError("TIME_DAY_OUTSIDE_PRODUCTION", "Choose this production day or its published next day.", 400);
  const startOfDay = Date.parse(atZone(day, "00:00", show.zone)), nextDay = Date.parse(atZone(Temporal.PlainDate.from(day).add({ days: 1 }).toString(), "00:00", show.zone));
  const normalized = intervals.map(item => ({ ...item, start: minuteInstant(item.start).toString(), end: minuteInstant(item.end).toString() }));
  const first = Date.parse(normalized[0].start), last = Date.parse(normalized.at(-1)!.end);
  if (first < startOfDay || first >= nextDay || last - first > 1440 * 60000) throw new DomainError("TIME_SHIFT_RANGE", "The first interval must start on the selected service day, within a shift of at most 24 hours.", 400);
  let minutes = 0, unpaidMinutes = 0, previousEnd = -Infinity;
  for (const interval of normalized) {
    const start = Date.parse(interval.start), end = Date.parse(interval.end), gross = (end - start) / 60000;
    if (gross <= 0 || gross > 1440 || start < previousEnd || interval.unpaidMinutes >= gross) throw new DomainError("TIME_INTERVAL_INVALID", "Use ordered, non-overlapping intervals with positive work after unpaid breaks.", 400);
    if (end > Date.parse(show.clock)) throw new DomainError("TIME_NOT_FINISHED", "A report cannot finish after the current production scenario time. Report only the time already completed in this rehearsal.");
    minutes += gross - interval.unpaidMinutes; unpaidMinutes += interval.unpaidMinutes; previousEnd = end;
  }
  if (minutes < 1 || minutes > 1440) throw new DomainError("TIME_TOTAL_OUTSIDE_LIMIT", "Reported work must total between one minute and 24 hours.", 400);
  const otherDays = reports(state).filter(item => item.personId === personId && item.serviceDay !== day && currentReport(state, personId, item.serviceDay)?.id === item.id);
  if (otherDays.some(report => report.intervals.some(a => normalized.some(b => Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end))))) throw new DomainError("TIME_REPORT_OVERLAP", "These intervals overlap this person’s report for another service day. Correct that report before submitting overlapping hours.");
  return { intervals: normalized, minutes, unpaidMinutes, spanMinutes: (last - first) / 60000 };
}
function fullyCovered(interval: ReportedInterval, calls: TimeReport["sheet"]["calls"]) {
  let cursor = Date.parse(interval.start);
  for (const call of [...calls].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    if (Date.parse(call.end) <= cursor) continue;
    if (Date.parse(call.start) > cursor) break;
    cursor = Math.max(cursor, Date.parse(call.end));
    if (cursor >= Date.parse(interval.end)) return true;
  }
  return false;
}
export function calculatePay(minutes: number, rate: Pick<ApprovedRate, "hourlyMinor" | "overtimeHourlyMinor" | "regularMinutes">) {
  const regularMinutes = Math.min(minutes, rate.regularMinutes), overtimeMinutes = Math.max(0, minutes - regularMinutes);
  const regularMinor = minutePay(regularMinutes, rate.hourlyMinor), overtimeMinor = minutePay(overtimeMinutes, rate.overtimeHourlyMinor);
  return { workedMinutes: minutes, regularMinutes, overtimeMinutes, regularMinor, overtimeMinor, totalMinor: regularMinor + overtimeMinor, currency: "USD" as const, rounding: "half_up_per_component" as const };
}
export function payableReview(show: ShowSnapshot, state: SettlementState, reportId: string): { preview: PayableReview | null; blockers: string[] } {
  const report = reports(state).find(item => item.id === reportId);
  if (!report) return { preview: null, blockers: ["This time report is not in the current production."] };
  const blockers: string[] = [], person = show.resources.find(item => item.id === report.personId && item.kind === "person");
  if (currentReport(state, report.personId, report.serviceDay)?.id !== report.id) blockers.push("A newer correction replaces this report.");
  if (payables(state).some(item => item.reportId === report.id)) blockers.push("This exact report already has an approved payable.");
  if (state.records.some(item => item.kind === "changes_requested" && item.reportId === report.id)) blockers.push("Changes were requested. The person must submit a corrected report.");
  if (!person || personDigest(person) !== report.personDigest) blockers.push("The roster identity or role changed. Ask the person to submit a report against the current roster.");
  const rate = applicableRate(state, report.personId, report.serviceDay);
  if (!rate) blockers.push("Approve an applicable rate agreement before reviewing this report.");
  else if (!person || rate.personDigest !== personDigest(person)) blockers.push("Approve a rate version for the current roster identity and role.");
  if (blockers.length || !rate) return { preview: null, blockers };
  const calculation = calculatePay(report.minutes, rate), previous = previousPayable(state, report);
  const previousLiabilityMinor = previous?.calculation.totalMinor ?? 0, deltaMinor = calculation.totalMinor - previousLiabilityMinor;
  const warnings: string[] = [];
  if (report.spanMinutes > show.policy.maxShiftMinutes) warnings.push(`The reported shift spans ${report.spanMinutes} minutes, above this production’s ${show.policy.maxShiftMinutes}-minute setting. Review the actual arrangement; this is not a compliance clearance.`);
  if (report.intervals.some(interval => !fullyCovered(interval, report.sheet.calls))) warnings.push("Some reported time is outside the referenced published calls. Review the explanation for this variance.");
  if (previous) warnings.push(`This is a correction to an approved ${previous.calculation.totalMinor / 100} USD liability. Only the ${deltaMinor / 100} USD difference becomes a new adjustment.`);
  if (previous && previous.rateId !== rate.id) warnings.push("The applicable approved rate changed since the previous payable. Review both versions.");
  if (deltaMinor < 0) warnings.push("This credit adjustment does not return money or authorize a deduction. Any later settlement must review the credit explicitly.");
  const body = { reportId, rateId: rate.id, rateVersion: rate.version, calculation, previousPayableId: previous?.id ?? null, previousLiabilityMinor, deltaMinor, warnings };
  return { preview: { ...body, digest: digest({ ...body, reportDigest: digest(report), rateDigest: digest(rate), settlementRevision: state.revision, productionRevision: show.revision }) }, blockers: [] };
}
export function settlementReceipt(record: SettlementRecord): SettlementReceipt { return { id: record.id, commandId: record.commandId, requestDigest: record.requestDigest, actorId: record.actorId, kind: record.kind, personId: record.personId, revision: record.revision, recordedAt: record.recordedAt, digest: digest(record) }; }
export function personSettlement(show: ShowSnapshot, state: SettlementState, personId: string): PersonSettlement {
  const person = ownedPerson(show, personId), ownReports = reports(state).filter(item => item.personId === personId), ownPayables = payables(state).filter(item => item.personId === personId);
  const views: ReportView[] = ownReports.map(report => {
    const payable = ownPayables.find(item => item.reportId === report.id) ?? null;
    const changeRequest = state.records.findLast(item => item.kind === "changes_requested" && item.reportId === report.id) as ReportView["changeRequest"] ?? null;
    const current = currentReport(state, personId, report.serviceDay)?.id === report.id, review = payableReview(show, state, report.id);
    return { report, current, status: !current ? "superseded" : payable ? "approved" : changeRequest ? "changes_requested" : "reported", payable, changeRequest, preview: review.preview, reviewBlockers: review.blockers };
  });
  return { person: { id: person.id, name: person.name, role: person.role, color: person.color }, rates: rates(state).filter(item => item.personId === personId), reports: views, payables: ownPayables, approvedBalanceMinor: ownPayables.reduce((sum, item) => sum + item.deltaMinor, 0), pendingReports: views.filter(item => item.current && !item.payable).length, creditAdjustments: ownPayables.filter(item => item.deltaMinor < 0).length };
}
export function applySettlementCommand(show: ShowSnapshot, actor: Actor, state: SettlementState, command: SettlementCommand, context: Omit<SettlementRecordContext, "personId" | "source">): { state: SettlementState; record: SettlementRecord } {
  if (actor.tenantId !== show.tenantId) throw new DomainError("TENANT_MISMATCH", "This request belongs to another production.", 403);
  if (state.records.length >= 4000) throw new DomainError("SETTLEMENT_RECORD_LIMIT", "This production has reached its retained settlement record limit. Export the existing history for review.", 409);
  if (context.revision !== state.revision + 1 || context.productionRevision !== show.revision + 1 || context.actorId !== actor.id) throw new Error("Invalid settlement context");
  const common = { ...context, source: "controlled_client" as const };
  let record: SettlementRecord;
  if (command.type === "report_time") {
    const person = requireCrewPerson(show, actor), sheet = show.sheets.at(-1);
    if (!sheet || sheet.version !== command.sheetVersion || sheet.digest !== command.sheetDigest) throw new DomainError("TIME_SHEET_CHANGED", "The published calls changed. Read the current sheet before submitting reported hours.");
    const previous = currentReport(state, person.id, command.serviceDay);
    if ((previous?.id ?? null) !== command.replacesId) throw new DomainError("TIME_CORRECTION_CHANGED", "The report changed. Review the latest report and identify it as the report being corrected.");
    const work = validateIntervals(show, state, person.id, command.serviceDay, command.intervals);
    record = { ...common, kind: "time_report", personId: person.id, personName: person.name, personDigest: personDigest(person), serviceDay: command.serviceDay, version: (previous?.version ?? 0) + 1, replacesId: command.replacesId, sheet: { version: sheet.version, digest: sheet.digest, planVersion: sheet.planRevision, calls: sheet.tasks.filter(task => task.resources.includes(person.id) && task.durationMinutes > 0).map(task => ({ id: task.id, name: task.name, start: task.start, end: task.end })) }, ...work, detail: command.detail, scenarioClock: show.clock };
  } else {
    requireSettlementProducer(actor);
    if (command.type === "approve_rate") {
      const person = ownedPerson(show, command.personId), previous = rates(state).findLast(item => item.personId === person.id);
      if ((previous?.id ?? null) !== command.previousRateId) throw new DomainError("RATE_VERSION_CHANGED", "Another rate version was approved. Review that version before replacing it.");
      if (!settlementDays(show).includes(command.effectiveFrom)) throw new DomainError("RATE_DAY_OUTSIDE_PRODUCTION", "Choose the production day or its next day as the rate’s effective date.", 400);
      if (command.overtimeHourlyMinor < command.hourlyMinor) throw new DomainError("OVERTIME_RATE_BELOW_REGULAR", "The overtime rate must be at least the regular hourly rate.", 400);
      record = { ...common, kind: "rate", personId: person.id, personName: person.name, personDigest: personDigest(person), version: (previous?.version ?? 0) + 1, previousRateId: command.previousRateId, effectiveFrom: command.effectiveFrom, currency: "USD", hourlyMinor: command.hourlyMinor, overtimeHourlyMinor: command.overtimeHourlyMinor, regularMinutes: command.regularMinutes, agreement: command.agreement };
    } else {
      const report = reports(state).find(item => item.id === command.reportId);
      if (!report) throw new DomainError("TIME_REPORT_NOT_FOUND", "This report is not in the current production.", 404);
      ownedPerson(show, report.personId);
      if (currentReport(state, report.personId, report.serviceDay)?.id !== report.id) throw new DomainError("TIME_REPORT_SUPERSEDED", "Review the latest correction for this service day.");
      if (payables(state).some(item => item.reportId === report.id)) throw new DomainError("TIME_REPORT_ALREADY_APPROVED", "This report already has its immutable payable. A correction must be reported separately.");
      if (state.records.some(item => item.kind === "changes_requested" && item.reportId === report.id)) throw new DomainError("TIME_CHANGES_ALREADY_REQUESTED", "This report is awaiting a corrected submission from the person.");
      if (command.type === "request_time_changes") record = { ...common, kind: "changes_requested", personId: report.personId, reportId: report.id, detail: command.detail };
      else {
        const { preview, blockers } = payableReview(show, state, report.id);
        if (!preview) throw new DomainError("PAYABLE_REVIEW_BLOCKED", blockers.join(" "));
        if (preview.digest !== command.reviewDigest || preview.rateId !== command.rateId) throw new DomainError("PAYABLE_REVIEW_CHANGED", "The hours, rate or previous liability changed. Review the current calculation again.");
        const rate = rates(state).find(item => item.id === preview.rateId)!;
        record = { ...common, kind: "payable", personId: report.personId, reportId: report.id, reportDigest: digest(report), rateId: rate.id, rateDigest: digest(rate), previousPayableId: preview.previousPayableId, previousLiabilityMinor: preview.previousLiabilityMinor, deltaMinor: preview.deltaMinor, calculation: preview.calculation, reviewDigest: preview.digest, detail: command.detail };
      }
    }
  }
  return { state: { schemaVersion: 1, revision: context.revision, records: [...state.records, record] }, record };
}
