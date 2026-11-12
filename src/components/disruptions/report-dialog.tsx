"use client";
import { useId, useState } from "react";
import { ArrowRight, FileText, TriangleAlert } from "lucide-react";
import type { DisruptionWorkspace } from "@/server/disruptions/contracts";
import { atZone } from "@/domain/time";
import { Badge, Button, Modal } from "../ui";
import { ActionFeedback, SourceTime, VenueTime, venueInput } from "./shared";
import type { DisruptionClient } from "./use-disruptions";

type Offer = DisruptionWorkspace["offers"][number];
export function ReportDialog({ offer, client, close, fallback }: { offer: Offer; client: DisruptionClient; close: () => void; fallback: () => HTMLElement | null }) {
  const supplier = client.data?.access === "supplier", radioName = useId();
  const [availability, setAvailability] = useState<"delayed" | "unavailable" | "available">("delayed"), [earliest, setEarliest] = useState(() => venueInput(Date.parse(offer.deliveryAt) >= Date.parse(client.data!.clock) ? offer.deliveryAt : client.data!.clock));
  const [observed, setObserved] = useState(() => new Date().toISOString().slice(0, 19)), [reference, setReference] = useState(""), [detail, setDetail] = useState(""), [confirmed, setConfirmed] = useState(false), [validation, setValidation] = useState<string | null>(null);
  const validObserved = Boolean(observed) && Number.isFinite(Date.parse(`${observed}Z`));
  const ready = confirmed && validObserved && reference.trim().length >= 3 && detail.trim().length >= 12 && (availability === "unavailable" || Boolean(earliest));
  const save = async () => {
    if (!ready || !client.data) return;
    let earliestAt: string | null = null;
    try { if (availability !== "unavailable") earliestAt = atZone(earliest.slice(0, 10), earliest.slice(11, 16), "America/Chicago"); }
    catch { setValidation("Choose an exact Chicago scenario delivery time. The entered time could not be resolved."); return; }
    const result = await client.submit({ type: "report", offerId: offer.id, offerRevision: offer.revision, executionId: offer.executionId, availability, earliestAt, observedAt: new Date(`${observed}Z`).toISOString(), reference: reference.trim(), detail: detail.trim(), confirmed: true }, client.data.revision);
    if (result) close();
  };
  return <Modal title={supplier ? "Report your equipment availability" : "Record an attributed supplier change"} onClose={close} dismissible={!client.busy} returnFocus={fallback} fallbackFocus={fallback}><div className="disruption-dialog disruption-report-dialog">
    <div className="disruption-dialog-context"><FileText size={22} /><div><Badge tone="blue">{supplier ? "SUPPLIER CLIENT REPORT" : "PRODUCTION OPERATOR REPORT"}</Badge><h3>{offer.supplier} · {offer.unitId}</h3><p>Offer v{offer.revision} · promised <VenueTime value={offer.deliveryAt} />{offer.executionState ? ` · ${offer.executionState.replaceAll("_", " ")}` : " · no rental execution recorded"}</p></div></div>
    <p>{supplier ? "This controlled supplier client may report only its own enrolled offer. Reconfirming availability still requires a current production review." : "Record what you observed and identify the source. Your report is attributed to the production operator; only the supplier’s own private client can reconfirm availability."}</p>
    <fieldset className="disruption-choice-fieldset"><legend>What changed?</legend><div className="disruption-report-options">{([{ value: "delayed", label: "Delivery delayed", detail: "An exact new earliest time" }, { value: "unavailable", label: "Unit unavailable", detail: "No delivery promise" }, ...(supplier ? [{ value: "available" as const, label: "Available again", detail: "Supplier reconfirmation" }] : [])] as const).map(option => <label className={availability === option.value ? "selected" : ""} key={option.value}><input type="radio" name={radioName} value={option.value} checked={availability === option.value} onChange={() => { setAvailability(option.value); setConfirmed(false); }} /><span><b>{option.label}</b><small>{option.detail}</small></span></label>)}</div></fieldset>
    {availability !== "unavailable" ? <label className="disruption-field">Earliest delivery · Chicago scenario time<input type="datetime-local" value={earliest} step={60} onChange={event => { setEarliest(event.target.value); setConfirmed(false); }} required /><small>America/Chicago · show date November 14, 2026. Current scenario clock: <VenueTime value={client.data!.clock} />.</small></label> : <div className="disruption-callout"><TriangleAlert size={18} /><p>An unavailable unit has no promised delivery time. Original supplier and payment obligations remain recorded.</p></div>}
    <label className="disruption-field">Source observed at · actual UTC time<input type="datetime-local" value={observed} step={1} onChange={event => { setObserved(event.target.value); setConfirmed(false); }} required /><small>Use the recent real time of the report. This is separate from the show’s scenario delivery clock.</small></label>
    <label className="disruption-field">Source reference<input value={reference} onChange={event => { setReference(event.target.value); setConfirmed(false); }} minLength={3} maxLength={180} placeholder="Supplier message, call note or incident reference" /><small>A reference stays attached to this exact offer and report.</small></label>
    <label className="disruption-field">What is known, and what still needs checking?<textarea rows={4} value={detail} onChange={event => { setDetail(event.target.value); setConfirmed(false); }} minLength={12} maxLength={1200} placeholder="Describe the changed availability, the source and any remaining uncertainty…" /><small>{detail.trim().length}/1200 characters · at least 12</small></label>
    <label className="disruption-consent"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>{supplier ? "I reviewed my own exact offer and this availability report. It records a controlled supplier event and does not claim physical delivery." : "I reviewed this source and exact offer. This is my production report, separate from the supplier’s own confirmation or any physical sign-off."}</span></label>
    <p className="disruption-small">Saving withdraws current cue clearance and preserves previous commitments. It creates no payment instruction.</p>
    {validation ? <p role="alert" className="disruption-inline-error">{validation}</p> : null}<ActionFeedback client={client} />
    <div className="disruption-dialog-footer"><Button disabled={Boolean(client.busy)} onClick={close}>{client.pending ? "Close and check original status" : "Close report"}</Button><Button variant="primary" disabled={!ready || client.blocked} busy={client.busy === "report"} onClick={() => void save()}>Save attributed report <ArrowRight size={16} /></Button></div>
    <details className="disruption-source-note"><summary>Time and attribution evidence</summary><p>The observation time is retained in UTC; delivery is resolved in America/Chicago. The server records its own receipt time and authenticated actor separately.</p><p>Observed time entered: {validObserved ? <SourceTime value={new Date(`${observed}Z`).toISOString()} /> : "Choose a valid UTC time"}.</p></details>
  </div></Modal>;
}
