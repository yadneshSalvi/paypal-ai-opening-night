import type { ShowSnapshot } from "./contracts";
import { currentActual } from "./finance";
import { readiness } from "./readiness";
import { deliveryIsAccepted } from "./supplier-contracts";
import { currentAttestation, currentCue, currentRentalClearance } from "./crew/policy";
import { crewDutyKinds, type CrewVerifier } from "./crew/contracts";

/** A schedule is a promise. Only its own current evidence completes execution milestones. */
export function projectExecutionMilestones(show: ShowSnapshot, verifyCrew?: CrewVerifier): ShowSnapshot {
  const actual = currentActual(show).filter(e => e.planVersion === show.planVersion);
  const fact = (kind: ShowSnapshot["facts"][number]["kind"]) => show.crewProtocol === 1 && crewDutyKinds.includes(kind as typeof crewDutyKinds[number]) ? Boolean(currentAttestation(show, kind as typeof crewDutyKinds[number], verifyCrew)) : show.facts.some(f => f.planVersion === show.planVersion && f.kind === kind);
  const rental = show.crewProtocol === 1 ? currentRentalClearance(show) : null;
  const auth = rental ? rental.authorization : actual.find(e => e.kind === "authorization" && e.purpose === "rental" && e.amountMinor === 78000);
  const captured = rental ? Boolean(rental.capture) : Boolean(auth && actual.some(e => e.kind === "capture" && e.purpose === "rental" && e.parentId === auth.providerResourceId && e.amountMinor === 48000));
  const completed: Record<string, boolean> = {
    "rental-authorized": Boolean(auth), "rental-delivery": deliveryIsAccepted(show), "rental-captured": captured,
    "lx-focus": captured && fact("focus_signed_off"), "lx-program": captured && fact("cue_signed_off"),
    "headliner-arrival": fact("headliner_checkin"), "quiet-prep": fact("headliner_checkin") && fact("quiet_prep"),
    changeover: captured && fact("changeover"), readiness: readiness(show, "DOORS", undefined, verifyCrew).ready, doors: show.crewProtocol === 1 ? Boolean(currentCue(show, "HOUSE_OPEN", verifyCrew)) : show.state === "house_open",
  };
  if (show.crewProtocol === 1) {
    // A start cue is distinct from a completed performance. These milestones
    // represent the recorded start only; elapsed scenario time adds no facts.
    completed["support-start"] = Boolean(currentCue(show, "SUPPORT_START", verifyCrew));
    completed["headliner-start"] = Boolean(currentCue(show, "HEADLINER_START", verifyCrew));
  }
  const tasks = show.tasks.map(task => Object.hasOwn(completed, task.id) ? { ...task, state: completed[task.id] ? "complete" as const : task.affected ? "blocked" as const : "planned" as const } : task);
  return { ...show, tasks };
}
