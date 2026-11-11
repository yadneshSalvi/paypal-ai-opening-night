import type { ShowSnapshot } from "./contracts";
import { currentActual } from "./finance";
import { readiness } from "./readiness";
import { deliveryIsAccepted } from "./supplier-contracts";

/** A schedule is a promise. Only its own current evidence completes execution milestones. */
export function projectExecutionMilestones(show: ShowSnapshot): ShowSnapshot {
  const actual = currentActual(show).filter(e => e.planVersion === show.planVersion);
  const fact = (kind: ShowSnapshot["facts"][number]["kind"]) => show.facts.some(f => f.planVersion === show.planVersion && f.kind === kind);
  const auth = actual.find(e => e.kind === "authorization" && e.purpose === "rental" && e.amountMinor === 78000);
  const captured = Boolean(auth && actual.some(e => e.kind === "capture" && e.purpose === "rental" && e.parentId === auth.providerResourceId && e.amountMinor === 48000));
  const completed: Record<string, boolean> = {
    "rental-authorized": Boolean(auth), "rental-delivery": deliveryIsAccepted(show), "rental-captured": captured,
    "lx-focus": captured && fact("focus_signed_off"), "lx-program": captured && fact("cue_signed_off"),
    "headliner-arrival": fact("headliner_checkin"), "quiet-prep": fact("headliner_checkin") && fact("quiet_prep"),
    changeover: captured && fact("changeover"), readiness: readiness(show, "DOORS").ready, doors: show.state === "house_open",
  };
  const tasks = show.tasks.map(task => Object.hasOwn(completed, task.id) ? { ...task, state: completed[task.id] ? "complete" as const : task.affected ? "blocked" as const : "planned" as const } : task);
  return { ...show, tasks };
}
