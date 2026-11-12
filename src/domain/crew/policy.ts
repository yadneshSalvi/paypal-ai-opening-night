import { DomainError, type Actor, type Resource, type ShowSnapshot } from "../contracts";
import { currentActual } from "../finance";
import { deliveryIsAccepted } from "../supplier-contracts";
import { atVenue, compareInstants, minutesBetween, plusMinutes } from "../time";
import { operatingDigest, selectedInterruption } from "../disruptions";
import { inputPlanCurrent, inputPublicationCurrent } from "../production-inputs/constraints";
import { cueScope, type CrewAttestation, type CrewCall, type CrewCueExecution, type CrewCueKind, type CrewDutyKind, type CrewNextCall, type CrewRecord, type CrewReview, type CrewVerifier } from "./contracts";

export const dutyDefinitions: Record<CrewDutyKind, { title: string; instructions: string; taskIds: string[] }> = {
  focus_signed_off: { title: "Lighting focus complete", instructions: "Confirm the assigned focus checks after accepted delivery and verified fee capture.", taskIds: ["lx-focus"] },
  cue_signed_off: { title: "Programming & cue checks clear", instructions: "Review the current programmed cues after the focus sign-off. Only an assigned qualified programmer can sign.", taskIds: ["lx-program"] },
  foh_contingency: { title: "Support-first house plan accepted", instructions: "Confirm the published admission plan, venue access and support-first contingency while headliner arrival remains separate.", taskIds: ["house-check", "doors"] },
  support_checkin: { title: "Juniper Lane checked in", instructions: "Record the support act’s controlled check-in for this running order.", taskIds: ["support"] },
  support_ready: { title: "Support sound ready", instructions: "Confirm support sound readiness after check-in and the current lighting and cue checks.", taskIds: ["support-check", "support"] },
  headliner_checkin: { title: "The Night Ferries checked in", instructions: "Record the delayed act’s controlled arrival. The flight and transfer set the earliest arrival.", taskIds: ["headliner"] },
  quiet_prep: { title: "Quiet preparation complete", instructions: "As the assigned headliner sound lead, review the completed isolated backstage preparation after the artist has checked in.", taskIds: ["quiet-prep", "headliner"] },
  changeover: { title: "Stage changeover clear", instructions: "Confirm changeover after the support cue and quiet preparation, with current technical clearance.", taskIds: ["readiness", "headliner"] },
};
export const cueTitles: Record<CrewCueKind, string> = { DOORS_GO: "Issue DOORS GO", HOUSE_OPEN: "Confirm HOUSE OPEN", SUPPORT_START: "Call SUPPORT START", HEADLINER_START: "Call HEADLINER START" };

export function requireCrewPerson(show: ShowSnapshot, actor: Actor): Resource {
  if (actor.tenantId !== show.tenantId) throw new DomainError("TENANT_MISMATCH", "This crew capability belongs to another production.", 403);
  if (actor.roles.length !== 1 || actor.roles[0] !== "crew" || !actor.personId || actor.executionId || actor.supplierId) throw new DomainError("CREW_CAPABILITY_REQUIRED", "Open the person’s dedicated crew link for this action.", 403);
  const person = show.resources.find(resource => resource.id === actor.personId && resource.kind === "person");
  if (!person) throw new DomainError("CREW_IDENTITY_REQUIRED", "This person is no longer on the production roster.", 403);
  return person;
}
const assigned = (show: ShowSnapshot, personId: string, taskId: string) => Boolean(show.tasks.find(task => task.id === taskId)?.resources.includes(personId));
function stageManager(show: ShowSnapshot, person: Resource) { return person.skills.includes("stage_management") && person.skills.includes("show_control") && assigned(show, person.id, "readiness"); }
export function canAttest(show: ShowSnapshot, person: Resource, kind: CrewDutyKind): boolean {
  if (person.kind !== "person" || person.reserve || !person.critical) return false;
  switch (kind) {
    case "focus_signed_off": return person.skills.includes("lx_focus") && assigned(show, person.id, "lx-focus");
    case "cue_signed_off": return person.skills.includes("lx_programming") && assigned(show, person.id, "lx-program");
    case "foh_contingency": return person.skills.includes("house_management") && assigned(show, person.id, "house-check") && assigned(show, person.id, "doors");
    case "support_checkin": return stageManager(show, person) && assigned(show, person.id, "support");
    case "headliner_checkin": return stageManager(show, person) && assigned(show, person.id, "headliner");
    case "support_ready": return person.skills.includes("audio_foh") && assigned(show, person.id, "support-check") && assigned(show, person.id, "support");
    // The approved patch assigns the isolated preparation to the backstage
    // room. Its sound-lead reviewer is assigned to the headliner, not to an
    // overlapping physical preparation shift during the support performance.
    case "quiet_prep": return person.skills.includes("audio_foh") && person.skills.includes("quiet_prep") && assigned(show, person.id, "headliner") && Boolean(show.tasks.find(task => task.id === "quiet-prep" && task.resources.includes("backstage")));
    // The stage manager supervises the assigned stagehands through the show's
    // readiness/headliner duties; this does not invent a programming skill.
    case "changeover": return stageManager(show, person) && assigned(show, person.id, "headliner") && Boolean(show.tasks.find(task => task.id === "changeover"));
  }
}
export function canCue(show: ShowSnapshot, person: Resource, kind: CrewCueKind): boolean {
  if (person.kind !== "person" || person.reserve || !person.critical) return false;
  if (kind === "HOUSE_OPEN") return canAttest(show, person, "foh_contingency");
  return stageManager(show, person) && (kind === "DOORS_GO" || assigned(show, person.id, kind === "SUPPORT_START" ? "support" : "headliner"));
}

