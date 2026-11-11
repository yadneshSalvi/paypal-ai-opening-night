/** Controlled unit/integration inputs. These are not provider qualification,
 * physical inspections, real crew attendance, or a completed show. */
import { randomUUID } from "node:crypto";
import type { Actor, ShowSnapshot } from "../src/domain/contracts";
import type { CrewCueKind, CrewDutyKind, CrewReview } from "../src/domain/crew/contracts";
import { applyCommand } from "../src/domain/commands";
import { applyCrewCommand } from "../src/domain/crew/commands";
import { currentCrewReview, currentCue } from "../src/domain/crew/policy";
import { readiness } from "../src/domain/readiness";
import { atVenue } from "../src/domain/time";
import { signCrewRecord, verifyCrewRecord } from "../src/server/crew/signatures";
import { evidence, publishForTest } from "./helpers";

export const crewTrust = { sign: signCrewRecord, verify: verifyCrewRecord };
export const crewActor = (show: ShowSnapshot, personId: string): Actor => ({ id: `crew:${personId}:${randomUUID()}`, tenantId: show.tenantId, roles: ["crew"], personId });
export function crewPublished() {
  const value = publishForTest();
  return { actor: value.actor, show: applyCommand(value.show, value.actor, { type: "adopt_crew" }, undefined, verifyCrewRecord) };
}
export function crewAck(show: ShowSnapshot, personId: string, sheet = show.sheets.at(-1)!, actor = crewActor(show, personId), commandId: string = randomUUID()) {
  return applyCrewCommand(show, actor, commandId, { type: "acknowledge", sheetVersion: sheet.version, sheetDigest: sheet.digest, seenTaskIds: sheet.changes.filter(change => change.resourceIds.includes(personId)).map(change => change.taskId), offline: sheet.version !== show.sheets.at(-1)!.version }, crewTrust);
}
export function crewAttest(show: ShowSnapshot, personId: string, kind: CrewDutyKind, overrides: Partial<{ review: CrewReview; detail: string }> = {}) {
  return applyCrewCommand(show, crewActor(show, personId), randomUUID(), { type: "attest", kind, review: currentCrewReview(show)!, detail: "Controlled test review of the assigned duty.", confirmed: true, ...overrides }, crewTrust);
}
export function crewCue(show: ShowSnapshot, personId: string, kind: CrewCueKind, reportId?: string) {
  const scope = kind === "DOORS_GO" || kind === "HOUSE_OPEN" ? "DOORS" : kind;
  return applyCrewCommand(show, crewActor(show, personId), randomUUID(), { type: "cue", kind, review: currentCrewReview(show)!, reportId: reportId ?? readiness(show, scope, undefined, verifyCrewRecord).id, precedingCueId: kind === "HOUSE_OPEN" ? currentCue(show, "DOORS_GO", verifyCrewRecord)?.id ?? null : null, detail: "Controlled test call of this separate cue.", confirmed: true }, crewTrust);
}
export function controlledCommercialInputs(show: ShowSnapshot) {
  const authorization = show.financialEvidence.find(item => item.kind === "authorization" && item.purpose === "rental")!;
  show.financialEvidence.push(evidence(show, { kind: "capture", purpose: "rental", amountMinor: 48000, parentId: authorization.providerResourceId }));
  show.facts.push({ id: randomUUID(), kind: "delivery_accepted", planVersion: show.planVersion, actorId: "fixture:inspector", role: "department_lead", recordedAt: new Date().toISOString(), fixtureAt: atVenue("17:15"), source: "sample", detail: "Controlled test delivery prerequisite; no physical inspection." });
  for (let ordinal = 1; ordinal <= 38; ordinal++) {
    const id = `CONTROLLED-VIP-${ordinal}`, capture = `CONTROLLED-CAPTURE-${ordinal}`;
    show.tickets.push({ id, tier: "vip", admissionMinor: 3500, perkMinor: 1500, captureId: capture, source: "live_sandbox", refundedMinor: 1500, status: "partially_refunded" });
    show.financialEvidence.push(evidence(show, { ticketId: id, providerResourceId: capture }), evidence(show, { kind: "refund", purpose: "vip_remedy", ticketId: id, amountMinor: 1500, parentId: capture, providerResourceId: `CONTROLLED-REFUND-${ordinal}` }));
  }
  return show;
}
export function crewReadyDoors() {
  const value = crewPublished(); let show = controlledCommercialInputs(value.show); show.clock = atVenue("18:45");
  for (const person of show.resources.filter(resource => resource.kind === "person" && resource.critical && !resource.reserve)) show = crewAck(show, person.id);
  show = crewAttest(show, "tom", "focus_signed_off"); show = crewAttest(show, "priya", "cue_signed_off"); show = crewAttest(show, "avery", "foh_contingency");
  return { actor: value.actor, show };
}
