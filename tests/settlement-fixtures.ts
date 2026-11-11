import { randomUUID } from "node:crypto";
import type { Actor } from "../src/domain/contracts";
import { createFixture } from "../src/domain/fixture";
import { atVenue } from "../src/domain/time";
import { digest } from "../src/domain/hash";
import { applySettlementCommand, emptySettlement, personSettlement } from "../src/domain/settlement/commands";
import type { SettlementCommand, TimeReportCommand, ProducerSettlementCommand } from "../src/domain/settlement/contracts";

export function settlementFixture() {
  let show = createFixture(randomUUID()), state = emptySettlement();
  show.crewProtocol = 1; show.crewAttestations = []; show.crewCues = [];
  const producer: Actor = { id: "producer:" + randomUUID(), tenantId: show.tenantId, roles: ["producer"], personId: null };
  const crew: Actor = { id: "crew:priya:" + randomUUID(), tenantId: show.tenantId, roles: ["crew"], personId: "priya" };
  const apply = (command: SettlementCommand, actor = command.type === "report_time" ? crew : producer) => {
    const commandId = randomUUID(), requestDigest = digest({ idempotencyKey: commandId, expectedRevision: state.revision, expectedShowRevision: show.revision, command });
    const result = applySettlementCommand(show, actor, state, command, { id: randomUUID(), commandId, requestDigest, actorId: actor.id, recordedAt: new Date().toISOString(), revision: state.revision + 1, productionRevision: show.revision + 1 });
    state = result.state; show = { ...show, revision: show.revision + 1, settlementVersion: state.revision }; return result.record;
  };
  const rate = (changes: Partial<Extract<ProducerSettlementCommand, { type: "approve_rate" }>> = {}): Extract<ProducerSettlementCommand, { type: "approve_rate" }> => ({ type: "approve_rate", personId: "priya", previousRateId: null, effectiveFrom: show.showDate, currency: "USD", hourlyMinor: 3500, overtimeHourlyMinor: 5250, regularMinutes: 480, agreement: "Reviewed fictional production rate agreement.", confirmed: true, ...changes });
  const report = (changes: Partial<TimeReportCommand> = {}): TimeReportCommand => ({ type: "report_time", serviceDay: show.showDate, replacesId: null, sheetVersion: show.sheets.at(-1)!.version, sheetDigest: show.sheets.at(-1)!.digest, intervals: [{ start: atVenue("11:30"), end: atVenue("12:30"), unpaidMinutes: 0 }], detail: "Reported rehearsal hours for lighting preparation.", confirmed: true, ...changes });
  const approve = (reportId: string) => {
    const preview = personSettlement(show, state, "priya").reports.find(item => item.report.id === reportId)!.preview!;
    return { type: "approve_payable", reportId, rateId: preview.rateId, reviewDigest: preview.digest, detail: "Reviewed the reported hours, rate and exact adjustment.", reviewedHours: true, reviewedRate: true, reviewedAdjustment: true } satisfies ProducerSettlementCommand;
  };
  return { get show() { return show; }, get state() { return state; }, setClock(value: string) { show.clock = value; }, producer, crew, apply, rate, report, approve };
}
