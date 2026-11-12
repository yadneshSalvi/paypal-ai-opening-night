import type { FinancialEvidence, ShowSnapshot, Ticket } from "../contracts";
import { hasCurrentSupportOnlyPlan, operatingDigest, selectedInterruption } from "../disruptions";
import { currentActual, isActual, uniqueActual } from "../finance";
import { digest } from "../hash";
import type { AudienceEvent, AudienceRefund, AudienceRefundInstruction, AudienceTicketReceipt } from "./contracts";

export const audienceSourceDigest = (show: ShowSnapshot) => digest({ schema: "audience-source-v1", show });
const money = (value: number) => Number.isSafeInteger(value) && value >= 0;
export const receiptReference = (id: string) => "••••" + id.slice(-6);

/** Historical identity is independent of a later refund, plan or adverse current read. */
export function originalTicketCapture(show: ShowSnapshot, ticket: Ticket): FinancialEvidence | null {
  if (ticket.source !== "live_sandbox" || !ticket.captureId || !money(ticket.admissionMinor) || !money(ticket.perkMinor) || !money(ticket.admissionMinor + ticket.perkMinor) || ticket.admissionMinor + ticket.perkMinor <= 0) return null;
  if (show.tickets.filter(item => item.captureId === ticket.captureId).length !== 1) return null;
  const matching = show.financialEvidence.filter(item => item.kind === "capture" && item.providerResourceId === ticket.captureId);
  if (!matching.length || matching.some(item => item.ticketId !== ticket.id || item.purpose !== "ticket" || item.currency !== "USD" || item.amountMinor !== ticket.admissionMinor + ticket.perkMinor || !isActual(item))) return null;
  const unique = uniqueActual(show).filter(item => item.kind === "capture" && item.providerResourceId === ticket.captureId && item.ticketId === ticket.id);
  return unique.length === 1 ? unique[0]! : null;
}
export function originalReceiptDigest(show: ShowSnapshot, ticket: Ticket) {
  const capture = originalTicketCapture(show, ticket);
  return digest({ ticketId: ticket.id, tier: ticket.tier, admissionMinor: ticket.admissionMinor, perkMinor: ticket.perkMinor,
    capture: capture ? { id: capture.providerResourceId, operationId: capture.operationId, amountMinor: capture.amountMinor, currency: capture.currency, recordedAt: capture.recordedAt, source: capture.source } : null });
}

