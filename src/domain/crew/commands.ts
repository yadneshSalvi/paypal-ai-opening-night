import { randomUUID } from "node:crypto";
import { appendEvent, applyCommand } from "../commands";
import { DomainError, type Actor, type ShowSnapshot } from "../contracts";
import { readiness } from "../readiness";
import { compareInstants } from "../time";
import { cueScope, type CrewCommand, type CrewCueKind, type CrewRecordContext, type CrewSigner, type CrewVerifier } from "./contracts";
import { assertCrewReview, canAttest, canCue, cueEarliest, cueTitles, currentAttestation, currentCue, dutyBlockers, dutyDefinitions, ownCurrentReadback, requireCrewPerson } from "./policy";

export function cueBlockers(show: ShowSnapshot, actor: Actor, kind: CrewCueKind, verify: CrewVerifier) {
  const person = requireCrewPerson(show, actor);
  const report = readiness(show, cueScope(kind), undefined, verify);
  const blockers: string[] = [];
  if (!canCue(show, person, kind)) blockers.push("This cue belongs to its assigned crew member.");
  if (!ownCurrentReadback(show, person.id)) blockers.push("Acknowledge your current run sheet first.");
  if (!report.ready) blockers.push(...report.blockers.map(label => `${label} is not clear.`));
  if (compareInstants(show.clock, cueEarliest(show, kind)) < 0) blockers.push("The fixture clock has not reached this cue’s scheduled time.");
  const recorded = currentCue(show, kind, verify);
  if (recorded && (kind !== "DOORS_GO" || show.state !== "standby")) blockers.push("This cue has already been recorded for the current calls.");
  if (kind === "HOUSE_OPEN") {
    const go = currentCue(show, "DOORS_GO", verify);
    if (!go || show.state !== "go" || show.goReportId !== go.reportId) blockers.push("A current stage-manager DOORS GO is required first.");
  }
  return blockers;
}

export function applyCrewCommand(input: ShowSnapshot, actor: Actor, commandId: string, command: CrewCommand, trust: { sign: CrewSigner; verify: CrewVerifier }, now = new Date().toISOString()): ShowSnapshot {
  const person = requireCrewPerson(input, actor);
  if (!actor.id.startsWith(`crew:${person.id}:`)) throw new DomainError("CREW_CAPABILITY_REQUIRED", "A current person-bound crew capability is required.", 403);
  if (command.type === "acknowledge") {
    return applyCommand(input, actor, command, now, trust.verify, commandId);
  }
  assertCrewReview(input, command.review);
  if (!ownCurrentReadback(input, person.id)) throw new DomainError("CURRENT_READBACK_REQUIRED", "Acknowledge your current published calls before signing a duty or cue.");
  const show = structuredClone(input);
  const context: CrewRecordContext = { protocol: 1, id: randomUUID(), commandId, tenantId: show.tenantId, showId: show.id, actorId: actor.id, personId: person.id, ...command.review, recordedAt: now, fixtureAt: show.clock, revision: show.revision + 1, source: "controlled_client", detail: command.detail };
  if (command.type === "attest") {
    if (!canAttest(show, person, command.kind)) throw new DomainError("CREW_DUTY_FORBIDDEN", "This person is not assigned and qualified to sign that duty.", 403);
    if (currentAttestation(show, command.kind, trust.verify)) throw new DomainError("DUTY_ALREADY_SIGNED", "This duty already has a current signed record. Refresh its receipt.");
    const blockers = dutyBlockers(show, person, command.kind, trust.verify);
    if (blockers.length) throw new DomainError("CREW_DUTY_BLOCKED", blockers.join(" "));
    const unsigned = { ...context, type: "attestation" as const, kind: command.kind };
    show.crewAttestations ??= []; show.crewAttestations.push({ ...unsigned, signature: trust.sign(unsigned) });
    appendEvent(show, actor, `crew.${command.kind}`, `${person.name} signed ${dutyDefinitions[command.kind].title.toLowerCase()} for run sheet v${command.review.sheetVersion}. Controlled rehearsal evidence.`, now);
  } else {
    if (!canCue(show, person, command.kind)) throw new DomainError("CREW_CUE_FORBIDDEN", "This cue belongs to the assigned stage or front-of-house manager.", 403);
    const report = readiness(show, cueScope(command.kind), now, trust.verify);
    if (command.reportId !== report.id) throw new DomainError("STALE_READINESS", "Readiness changed. Review the current report before calling this cue.");
    const blockers = cueBlockers(show, actor, command.kind, trust.verify);
    if (blockers.length) throw new DomainError("CREW_CUE_BLOCKED", blockers.join(" "));
    const preceding = command.kind === "HOUSE_OPEN" ? currentCue(show, "DOORS_GO", trust.verify)?.id ?? null : null;
    if (command.precedingCueId !== preceding) throw new DomainError("STALE_PRECEDING_CUE", "Review the current stage-manager GO before confirming HOUSE OPEN.");
    const unsigned = { ...context, type: "cue" as const, kind: command.kind, reportId: report.id, precedingCueId: preceding };
    show.crewCues ??= []; show.crewCues.push({ ...unsigned, signature: trust.sign(unsigned) });
    if (command.kind === "DOORS_GO") { show.state = "go"; show.goReportId = report.id; }
    if (command.kind === "HOUSE_OPEN") show.state = "house_open";
    appendEvent(show, actor, `cue.${command.kind.toLowerCase()}`, `${person.name}: ${cueTitles[command.kind]}. Separate authorized cue at the labeled fixture time; no physical performance claim.`, now);
  }
  show.revision++; show.updatedAt = now;
  if (show.state !== "standby" && !readiness(show, "DOORS", now, trust.verify).ready) { show.state = "standby"; show.goReportId = null; }
  return show;
}
