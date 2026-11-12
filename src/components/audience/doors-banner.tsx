"use client";
import { DoorOpen } from "lucide-react";
import type { AudienceEvent, AudienceTicketReceipt } from "@/domain/audience/contracts";
import { ActualTime, Badge, money } from "./shared";
import styles from "./audience.module.css";

export type DoorsState = "as_scheduled" | "moved" | "published" | "under_review" | "cancelled";
export interface DoorsBannerText { state: DoorsState; headline: string; acts: string[]; detail: string; text: string }
const clock = (instant: string, zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant));

/**
 * The show-day doors line, from the event projection the server derives from the current approved plan.
 * "As scheduled" is said only when a current approved plan keeps the originally published doors time.
 * A moved, unapproved or cancelled plan never reads as scheduled.
 */
export function doorsBanner(event: AudienceEvent, originalDoorsAt: string | null): DoorsBannerText {
  const at = (instant: string) => clock(instant, event.zone);
  const finish = (state: DoorsState, headline: string, acts: string[], detail: string): DoorsBannerText => ({ state, headline, acts, detail, text: [headline, ...acts].join(" · ") });
  if (event.program === "cancelled") return finish("cancelled", "Event cancelled · doors will not open", [], event.scheduleStatus === "current" ? "The producer cancelled this event. Refunds are separate records on your ticket below." : "The producer cancelled this event. The cancellation notice is still being published.");
  if (event.scheduleStatus !== "current" || !event.doorsAt) return finish("under_review", event.doorsAt ? `Doors time under review · last published ${at(event.doorsAt)}` : "Doors time under review", [], "A change to the plan has not been approved yet. This is not a confirmed time; check again for the approved update.");
  const acts = event.performances.map(row => row.cancelled ? `${row.title} cancelled` : `${row.title} ${at(row.startsAt)}`);
  const source = `From approved plan ${event.source.planVersion}${event.source.sheetVersion ? `, published sheet ${event.source.sheetVersion}` : ""}. A planned time does not show that doors opened.`;
  if (!originalDoorsAt) return finish("published", `Doors ${at(event.doorsAt)}`, acts, source);
  if (Date.parse(originalDoorsAt) === Date.parse(event.doorsAt)) return finish("as_scheduled", `Doors ${at(event.doorsAt)} as scheduled`, acts, source);
  return finish("moved", `Doors moved to ${at(event.doorsAt)} · was ${at(originalDoorsAt)}`, acts, source);
}
export function DoorsBanner({ event, originalDoorsAt }: { event: AudienceEvent; originalDoorsAt: string | null }) {
  const banner = doorsBanner(event, originalDoorsAt), caution = banner.state !== "as_scheduled" && banner.state !== "published";
  return <section className={styles.doorsBanner} data-state={banner.state} aria-labelledby="attendee-doors-title">
    <DoorOpen size={26} aria-hidden="true" />
    <div><span className={styles.kicker}>SHOW DAY / DOORS</span><h2 id="attendee-doors-title">{banner.headline}</h2>{banner.acts.length ? <ul aria-label="Running order">{banner.acts.map(act => <li key={act}>{act}</li>)}</ul> : null}<p>{banner.detail}</p></div>
    <Badge tone={caution ? "amber" : "green"}>{banner.state === "cancelled" ? "Cancelled" : banner.state === "under_review" ? "Under review" : banner.state === "moved" ? "Time changed" : "Approved plan"}</Badge>
  </section>;
}

export type ReceiptLineState = "paid" | "refunded" | "partly_refunded" | "refund_pending" | "refund_unverified" | "cancelled_unrefunded" | "unverified";
export interface ReceiptLine { id: "admission" | "perk"; label: string; state: ReceiptLineState; amountMinor: number; refundedMinor: number; text: string; reference: string | null; refundedAt: string | null }
/**
 * One state per ticket line. Only a currently confirmed refund allocated to that line makes it "refunded";
 * a pending instruction, an unallocated refund or a historical receipt is named as such.
 */
export function receiptLines(receipt: AudienceTicketReceipt, event?: AudienceEvent): ReceiptLine[] {
  const line = (id: ReceiptLine["id"], label: string, amountMinor: number): ReceiptLine => {
    const share = (row: { admissionMinor: number | null; perkMinor: number | null }) => (id === "admission" ? row.admissionMinor : row.perkMinor) ?? 0;
    const touching = receipt.refunds.filter(row => share(row) > 0), confirmed = touching.filter(row => row.status === "confirmed");
    const refundedMinor = Math.min(amountMinor, confirmed.reduce((total, row) => total + share(row), 0)), latest = [...confirmed].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    const pending = touching.some(row => row.status === "pending") || receipt.instructions.some(row => ["prepared", "pending"].includes(row.status) && share(row) > 0);
    const historical = touching.some(row => row.status !== "confirmed" && row.historicallyConfirmed);
    const state: ReceiptLineState = receipt.verification !== "verified" ? "unverified" : refundedMinor >= amountMinor ? "refunded" : refundedMinor > 0 ? "partly_refunded" : pending ? "refund_pending" : historical ? "refund_unverified" : id === "perk" && event?.vip === "cancelled" ? "cancelled_unrefunded" : "paid";
    const text = state === "unverified" ? `${label}: ${money(amountMinor)} · payment not verified` : state === "refunded" ? `${label}: refunded ${money(refundedMinor)}` : state === "partly_refunded" ? `${label}: refunded ${money(refundedMinor)} of ${money(amountMinor)}` : state === "refund_pending" ? `${label}: Paid ${money(amountMinor)} · refund not yet confirmed` : state === "refund_unverified" ? `${label}: Paid ${money(amountMinor)} · earlier refund receipt, current status unknown` : state === "cancelled_unrefunded" ? `${label}: cancelled · Paid ${money(amountMinor)}, no refund recorded yet` : `${label}: Paid ${money(amountMinor)}`;
    return { id, label, state, amountMinor, refundedMinor, text, reference: latest?.reference ?? null, refundedAt: latest?.recordedAt ?? null };
  };
  return [line("admission", "Admission", receipt.admissionMinor), ...(receipt.perkMinor > 0 ? [line("perk", "Soundcheck access", receipt.perkMinor)] : [])];
}
export function ReceiptLineStates({ receipt, event }: { receipt: AudienceTicketReceipt; event?: AudienceEvent }) {
  return <section className={styles.lineStates} aria-labelledby="attendee-lines-title"><span className={styles.kicker}>EACH LINE / ITS OWN STATE</span><h2 id="attendee-lines-title">Where your ticket stands.</h2><ul>{receiptLines(receipt, event).map(row => <li key={row.id} data-state={row.state}><b>{row.text}</b>{row.reference && row.refundedAt ? <small>Refund {row.reference} · <ActualTime value={row.refundedAt} /></small> : null}</li>)}</ul>{receipt.unallocatedRefundMinor > 0 ? <p>{money(receipt.unallocatedRefundMinor)} of confirmed refunds is not yet allocated to a line and is not counted above.</p> : null}</section>;
}