const publicTasks = (show: ShowSnapshot) => show.tasks.filter(task => ["doors", "support", "headliner", "vip"].includes(task.id)).map(task => ({ id: task.id, start: task.start, end: task.end, cancelled: Boolean(task.cancellation) }));
/** Allowlisted event information. No crew, suppliers, private finances, source prose or operational sign-offs leave this projection. */
export function audienceEvent(show: ShowSnapshot): AudienceEvent {
  const sheet = show.sheets.at(-1), decision = show.cancellationDecision;
  const candidate = show.runs.flatMap(run => run.candidates).find(item => item.id === show.approvedPlan?.candidateId && item.digest === show.approvedPlan.digest);
  const sheetMatches = Boolean(sheet && digest(publicTasks({ ...show, tasks: sheet.tasks })) === digest(publicTasks(show)));
  const operatingMatches = !(show.supplierDisruptions?.length || decision) || sheet?.operatingDigest === operatingDigest(show);
  const baseline = show.planVersion === 1 && !show.approvedPlan && sheet?.version === 1 && sheet.planRevision === 1 && sheet.candidateId === null && !show.incidents.length && !show.supplierDisruptions?.length && !decision && sheetMatches;
  const published = Boolean(candidate && candidate.report.engine?.status === "passed" && sheet?.planRevision === show.planVersion && sheet.candidateId === candidate.id && sheetMatches && operatingMatches && !selectedInterruption(show));
  const current = baseline || published && (!decision || decision.mode === "support_only" && hasCurrentSupportOnlyPlan(show));
  const cancellationPublished = Boolean(decision && sheet && sheet.version >= decision.noticeSheetVersion && operatingMatches);
  const program = decision?.mode === "cancel_show" ? "cancelled" : decision?.mode === "support_only" ? "support_only" : "full";
  const cancelled = program === "cancelled";
  const tasks = current ? show.tasks : sheet?.tasks ?? [];
  const performances: AudienceEvent["performances"] = [];
  for (const id of ["support", "headliner"] as const) {
    const task = tasks.find(item => item.id === id);
    if (task) performances.push({ id, title: id === "support" ? show.support : show.title, startsAt: task.start, endsAt: task.end, cancelled: cancelled || program === "support_only" && id === "headliner" || Boolean(task.cancellation) });
  }
  const vip = decision || candidate?.patch.canceledPerk || tasks.find(task => task.id === "vip")?.cancellation ? "cancelled" : current ? "scheduled" : "under_review";
  const scheduleStatus = current || cancelled && cancellationPublished ? "current" : "under_review";
  const doorsAt = cancelled ? null : current ? show.doorsAt : sheet?.tasks.find(task => task.id === "doors")?.start ?? null;
  const admission = cancelled ? "cancelled" : !current ? "suspended" : show.state === "house_open" ? "eligible" : "not_open";
  const label = cancelled ? "Event cancelled" : program === "support_only" ? current ? "Approved support-only program" : "Headliner cancelled · revised times under review" : current ? baseline ? "Published baseline" : "Current approved program" : "Schedule under review";
  const notice = cancelled ? "The producer cancelled this event. Original ticket receipts and each refund remain separate records. A cancellation notice is not a completed refund."
    : !current ? "These are the last published times. A change is under review; do not treat this schedule as newly confirmed. Check this page again for an approved update."
      : program === "support_only" ? "The headliner and VIP soundcheck are cancelled. The support-only program has its own approved times; refunds retain their individual status."
        : "These times come from the published event plan. A planned performance or open-house status does not establish that a person entered or that a performance occurred.";
  const value: Omit<AudienceEvent, "source"> = { title: show.title, support: show.support, venue: show.venue, showDate: show.showDate, zone: show.zone, program, scheduleStatus, label, notice, doorsAt, performances, vip, admission,
    admissionLabel: admission === "eligible" ? "House is open · ticket eligibility checked separately" : admission === "not_open" ? "House is not recorded open" : admission === "cancelled" ? "Admission cancelled" : "Admission information under review" };
  return { ...value, source: { planVersion: show.planVersion, sheetVersion: sheet?.version ?? null, publishedAt: sheet?.publishedAt ?? null, digest: digest({ value, sheetDigest: sheet?.digest ?? null, operating: operatingDigest(show) }), provenance: "sample" } };
}

