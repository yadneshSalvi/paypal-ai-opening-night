import type { Actor, ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { readiness } from "@/domain/readiness";
import { cueBlockers } from "@/domain/crew/commands";
import { crewCueKinds, crewDataSchema, crewDutyKinds, cueScope, type CrewData, type CrewProductionOverview, type CrewRecord, type CrewRecordSummary } from "@/domain/crew/contracts";
import { canAttest, canCue, crewScopes, cueEarliest, cueTitles, currentAttestation, currentCrewRecord, currentCrewReview, currentCue, dutyBlockers, dutyDefinitions, dutyEarliest, personalCalls, personalRest, requireCrewPerson } from "@/domain/crew/policy";
import { verifyCrewRecord } from "./signatures";
import { env } from "../env";
import { inputPublicationCurrent } from "@/domain/production-inputs/constraints";

export function crewRecordSummary(show: ShowSnapshot, record: CrewRecord): CrewRecordSummary {
  return { id: record.id, commandId: record.commandId, type: record.type, kind: record.kind, personId: record.personId, personName: show.resources.find(person => person.id === record.personId)?.name ?? "Former crew member", actorId: record.actorId, detail: record.detail, recordedAt: record.recordedAt, fixtureAt: record.fixtureAt, planVersion: record.planVersion, sheetVersion: record.sheetVersion, sheetDigest: record.sheetDigest, status: !verifyCrewRecord(record) ? "invalid" : currentCrewRecord(show, record, verifyCrewRecord) ? "current" : "historical", signatureFingerprint: digest(record.signature) };
}
export function crewProductionOverview(show: ShowSnapshot): CrewProductionOverview {
  return {
    protocol: show.crewProtocol ?? 0,
    duties: crewDutyKinds.map(kind => { const record = currentAttestation(show, kind, verifyCrewRecord); return { kind, title: dutyDefinitions[kind].title, personIds: show.resources.filter(person => canAttest(show, person, kind)).map(person => person.id), record: record ? crewRecordSummary(show, record) : null }; }),
    cues: crewCueKinds.map(kind => { const record = currentCue(show, kind, verifyCrewRecord); return { kind, title: cueTitles[kind], personIds: show.resources.filter(person => canCue(show, person, kind)).map(person => person.id), record: record ? crewRecordSummary(show, record) : null }; }),
    history: [...show.crewAttestations ?? [], ...show.crewCues ?? []].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).map(record => crewRecordSummary(show, record)),
    legacyFactCount: show.facts.filter(fact => crewDutyKinds.includes(fact.kind as typeof crewDutyKinds[number])).length,
  };
}

/** No snapshot, roster, other assignments, commercial amounts, provider IDs,
 * grant details or private supplier payload can cross this DTO boundary. */
export function crewData(show: ShowSnapshot, actor: Actor, expiresAt: string, serverAt = new Date().toISOString()): CrewData {
  const person = requireCrewPerson(show, actor);
  const sheet = show.sheets.at(-1)!;
  const ownedSummary = (record: CrewRecord | null) => record?.personId === person.id ? crewRecordSummary(show, record) : null;
  const data: CrewData = {
    schemaVersion: 1, protocol: show.crewProtocol ?? 0, controlledQa: env.controlledQa, serverAt, access: { actorId: actor.id, expiresAt },
    person: { id: person.id, name: person.name, role: person.role, color: person.color, critical: person.critical, reserve: person.reserve },
    show: { title: show.title, support: show.support, venue: show.venue, zone: show.zone, showDate: show.showDate, clock: show.clock, revision: show.revision, planVersion: show.planVersion, doorsAt: show.doorsAt },
    sheet: { version: sheet.version, digest: sheet.digest, planVersion: sheet.planRevision, publishedAt: sheet.publishedAt, currentPlan: inputPublicationCurrent(show) && Boolean(show.approvedPlan && sheet.candidateId === show.approvedPlan.candidateId && sheet.planRevision === show.planVersion), recovery: Boolean(sheet.candidateId), calls: personalCalls(show, person.id), changes: sheet.changes.filter(change => change.resourceIds.includes(person.id)).map(({ taskId, name, before, after, reason }) => ({ taskId, name, before, after, reason })) },
    review: currentCrewReview(show),
    acknowledgments: show.acknowledgments.filter(ack => ack.personId === person.id).map(ack => ({ id: ack.id, commandId: ack.commandId ?? null, actorId: ack.actorId ?? null, sheetVersion: ack.sheetVersion, sheetDigest: ack.sheetDigest, receivedAt: ack.receivedAt, offline: ack.offline, current: inputPublicationCurrent(show) && ack.sheetVersion === sheet.version && ack.sheetDigest === sheet.digest && Boolean(ack.commandId && ack.actorId?.startsWith(`crew:${person.id}:`)), attribution: ack.actorId?.startsWith(`crew:${person.id}:`) && ack.commandId ? "person_capability" : "legacy_record" })),
    rest: personalRest(show, person.id),
    duties: crewDutyKinds.filter(kind => canAttest(show, person, kind)).map(kind => { const blockers = dutyBlockers(show, person, kind, verifyCrewRecord); return { kind, ...dutyDefinitions[kind], earliestAt: dutyEarliest(show, kind), available: blockers.length === 0, blockers, record: ownedSummary(currentAttestation(show, kind, verifyCrewRecord)) }; }),
    cues: crewCueKinds.filter(kind => canCue(show, person, kind)).map(kind => { const report = readiness(show, cueScope(kind), serverAt, verifyCrewRecord); const blockers = cueBlockers(show, actor, kind, verifyCrewRecord); return { kind, title: cueTitles[kind], scope: cueScope(kind), earliestAt: cueEarliest(show, kind), reportId: report.id, precedingCueId: kind === "HOUSE_OPEN" ? currentCue(show, "DOORS_GO", verifyCrewRecord)?.id ?? null : null, available: Boolean(currentCrewReview(show)) && blockers.length === 0, blockers, record: ownedSummary(currentCue(show, kind, verifyCrewRecord)) }; }),
    readiness: crewScopes(show, person).map(scope => {
      const report = readiness(show, scope, serverAt, verifyCrewRecord);
      return { scope, reportId: report.id, revision: report.revision, ready: report.ready, gates: report.gates.map(gate => ({ id: gate.id, label: gate.label, complete: gate.complete, status: gate.id === "crew" || gate.id === "refunds" ? gate.value : gate.complete ? "Clear" : "Pending" })) };
    }),
    history: [...show.crewAttestations ?? [], ...show.crewCues ?? []].filter(record => record.personId === person.id).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).map(record => crewRecordSummary(show, record)),
    contact: { label: "Production contact", instruction: "Raise a changed or unsafe instruction with your stage manager through your existing production channel before acting." },
  };
  return crewDataSchema.parse(data);
}
