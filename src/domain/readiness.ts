import type { CueScope, ReadinessGate, ReadinessReport, ShowSnapshot } from "./contracts";
import { financialSummary, currentActual } from "./finance";
import { digest } from "./hash";
import { atVenue, compareInstants } from "./time";

export function currentAcknowledgments(show: ShowSnapshot) {
  const sheet = show.sheets.at(-1)!;
  const people = show.resources.filter(r => r.kind === "person" && r.critical && !r.reserve);
  return people.filter(p => show.acknowledgments.some(a => a.personId === p.id && a.sheetVersion === sheet.version && a.sheetDigest === sheet.digest));
}
export function readiness(show: ShowSnapshot, scope: CueScope, now = new Date().toISOString()): ReadinessReport {
  const sheet = show.sheets.at(-1)!;
  const facts = show.facts.filter(f => f.planVersion === show.planVersion);
  const actual = currentActual(show).filter(e => e.planVersion === show.planVersion);
  const finance = financialSummary(show);
  const fact = (kind: typeof facts[number]["kind"]) => facts.find(f => f.kind === kind);
  const gates: ReadinessGate[] = [];
  const gate = (id: string, label: string, complete: boolean, value: string, reason: string, evidenceIds: string[], href = "/execution") => gates.push({ id, label, complete, value, reason, evidenceIds, href });
  const auth = actual.find(e => e.kind === "authorization" && e.purpose === "rental" && e.amountMinor === 78000);
  const capture = actual.find(e => e.kind === "capture" && e.purpose === "rental" && e.amountMinor === 48000 && e.parentId === auth?.providerResourceId);
  const technical = Boolean(fact("focus_signed_off") && fact("cue_signed_off") && fact("delivery_accepted") && capture);
  if (scope === "DOORS") {
    const approved = Boolean(show.approvedPlan && sheet.candidateId === show.approvedPlan.candidateId && fact("foh_contingency"));
    gate("plan", "Approved running order", approved, approved ? `Run sheet v${sheet.version}` : "Awaiting approval", "Publish the approved plan and record the support-first FOH contingency.", [show.approvedPlan?.digest, fact("foh_contingency")?.id].filter((s): s is string => Boolean(s)), "/recovery");
    gate("authorization", "Rental authorization", Boolean(auth), auth ? "$780 authorized" : "$780 required", "Verified supplier authorization for the $480 fee and $300 refundable hold.", auth ? [auth.id] : []);
    gate("supplier", "Supplier confirmation", Boolean(fact("supplier_confirmed")), fact("supplier_confirmed") ? "Confirmed" : "Unconfirmed", "The supplier must confirm the selected equipment and delivery window.", fact("supplier_confirmed") ? [fact("supplier_confirmed")!.id] : []);
    gate("delivery", "Console accepted", Boolean(fact("delivery_accepted")), fact("delivery_accepted") ? "Accepted" : "Delivery pending", "An authorized department lead records delivery and condition acceptance.", fact("delivery_accepted") ? [fact("delivery_accepted")!.id] : []);
    gate("capture", "Rental fee captured", Boolean(capture), capture ? "$480 captured" : "$480 pending", "Verified partial fee capture follows accepted delivery; the deposit remains separate.", capture ? [capture.id] : []);
    gate("technical", "Focus & cue checks", technical, technical ? "Signed off" : "Not cleared", "Current department sign-offs follow accepted console delivery and fee capture.", [fact("focus_signed_off")?.id, fact("cue_signed_off")?.id].filter((s): s is string => Boolean(s)));
    gate("refunds", "VIP remedies confirmed", finance.refundedVipCount === show.policy.refundCount, `${finance.refundedVipCount} / 38 refunded`, "All 38 original-capture $15 refunds must be verified; a pending request does not count.", finance.evidenceIds, "/box-office");
    const ack = currentAcknowledgments(show); const currentPublished = Boolean(show.approvedPlan && sheet.candidateId === show.approvedPlan.candidateId);
    gate("crew", "Current crew acknowledgments", currentPublished && ack.length === show.policy.criticalCrewCount, `${currentPublished ? ack.length : 0} / 11 acknowledged`, "All active critical crew acknowledge this exact published version. The reserve is excluded.", show.acknowledgments.filter(a => a.sheetVersion === sheet.version && a.sheetDigest === sheet.digest).map(a => a.id), "/crew");
  } else if (scope === "SUPPORT_START") {
    gate("support-checkin", "Juniper Lane checked in", Boolean(fact("support_checkin")), fact("support_checkin") ? "On site" : "Awaiting check-in", "Record the performer’s fixture check-in.", fact("support_checkin") ? [fact("support_checkin")!.id] : []);
    gate("support-ready", "Support department ready", Boolean(fact("support_ready")), fact("support_ready") ? "Ready" : "Sign-off required", "Sound and stage readiness are distinct from opening the house.", fact("support_ready") ? [fact("support_ready")!.id] : []);
    gate("support-technical", "Current technical clearance", technical, technical ? "Cleared" : "Not cleared", "Current focus, cues, console and captured rental fee must remain valid.", []);
  } else {
    const arrived = fact("headliner_checkin"); const quiet = fact("quiet_prep"); const change = fact("changeover");
    const checked = Boolean(arrived && compareInstants(arrived.fixtureAt, atVenue("19:35")) >= 0);
    gate("headliner-checkin", "Headliner on site", checked, checked ? "19:35 · checked in" : "19:35 · expected", "The revised flight and transfer prohibit an earlier arrival.", arrived ? [arrived.id] : []);
    const prep = Boolean(checked && quiet && quiet.role === "department_lead" && compareInstants(quiet.fixtureAt, atVenue("20:10")) >= 0);
    gate("headliner-prep", "Quiet preparation signed off", prep, prep ? "20:10 · approved" : "20:10 · pending", "The sound lead records completion of the approved isolated preparation protocol.", quiet ? [quiet.id] : []);
    const changed = Boolean(change && compareInstants(change.fixtureAt, atVenue("20:40")) >= 0 && technical);
    gate("headliner-changeover", "Changeover & cues clear", changed, changed ? "20:40 · cleared" : "20:40 · pending", "Complete changeover and maintain current technical clearance before the 20:45 performance.", change ? [change.id] : []);
  }
  return { id: digest({ revision: show.revision, sheet: sheet.version, scope, gates }), revision: show.revision, sheetVersion: sheet.version, scope, ready: gates.every(g => g.complete), gates, blockers: gates.filter(g => !g.complete).map(g => g.label), computedAt: now };
}
export const allReadiness = (show: ShowSnapshot) => (["DOORS", "SUPPORT_START", "HEADLINER_START"] as const).map(scope => readiness(show, scope));