export interface ReceiptAttribution { captureOwned: boolean; captureCurrent: boolean; refundIds: ReadonlySet<string>; instructions: AudienceRefundInstruction[] }
/** A caller must prove persisted original-resource ownership; a JSON "verified" flag alone is insufficient. */
export function audienceTicketReceipt(show: ShowSnapshot, ticket: Ticket, attribution: ReceiptAttribution): AudienceTicketReceipt {
  const capture = originalTicketCapture(show, ticket), actual = uniqueActual(show), currentIds = new Set(currentActual(show).map(item => item.id));
  const historical = Boolean(capture && attribution.captureOwned);
  const verification = historical ? currentIds.has(capture!.id) && attribution.captureCurrent ? "verified" : "unknown" : "unpaid";
  const seen = new Set<string>();
  const refunds: AudienceRefund[] = [];
  for (const entry of show.financialEvidence.filter(item => item.kind === "refund" && item.ticketId === ticket.id && item.parentId === ticket.captureId)) {
    const key = entry.providerResourceId || entry.operationId;
    if (seen.has(key) || !money(entry.amountMinor) || entry.amountMinor <= 0 || entry.currency !== "USD") continue;
    seen.add(key);
    const owns = attribution.refundIds.has(entry.providerResourceId), wasConfirmed = historical && owns && actual.some(item => item.id === entry.id);
    const alloc = entry.purpose === "vip_remedy" && entry.amountMinor === 1500 && ticket.perkMinor >= 1500 ? { admissionMinor: 0, perkMinor: entry.amountMinor }
      : entry.purpose === "event_remedy" && entry.allocation && money(entry.allocation.admissionMinor) && money(entry.allocation.perkMinor) && entry.amountMinor === entry.allocation.admissionMinor + entry.allocation.perkMinor ? entry.allocation : null;
    const status = wasConfirmed && verification === "verified" && currentIds.has(entry.id) ? "confirmed" : entry.status === "failed" ? "failed" : entry.status === "pending" && !wasConfirmed ? "pending" : "unknown";
    refunds.push({ id: entry.id, reference: entry.providerResourceId ? receiptReference(entry.providerResourceId) : "Receipt not confirmed", amountMinor: entry.amountMinor, admissionMinor: alloc?.admissionMinor ?? null, perkMinor: alloc?.perkMinor ?? null, recordedAt: entry.recordedAt, status, historicallyConfirmed: wasConfirmed, source: entry.source,
      decision: entry.purpose === "vip_remedy" ? "vip_perk" : entry.purpose === "event_remedy" ? "event_remedy" : "unallocated" });
  }
  const historicalRefunds = actual.filter(item => item.kind === "refund" && item.ticketId === ticket.id && item.parentId === ticket.captureId && attribution.refundIds.has(item.providerResourceId) && historical);
  const confirmedRefundMinor = historicalRefunds.reduce((sum, item) => sum + item.amountMinor, 0);
  const confirmed = refunds.filter(item => item.status === "confirmed");
  const admissionRefund = confirmed.reduce((sum, item) => sum + (item.admissionMinor ?? 0), 0), perkRefund = confirmed.reduce((sum, item) => sum + (item.perkMinor ?? 0), 0);
  const unallocatedRefundMinor = historicalRefunds.filter(item => refunds.find(refund => refund.id === item.id)?.admissionMinor === null).reduce((sum, item) => sum + item.amountMinor, 0);
  const captureRead = (show.financialObservations ?? []).filter(item => item.transport === "paypal_https" && item.seller === "venue" && item.kind === "capture" && item.providerResourceId === ticket.captureId && Date.parse(item.observedAt) >= Date.parse(capture?.recordedAt ?? "")).sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt) || (right.readRevision ?? 0) - (left.readRevision ?? 0))[0];
  const totalMatches = money(ticket.refundedMinor) && ticket.refundedMinor === confirmedRefundMinor && (captureRead?.refundedMinor === undefined || captureRead.refundedMinor === null || captureRead.refundedMinor === confirmedRefundMinor)
    && (captureRead?.status !== "REFUNDED" || confirmedRefundMinor === ticket.admissionMinor + ticket.perkMinor)
    && (captureRead?.status !== "PARTIALLY_REFUNDED" || confirmedRefundMinor > 0)
    && (ticket.status !== "refunded" || confirmedRefundMinor === ticket.admissionMinor + ticket.perkMinor);
  const allocationKnown = verification === "verified" && totalMatches && !unallocatedRefundMinor && admissionRefund <= ticket.admissionMinor && perkRefund <= ticket.perkMinor && confirmedRefundMinor <= ticket.admissionMinor + ticket.perkMinor && !refunds.some(item => item.status === "unknown") && !attribution.instructions.some(item => ["pending", "unknown"].includes(item.status));
  const target = show.cancellationDecision?.targets.find(item => item.ticketId === ticket.id);
  const event = audienceEvent(show), expectedAdmission = target?.admissionMinor ?? 0, expectedPerk = target?.perkMinor ?? (event.vip === "cancelled" ? ticket.perkMinor : 0);
  const expected = expectedAdmission + expectedPerk, fulfilled = Math.min(expectedAdmission, admissionRefund) + Math.min(expectedPerk, perkRefund);
  const remedyStatus = !expected ? "not_applicable" : !allocationKnown ? "unknown" : fulfilled >= expected ? "complete" : show.cancellationDecision?.remediesStoppedAt ? "stopped" : fulfilled ? "partial" : "pending";
  return { ticketId: ticket.id, tier: ticket.tier, captureReference: historical ? receiptReference(capture!.providerResourceId) : null, capturedAt: historical ? capture!.recordedAt : null,
    currency: "USD", admissionMinor: ticket.admissionMinor, perkMinor: ticket.perkMinor, grossMinor: ticket.admissionMinor + ticket.perkMinor,
    originalDigest: originalReceiptDigest(show, ticket), provenance: ticket.source, verification, refunds, instructions: attribution.instructions,
    confirmedRefundMinor, currentlyVerifiedRefundMinor: confirmed.reduce((sum, item) => sum + item.amountMinor, 0), unallocatedRefundMinor,
    remainingAdmissionMinor: allocationKnown ? ticket.admissionMinor - admissionRefund : null, remainingPerkMinor: allocationKnown ? ticket.perkMinor - perkRefund : null,
    remedy: { admissionMinor: expectedAdmission, perkMinor: expectedPerk, confirmedMinor: fulfilled, remainingMinor: Math.max(0, expected - fulfilled), status: remedyStatus },
    admission: !allocationKnown ? "unverified" : admissionRefund === ticket.admissionMinor ? "refunded" : "eligible",
    notice: verification === "unpaid" ? "No verified owned original capture is available. This ticket does not establish payment or admission eligibility."
      : !allocationKnown ? "The original receipt is retained. Current payment or refund allocation needs review; an unknown result is not a completed refund."
        : "Admission eligibility is separate from the event opening its doors. This receipt does not record physical entry or bank posting." };
}