export function currentCrewReview(show: ShowSnapshot): CrewReview | null {
  const sheet = show.sheets.at(-1);
  if (show.crewProtocol !== 1 || !show.approvedPlan || !sheet || sheet.planRevision !== show.planVersion || sheet.candidateId !== show.approvedPlan.candidateId) return null;
  if (!inputPlanCurrent(show) || !inputPublicationCurrent(show)) return null;
  if ((show.supplierDisruptions?.length || show.cancellationDecision) && sheet.operatingDigest !== operatingDigest(show)) return null;
  return { planVersion: show.planVersion, planDigest: show.approvedPlan.digest, sheetVersion: sheet.version, sheetDigest: sheet.digest, policyVersion: show.policy.version };
}
export function matchesCrewReview(show: ShowSnapshot, review: CrewReview) {
  const current = currentCrewReview(show);
  return Boolean(current && (Object.keys(current) as (keyof CrewReview)[]).every(key => current[key] === review[key]));
}
export function assertCrewReview(show: ShowSnapshot, review: CrewReview) {
  if (show.crewProtocol !== 1) throw new DomainError("CREW_PROTOCOL_REQUIRED", "The producer must enable person-scoped crew controls for this saved rehearsal.");
  if (!matchesCrewReview(show, review)) throw new DomainError("STALE_CREW_REVIEW", "The plan, sheet or policy changed. Read the current calls and review this action again.");
}
export function ownCurrentReadback(show: ShowSnapshot, personId: string) {
  const sheet = show.sheets.at(-1)!;
  return show.acknowledgments.find(ack => ack.personId === personId && ack.sheetVersion === sheet.version && ack.sheetDigest === sheet.digest && (show.crewProtocol !== 1 || Boolean(ack.commandId && ack.actorId?.startsWith(`crew:${personId}:`))));
}

