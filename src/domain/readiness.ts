import type { CueScope, ReadinessGate, ReadinessReport, ShowSnapshot } from "./contracts";
import { financialSummary, currentActual } from "./finance";
import { digest } from "./hash";
import { atVenue, compareInstants, formatMoney, localTime } from "./time";
import { deliveryIsAccepted, supplierIsConfirmed } from "./supplier-contracts";
import { currentAttestation, currentCrewReview, currentCue, currentRentalClearance, dutyEarliest } from "./crew/policy";
import { crewDutyKinds, type CrewVerifier } from "./crew/contracts";
import { cancellationBlocksCue, cancellationRemedies, operatingDigest, selectedInterruption } from "./disruptions";
import { inputPlanCurrent, inputPublicationCurrent, inputReadiness } from "./production-inputs/constraints";

export function currentAcknowledgments(show: ShowSnapshot) {
  if (!inputPublicationCurrent(show)) return [];
  const sheet = show.sheets.at(-1)!;
  const people = show.resources.filter(r => r.kind === "person" && r.critical && !r.reserve);
  return people.filter(p => show.acknowledgments.some(a => a.personId === p.id && a.sheetVersion === sheet.version && a.sheetDigest === sheet.digest && (show.crewProtocol !== 1 || Boolean(a.commandId && a.actorId?.startsWith(`crew:${p.id}:`)))));
}
export function readiness(show: ShowSnapshot, scope: CueScope, now = new Date().toISOString(), verifyCrew?: CrewVerifier): ReadinessReport {
  const sheet = show.sheets.at(-1)!;
  const facts = show.facts.filter(f => f.planVersion === show.planVersion);
  const actual = currentActual(show).filter(e => e.planVersion === show.planVersion);
  const finance = financialSummary(show);
  const fact = (kind: typeof facts[number]["kind"]) => {
    if (show.crewProtocol === 1 && crewDutyKinds.includes(kind as typeof crewDutyKinds[number])) {
      const signed = currentAttestation(show, kind as typeof crewDutyKinds[number], verifyCrew);
      return signed ? { ...signed, role: "department_lead" as const } : undefined;
    }
    return facts.find(f => f.kind === kind);
  };
  const gates: ReadinessGate[] = [];
  const gate = (id: string, label: string, complete: boolean, value: string, reason: string, evidenceIds: string[], href = "/execution") => gates.push({ id, label, complete, value, reason, evidenceIds, href });
  const inputs = inputReadiness(show);
  if (inputs) gate("production-inputs", "Current roster & venue inputs", inputs.complete, inputs.value, inputs.reason, inputs.evidenceIds, "/inputs");
  if (show.tourAssignments) gate("tour-assignments", "Current operating tour assignments", inputPublicationCurrent(show), !inputPlanCurrent(show) ? "Fresh plan review required" : !inputPublicationCurrent(show) ? "Current crew publication required" : "Reviewed assignments published", "The exact planning edition establishes assignments only. A new approved plan, publication and personal readbacks are required; no work or cue is inherited.", [show.tourAssignments.reviewId, show.tourAssignments.production.id], "/planning-workbench");
  if (show.supplierDisruptions?.length || show.cancellationDecision) {
    const interruption = selectedInterruption(show);
    const cancelled = cancellationBlocksCue(show, scope);
    const published = sheet.operatingDigest === operatingDigest(show);
    gate("disruption", "Current disruption decision", !interruption && !cancelled && published,
      cancelled ? show.cancellationDecision?.mode === "cancel_show" ? "Show cancelled" : "Headliner cancelled" : interruption ? "Supplier change unresolved" : !published ? "Current notice not published" : "Current review published",
      cancelled ? "The producer's cancellation remains authoritative. Existing receipts, calls and obligations stay in their own ledgers." : "Review the latest supplier facts, publish current calls, and obtain new technical evidence before issuing this cue.",
      [interruption?.id, show.cancellationDecision?.id].filter((id): id is string => Boolean(id)), "/disruptions");
  }
  const clearance = currentRentalClearance(show);
  const auth = show.crewProtocol === 1 ? clearance.authorization : actual.find(e => e.kind === "authorization" && e.purpose === "rental" && e.amountMinor === 78000);
  const capture = show.crewProtocol === 1 ? clearance.capture : actual.find(e => e.kind === "capture" && e.purpose === "rental" && e.amountMinor === 48000 && e.parentId === auth?.providerResourceId);
  const fee = show.crewProtocol === 1 ? clearance.offer?.feeMinor ?? null : 48000;
  const hold = show.crewProtocol === 1 ? clearance.offer?.depositMinor ?? null : 30000;
  const rentalAmount = fee !== null && hold !== null ? formatMoney(fee + hold) : "Selected rental amount";
  const technical = Boolean(fact("focus_signed_off") && fact("cue_signed_off") && deliveryIsAccepted(show) && capture);
  if (scope === "DOORS") {
    const published = show.crewProtocol === 1 ? Boolean(currentCrewReview(show)) : Boolean(show.approvedPlan && sheet.candidateId === show.approvedPlan.candidateId);
    const approved = published && Boolean(fact("foh_contingency"));
    const planStatus = approved ? `Run sheet v${sheet.version}` : !show.approvedPlan ? "Plan approval pending" : !published ? "Publication pending" : "FOH contingency pending";
    gate("plan", "Published running order", approved, planStatus, "Publish the approved plan and record the support-first FOH contingency.", [show.approvedPlan?.digest, fact("foh_contingency")?.id].filter((s): s is string => Boolean(s)), "/recovery");
    gate("authorization", "Rental authorization", Boolean(auth), `${rentalAmount} ${auth ? "authorized" : "required"}`, fee !== null && hold !== null ? `Verified supplier authorization for the ${formatMoney(fee)} fee and ${formatMoney(hold)} refundable hold.` : "The approved supplier offer determines the current authorization amount.", auth ? [auth.id] : []);
    gate("supplier", "Supplier confirmation", supplierIsConfirmed(show), supplierIsConfirmed(show) ? "Confirmed" : "Unconfirmed", "The supplier must confirm the selected equipment and delivery window.", fact("supplier_confirmed") ? [fact("supplier_confirmed")!.id] : []);
    gate("delivery", "Console accepted", deliveryIsAccepted(show), deliveryIsAccepted(show) ? "Accepted" : "Delivery pending", "An authorized department lead records delivery and condition acceptance.", fact("delivery_accepted") ? [fact("delivery_accepted")!.id] : []);
    gate("capture", "Rental fee captured", Boolean(capture), `${fee !== null ? formatMoney(fee) : "Selected fee"} ${capture ? "captured" : "pending"}`, "Verified partial fee capture follows accepted delivery; the deposit remains separate.", capture ? [capture.id] : []);
    gate("technical", "Focus & cue checks", technical, technical ? "Signed off" : "Not cleared", "Current department sign-offs follow accepted console delivery and fee capture.", [fact("focus_signed_off")?.id, fact("cue_signed_off")?.id].filter((s): s is string => Boolean(s)));
    const cancelledRemedies = cancellationRemedies(show);
    if (cancelledRemedies) gate("refunds", "Cancellation remedies confirmed", cancelledRemedies.complete, `${cancelledRemedies.completed} / ${cancelledRemedies.total} allocations confirmed`, "The producer's exact admission and perk allocation must be verified against each original capture. Pending instructions do not count.", show.financialEvidence.filter(item => item.purpose === "event_remedy").map(item => item.id), "/disruptions");
    else gate("refunds", "VIP remedies confirmed", finance.refundedVipCount === show.policy.refundCount, `${finance.refundedVipCount} / ${show.policy.refundCount} refunded`, `All ${show.policy.refundCount} original-capture $15 refunds must be verified; a pending request does not count.`, finance.evidenceIds, "/box-office");
    const ack = currentAcknowledgments(show); const currentPublished = published;
    gate("crew", "Current crew acknowledgments", currentPublished && ack.length === show.policy.criticalCrewCount, `${currentPublished ? ack.length : 0} / ${show.policy.criticalCrewCount} acknowledged`, "All active critical crew acknowledge this exact published version. The reserve is excluded.", show.acknowledgments.filter(a => ack.some(person => person.id === a.personId) && a.sheetVersion === sheet.version && a.sheetDigest === sheet.digest && (show.crewProtocol !== 1 || Boolean(a.commandId && a.actorId?.startsWith(`crew:${a.personId}:`)))).map(a => a.id), "/crew");
  } else if (scope === "SUPPORT_START") {
    if (show.crewProtocol === 1) {
      const doors = readiness(show, "DOORS", now, verifyCrew);
      gate("support-current", "Current production clearance", doors.ready, doors.ready ? "Clear" : "Current gates blocked", "Financial evidence, published calls and all current crew readbacks must remain clear.", [], "/crew");
      const opened = currentCue(show, "HOUSE_OPEN", verifyCrew);
      gate("support-house", "House opening recorded", Boolean(opened), opened ? "Recorded by FOH" : "FOH cue pending", "An issued doors GO does not record HOUSE OPEN or start a performance.", opened ? [opened.id] : []);
    }
    gate("support-checkin", "Juniper Lane checked in", Boolean(fact("support_checkin")), fact("support_checkin") ? "On site" : "Awaiting check-in", "Record the performer’s fixture check-in.", fact("support_checkin") ? [fact("support_checkin")!.id] : []);
    gate("support-ready", "Support department ready", Boolean(fact("support_ready")), fact("support_ready") ? "Ready" : "Sign-off required", "Sound and stage readiness are distinct from opening the house.", fact("support_ready") ? [fact("support_ready")!.id] : []);
    gate("support-technical", "Current technical clearance", technical, technical ? "Cleared" : "Not cleared", "Current focus, cues, console and captured rental fee must remain valid.", []);
  } else {
    if (show.crewProtocol === 1) {
      const doors = readiness(show, "DOORS", now, verifyCrew);
      gate("headliner-current", "Current production clearance", doors.ready, doors.ready ? "Clear" : "Current gates blocked", "Current financial and crew evidence must remain valid for this later start.", [], "/crew");
      const support = currentCue(show, "SUPPORT_START", verifyCrew);
      gate("headliner-support", "Support cue recorded", Boolean(support), support ? "Support started" : "Support cue pending", "The support-first order requires its separate authorized start cue.", support ? [support.id] : []);
    }
    const arrived = fact("headliner_checkin"); const quiet = fact("quiet_prep"); const change = fact("changeover");
    const arrivalAt = dutyEarliest(show, "headliner_checkin") ?? atVenue("19:35", show.showDate);
    const prepAt = dutyEarliest(show, "quiet_prep") ?? atVenue("20:10", show.showDate);
    const changeAt = dutyEarliest(show, "changeover") ?? atVenue("20:40", show.showDate);
    const checked = Boolean(arrived && compareInstants(arrived.fixtureAt, arrivalAt) >= 0);
    gate("headliner-checkin", "Headliner on site", checked, `${localTime(arrived?.fixtureAt ?? arrivalAt)} · ${checked ? "checked in" : "expected"}`, "The revised flight and transfer prohibit an earlier arrival.", arrived ? [arrived.id] : []);
    const prep = Boolean(checked && quiet && quiet.role === "department_lead" && compareInstants(quiet.fixtureAt, prepAt) >= 0);
    gate("headliner-prep", "Quiet preparation signed off", prep, `${localTime(quiet?.fixtureAt ?? prepAt)} · ${prep ? "approved" : "pending"}`, "The sound lead records completion of the approved isolated preparation protocol.", quiet ? [quiet.id] : []);
    const changed = Boolean(change && compareInstants(change.fixtureAt, changeAt) >= 0 && technical);
    gate("headliner-changeover", "Changeover & cues clear", changed, `${localTime(change?.fixtureAt ?? changeAt)} · ${changed ? "cleared" : "pending"}`, "Complete changeover and maintain current technical clearance before the scheduled performance.", change ? [change.id] : []);
  }
  return { id: digest({ revision: show.revision, sheet: sheet.version, scope, gates }), revision: show.revision, sheetVersion: sheet.version, scope, ready: gates.every(g => g.complete), gates, blockers: gates.filter(g => !g.complete).map(g => g.label), computedAt: now };
}
export const allReadiness = (show: ShowSnapshot, verifyCrew?: CrewVerifier) => (["DOORS", "SUPPORT_START", "HEADLINER_START"] as const).map(scope => readiness(show, scope, undefined, verifyCrew));