export function audienceCanDraft(show: ShowSnapshot) {
  const event = audienceEvent(show), cancellation = show.cancellationDecision;
  const noticePublished = Boolean(cancellation && show.sheets.at(-1)?.version! >= cancellation.noticeSheetVersion && show.sheets.at(-1)?.operatingDigest === operatingDigest(show));
  return { ready: event.scheduleStatus === "current" || noticePublished, blockers: event.scheduleStatus === "current" || noticePublished ? [] : ["Publish a current approved event plan or an explicit approved cancellation notice before drafting an audience message."] };
}

export function audienceMessageContent(kind: "event_update" | "vip_remedy", event: AudienceEvent, receipt: AudienceTicketReceipt, note: string) {
  const currency = (minor: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);
  const time = (value: string) => new Intl.DateTimeFormat("en-US", { timeZone: event.zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
  const subject = `${event.title}: ${event.program === "cancelled" ? "event cancelled" : kind === "vip_remedy" ? "VIP soundcheck update" : "your event update"}`;
  const lines = [`${event.title} · ${event.venue}`, event.label, event.notice];
  if (event.doorsAt) lines.push(`${event.scheduleStatus === "current" ? "Published doors" : "Last published doors"}: ${time(event.doorsAt)}.`);
  for (const performance of event.performances) lines.push(`${performance.title}: ${performance.cancelled ? "cancelled" : `${event.scheduleStatus === "current" ? "published" : "last published"} ${time(performance.startsAt)}–${time(performance.endsAt)}`}.`);
  if (receipt.perkMinor) lines.push(`VIP soundcheck: ${event.vip.replaceAll("_", " ")}.`);
  lines.push(`Your original ticket: admission ${currency(receipt.admissionMinor)}${receipt.perkMinor ? ` + VIP soundcheck ${currency(receipt.perkMinor)}` : ""}; total ${currency(receipt.grossMinor)}. Original capture ${receipt.captureReference ?? "not verified"}.`);
  lines.push(`Historical confirmed refunds: ${currency(receipt.confirmedRefundMinor)}. Currently verified refunds: ${currency(receipt.currentlyVerifiedRefundMinor)}.`);
  if (receipt.remedy.status !== "not_applicable") lines.push(`Approved remedy target: admission ${currency(receipt.remedy.admissionMinor)} + perk ${currency(receipt.remedy.perkMinor)}. Status: ${receipt.remedy.status}. Remaining target: ${currency(receipt.remedy.remainingMinor)}. An approved or pending target is not a completed refund.`);
  for (const refund of receipt.refunds) lines.push(`Refund ${refund.reference}: ${currency(refund.amountMinor)}, ${refund.status}, recorded ${time(refund.recordedAt)}.`);
  for (const instruction of receipt.instructions.filter(item => item.status !== "confirmed")) lines.push(`Original refund instruction for ${currency(instruction.amountMinor)}: ${instruction.status.replaceAll("_", " ")}. This instruction does not establish a completed refund.`);
  if (note) lines.push("Producer note: " + note);
  lines.push("This is a controlled in-app inbox update. No email is sent. Delivery to this inbox does not establish that a person read it, entered the venue, or received funds in a bank account.");
  const body = lines.join("\n\n");
  return { subject, body, digest: digest({ subject, body }) };
}