/** Signature verification is injected by the server; missing trust fails closed. */
function validCrewRecord(show: ShowSnapshot, record: CrewRecord, verify?: CrewVerifier): boolean {
  if (!verify || !verify(record) || record.protocol !== 1 || record.source !== "controlled_client" || record.tenantId !== show.tenantId || record.showId !== show.id || !matchesCrewReview(show, record)) return false;
  const person = show.resources.find(resource => resource.id === record.personId);
  if (!person || record.actorId.startsWith(`crew:${person.id}:`) === false || !Number.isInteger(record.revision) || record.revision < 1 || record.revision > show.revision || !Number.isFinite(Date.parse(record.recordedAt)) || !Number.isFinite(Date.parse(record.fixtureAt)) || compareInstants(record.fixtureAt, show.clock) > 0) return false;
  return record.type === "attestation" ? canAttest(show, person, record.kind) : canCue(show, person, record.kind);
}
export function currentCrewRecord(show: ShowSnapshot, record: CrewRecord, verify?: CrewVerifier): boolean {
  if (!validCrewRecord(show, record, verify)) return false;
  const records: CrewRecord[] = record.type === "attestation" ? show.crewAttestations ?? [] : show.crewCues ?? [];
  const latest = records.findLast(item => item.kind === record.kind && validCrewRecord(show, item, verify));
  return latest?.id === record.id && latest.signature === record.signature;
}
export function currentAttestation(show: ShowSnapshot, kind: CrewDutyKind, verify?: CrewVerifier): CrewAttestation | null {
  return show.crewAttestations?.findLast(record => record.kind === kind && currentCrewRecord(show, record, verify)) ?? null;
}
export function currentCue(show: ShowSnapshot, kind: CrewCueKind, verify?: CrewVerifier): CrewCueExecution | null {
  return show.crewCues?.findLast(record => record.kind === kind && currentCrewRecord(show, record, verify)) ?? null;
}
export function currentRentalClearance(show: ShowSnapshot) {
  const candidate = show.runs.flatMap(run => run.candidates).find(item => item.id === show.approvedPlan?.candidateId);
  const offer = show.offers.find(item => item.id === candidate?.patch.offerId);
  const actual = currentActual(show).filter(item => item.planVersion === show.planVersion);
  const authorization = offer && actual.find(item => item.kind === "authorization" && item.purpose === "rental" && item.amountMinor === offer.feeMinor + offer.depositMinor);
  const capture = offer && authorization && actual.find(item => item.kind === "capture" && item.purpose === "rental" && item.amountMinor === offer.feeMinor && item.parentId === authorization.providerResourceId);
  return { authorization: authorization || null, capture: capture || null, accepted: deliveryIsAccepted(show), offer: offer ?? null };
}
export function technicalClearance(show: ShowSnapshot, verify?: CrewVerifier) {
  const rental = currentRentalClearance(show);
  return Boolean(rental.accepted && rental.capture && currentAttestation(show, "focus_signed_off", verify) && currentAttestation(show, "cue_signed_off", verify));
}
export function dutyEarliest(show: ShowSnapshot, kind: CrewDutyKind): string | null {
  const taskEnd = (id: string) => show.tasks.find(task => task.id === id)?.end ?? null;
  switch (kind) {
    case "focus_signed_off": return taskEnd("lx-focus");
    case "cue_signed_off": return taskEnd("lx-program");
    case "support_ready": return taskEnd("support-check");
    case "headliner_checkin": return show.tasks.find(task => task.id === "headliner-arrival")?.start ?? atVenue("19:35", show.showDate);
    case "quiet_prep": return taskEnd("quiet-prep");
    case "changeover": return taskEnd("changeover");
    default: return null;
  }
}
export function dutyBlockers(show: ShowSnapshot, person: Resource, kind: CrewDutyKind, verify?: CrewVerifier): string[] {
  const blockers: string[] = [];
  if (selectedInterruption(show)) blockers.push("The current supplier disruption needs a reviewed recovery and new delivery evidence.");
  if (show.cancellationDecision?.mode === "cancel_show" || show.cancellationDecision?.mode === "support_only" && ["headliner_checkin", "quiet_prep", "changeover"].includes(kind)) blockers.push("This performance duty belongs to the cancelled program. Existing records remain historical.");
  if (!canAttest(show, person, kind)) blockers.push("This duty needs its assigned qualified crew member.");
  if (!currentCrewReview(show)) blockers.push("The current approved plan must be published with person-scoped crew controls.");
  if (!ownCurrentReadback(show, person.id)) blockers.push("Acknowledge your current run sheet first.");
  const earliest = dutyEarliest(show, kind);
  if (earliest && compareInstants(show.clock, earliest) < 0) blockers.push("The scheduled work has not reached its completion time on the fixture clock.");
  if (currentAttestation(show, kind, verify)) blockers.push("This duty already has a current signed record.");
  const rental = currentRentalClearance(show);
  if (["focus_signed_off", "cue_signed_off", "support_ready", "quiet_prep", "changeover"].includes(kind)) {
    if (!rental.accepted) blockers.push("Accepted console delivery is required.");
    if (!rental.capture) blockers.push("The original rental fee must be currently verified as captured.");
  }
  if (kind === "cue_signed_off" && !currentAttestation(show, "focus_signed_off", verify)) blockers.push("Current lighting focus sign-off is required first.");
  if (kind === "support_ready") {
    if (!currentAttestation(show, "support_checkin", verify)) blockers.push("Record the support act’s check-in first.");
    if (!technicalClearance(show, verify)) blockers.push("Current focus and programmed cue checks must be clear.");
  }
  if (kind === "quiet_prep" && !currentAttestation(show, "headliner_checkin", verify)) blockers.push("Record the headliner’s current check-in first.");
  if (kind === "changeover") {
    if (!currentCue(show, "SUPPORT_START", verify)) blockers.push("The separate support start cue has not been recorded.");
    if (!currentAttestation(show, "quiet_prep", verify)) blockers.push("The sound lead must sign quiet preparation first.");
    if (!technicalClearance(show, verify)) blockers.push("Current technical clearance is required.");
  }
  return blockers;
}
export function cueEarliest(show: ShowSnapshot, kind: CrewCueKind): string {
  if (kind === "HOUSE_OPEN") return show.doorsAt;
  return show.tasks.find(task => task.id === (kind === "DOORS_GO" ? "readiness" : kind === "SUPPORT_START" ? "support" : "headliner"))?.start ?? show.doorsAt;
}
export function crewScopes(show: ShowSnapshot, person: Resource) {
  const scopes = new Set<ReturnType<typeof cueScope>>();
  if (stageManager(show, person)) { scopes.add("DOORS"); scopes.add("SUPPORT_START"); scopes.add("HEADLINER_START"); }
  if (canAttest(show, person, "foh_contingency") || canAttest(show, person, "focus_signed_off") || canAttest(show, person, "cue_signed_off")) scopes.add("DOORS");
  if (canAttest(show, person, "support_ready")) scopes.add("SUPPORT_START");
  if (canAttest(show, person, "quiet_prep")) scopes.add("HEADLINER_START");
  return [...scopes];
}

