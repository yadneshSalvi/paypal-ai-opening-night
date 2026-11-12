"use client";
import { useId, useState } from "react";
import { ArrowRight, Clock3, Fingerprint, ShieldCheck } from "lucide-react";
import type { SupplierTermsCard } from "@/server/supplier-recovery/contracts";
import { atZone, formatMoney } from "@/domain/time";
import type { SupplierTermInput } from "@/domain/supplier-recovery-command";
import { Badge, Button, Modal } from "../ui";
import { ActualTime, SupplierRecoveryFeedback, VenueTime } from "./shared";
import type { SupplierRecoveryClient } from "./use-supplier-recovery";

function money(value: string) { const minor = Math.round(Number(value) * 100); return /^(0|[1-9]\d{0,4})(\.\d{1,2})?$/.test(value) && minor <= 1000000 ? minor : null; }
function localInstant(value: string) { const [day, time] = value.split("T"); if (!day || !time || !/^\d{2}:\d{2}$/.test(time)) throw new Error("Enter a date and minute in America/Chicago for both scenario times."); return atZone(day, time, "America/Chicago"); }
const answer = (value: string) => value === "yes" ? true : value === "no" ? false : null;
export function SupplierTermsDialog({ client, card, revision, onClose, fallbackFocus }: { client: SupplierRecoveryClient; card: SupplierTermsCard; revision: number; onClose: () => void; fallbackFocus: () => HTMLElement | null }) {
  const help = useId(), [delivery, setDelivery] = useState(""), [deadline, setDeadline] = useState("");
  const [fee, setFee] = useState((card.feeMinor / 100).toFixed(2)), [deposit, setDeposit] = useState((card.depositMinor / 100).toFixed(2)), [minutes, setMinutes] = useState(15);
  const [compatible, setCompatible] = useState(false), [driver, setDriver] = useState("unknown"), [condition, setCondition] = useState("unknown");
  const [capability, setCapability] = useState(""), [driverSource, setDriverSource] = useState(""), [conditionSource, setConditionSource] = useState("");
  const [reference, setReference] = useState(""), [detail, setDetail] = useState(""), [confirmed, setConfirmed] = useState(false), [error, setError] = useState<string | null>(null);
  const ready = Boolean(delivery && deadline && money(fee) !== null && money(deposit) !== null && capability.trim().length >= 12 && (driver !== "yes" || driverSource.trim().length >= 12) && (condition !== "yes" || conditionSource.trim().length >= 12) && reference.trim().length >= 3 && detail.trim().length >= 12 && confirmed);
  const save = async () => {
    setError(null);
    try {
      const command: SupplierTermInput = { type: "publish_terms", offerId: card.offerId, previousTermId: card.reference?.id ?? null, sourceReportId: card.report?.id ?? null,
        deliveryAt: localInstant(delivery), expiresAt: localInstant(deadline), validForMinutes: minutes, feeMinor: money(fee)!, depositMinor: money(deposit)!,
        compatible, qualifiedDriver: answer(driver), conditionVerified: answer(condition), capabilityEvidence: capability.trim(), driverEvidence: driver === "yes" ? driverSource.trim() : null, conditionEvidence: condition === "yes" ? conditionSource.trim() : null,
        reference: reference.trim(), detail: detail.trim(), confirmed: true };
      if (await client.submit(command, revision)) onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Review both scenario times before publishing."); }
  };
  return <Modal title="Publish current supplier terms" onClose={onClose} dismissible={!client.busy} fallbackFocus={fallbackFocus}><div className="supplier-terms-dialog">
    <Badge tone="amber">{card.supplier.toUpperCase()} / CONTROLLED SOURCE</Badge><h3>{card.unitId}</h3><p>A new edition records the terms you are offering now. Earlier signed quotes, accepted fees and return obligations stay attached to their original rentals.</p>
    <div className="supplier-recovery-message"><Clock3 size={18} /><p id={help}>Scenario clock <VenueTime value={client.data!.clock} />. Enter both new dates in <b>America/Chicago</b>. The real-time expiry below runs separately.</p></div>
    {card.report ? <p className="supplier-recovery-source"><Fingerprint size={16} />Current availability source: {card.report.reference} · {card.report.availability}{card.report.earliestAt ? <> · earliest <VenueTime value={card.report.earliestAt} /></> : null}</p> : null}
    <div className="supplier-recovery-fields"><label>New delivery date and time<input type="datetime-local" step="60" aria-describedby={help} value={delivery} onChange={event => setDelivery(event.target.value)} required /></label><label>Scenario quote acceptance deadline<input type="datetime-local" step="60" aria-describedby={help} value={deadline} onChange={event => setDeadline(event.target.value)} required /></label><label>Rental fee (USD)<input inputMode="decimal" value={fee} onChange={event => setFee(event.target.value)} aria-describedby="supplier-money-boundary" /></label><label>Separate damage hold (USD)<input inputMode="decimal" value={deposit} onChange={event => setDeposit(event.target.value)} aria-describedby="supplier-money-boundary" /></label><label>Real-time validity<select value={minutes} onChange={event => setMinutes(Number(event.target.value))}><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>60 minutes</option></select></label><div className="supplier-recovery-source"><span>Bound by this exact supplier access</span><ActualTime value={client.data!.expiresAt} /></div></div>
    <p id="supplier-money-boundary">Quoted amounts only. Publishing terms does not reserve equipment or create a payment.</p>
    <fieldset><legend>Equipment and delivery evidence</legend><label className="supplier-recovery-check"><input type="checkbox" checked={compatible} onChange={event => setCompatible(event.target.checked)} /><span>This controlled source confirms console compatibility.</span></label><label>Capability source<textarea rows={2} maxLength={1200} value={capability} onChange={event => setCapability(event.target.value)} placeholder="Identify the controlled capability sheet and what it establishes." /></label><div className="supplier-recovery-fields"><label>Qualified driver<select value={driver} onChange={event => setDriver(event.target.value)}><option value="unknown">Unknown · remains a blocker</option><option value="yes">Confirmed in controlled source</option><option value="no">Not qualified</option></select></label><label>Pre-dispatch condition<select value={condition} onChange={event => setCondition(event.target.value)}><option value="unknown">Unknown · remains a blocker</option><option value="yes">Verified in controlled source</option><option value="no">Condition not accepted</option></select></label></div>{driver === "yes" ? <label>Controlled driver source<textarea rows={2} maxLength={1200} value={driverSource} onChange={event => setDriverSource(event.target.value)} /></label> : null}{condition === "yes" ? <label>Controlled condition source<textarea rows={2} maxLength={1200} value={conditionSource} onChange={event => setConditionSource(event.target.value)} /></label> : null}</fieldset>
    <label>Source reference<input maxLength={180} value={reference} onChange={event => setReference(event.target.value)} placeholder="Your reviewed availability or quotation reference" /></label><label>Current terms and delivery responsibility<textarea rows={3} maxLength={1600} value={detail} onChange={event => setDetail(event.target.value)} placeholder="Describe the new offer, delivery responsibility and any limits." /></label>
    <label className="supplier-recovery-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>I reviewed this exact unit, its new times and sources. This is attributed controlled evidence; it does not claim a physical handoff or provider receipt.</span></label>
    <div className="supplier-recovery-review-total"><ShieldCheck size={19} /><span>{money(fee) !== null ? formatMoney(money(fee)!, true) : "Review fee"} rental fee · {money(deposit) !== null ? formatMoney(money(deposit)!, true) : "Review hold"} separate hold</span></div>
    {error ? <p role="alert" className="supplier-recovery-message error">{error}</p> : null}<SupplierRecoveryFeedback client={client} />
    <div className="modal-actions"><Button disabled={Boolean(client.busy)} onClick={onClose}>Keep reviewing</Button><Button variant="primary" disabled={!ready || client.blocked} busy={client.busy === "publish_terms"} onClick={() => void save()}>Publish this terms edition <ArrowRight size={16} /></Button></div>
  </div></Modal>;
}