/** Existing saved fixtures already name these two people and nextCallAt in the
 * crew-policy-v1 source. Adoption materializes that planned call; no work is claimed. */
export function fixtureNextCalls(show: ShowSnapshot): CrewNextCall[] {
  if (show.crewNextCalls) return structuredClone(show.crewNextCalls);
  if (!show.sources.some(source => source.id === "crew-policy-v1") || !show.nextCallAt) return [];
  return [{ id: "matinee-load-in", name: "Sunday matinee load-in", lane: "stage", start: show.nextCallAt, end: plusMinutes(show.nextCallAt, 90), resources: ["sam", "priya"].filter(id => show.resources.some(person => person.id === id && person.kind === "person")), sourceId: "crew-policy-v1" }];
}
export function personalCalls(show: ShowSnapshot, personId: string): CrewCall[] {
  const sheet = show.sheets.at(-1)!;
  const calls: CrewCall[] = sheet.tasks.filter(task => task.critical && task.resources.includes(personId)).map(task => ({ id: task.id, name: task.cancellation ? `Cancelled · ${task.name}` : task.name, lane: task.lane, start: task.start, end: task.end, durationMinutes: task.durationMinutes, resources: [personId], critical: task.critical, affected: task.affected, nextDay: false }));
  for (const task of fixtureNextCalls(show).filter(call => call.resources.includes(personId))) calls.push({ id: task.id, name: task.name, lane: task.lane, start: task.start, end: task.end, durationMinutes: minutesBetween(task.start, task.end), resources: [personId], critical: true, affected: false, nextDay: true });
  return calls.sort((a, b) => compareInstants(a.start, b.start) || a.id.localeCompare(b.id));
}
export function personalRest(show: ShowSnapshot, personId: string) {
  const calls = personalCalls(show, personId);
  const nextCall = calls.find(call => call.nextDay) ?? null;
  const last = calls.filter(call => !call.nextDay).sort((a, b) => compareInstants(b.end, a.end))[0] ?? null;
  const minutes = nextCall && last ? minutesBetween(last.end, nextCall.start) : null;
  return { lastCallId: last?.id ?? null, lastFinishAt: last?.end ?? null, nextCall, minutes, minimumMinutes: show.policy.minimumRestMinutes, status: !nextCall ? "not_scheduled" as const : minutes === null ? "unknown" as const : minutes >= show.policy.minimumRestMinutes ? "pass" as const : "fail" as const };
}
