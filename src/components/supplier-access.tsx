"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, LockKeyhole, PackageCheck, RefreshCw, TriangleAlert } from "lucide-react";
import type { SupplierOffer } from "@/domain/contracts";
import type { PublicPayment } from "@/domain/payment-authority";
import type { RentalState } from "@/domain/supplier-contracts";
import { formatMoney, localTime } from "@/domain/time";
import { Badge, Button } from "./ui";
import { DeliveryIssuer } from "./delivery-handoff";
import { SupplierDisruptionPanel } from "./disruptions/supplier-disruption-panel";
import { SupplierRentalCloseout } from "./rental-closeout/rental-desk";

interface SupplierProjection {
  revision: number; planVersion: number; planDigest: string; show: string; venue: string; clock: string;
  offer: SupplierOffer; facts: { kind: string; detail: string }[]; payments: PublicPayment[];
  protocol?: number; operatingMode?: "support_only" | "cancel_show" | null; execution?: { id: string; state: RentalState; deliveryAt: string; acceptedAt?: string | null; lastCode?: string | null } | null;
}
type SupplierAction = "supplier_confirmed" | "return_accepted" | "rejected_returned";
export function SupplierAccess() {
  const [data, setData] = useState<SupplierProjection | null>(null);
  const [token, setToken] = useState(""); const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [accepted, setAccepted] = useState(false); const [detail, setDetail] = useState("");
  const [disruptionBlocked, setDisruptionBlocked] = useState(false), [closeoutBlocked, setCloseoutBlocked] = useState(false);
  const [reservationNotice, setReservationNotice] = useState<string | null>(null);
  const load = useCallback(async (capability: string) => {
    const response = await fetch("/api/supplier", { headers: { Authorization: "Bearer " + capability }, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) {
      if (["PLAN_APPROVAL_REQUIRED", "OFFER_CHANGED", "SUPPLIER_CHANGED"].includes(result.code)) { setData(null); setReservationNotice("No current approved reservation is available in your supplier scope. Your own availability reports and retained rentals remain available below."); setError(null); return; }
      throw new Error(result.error);
    }
    setData(result); setReservationNotice(null); setError(null);
  }, []);
  useEffect(() => {
    const capability = location.hash.slice(1) || sessionStorage.getItem("opening-night-supplier") || "";
    if (location.hash) { sessionStorage.setItem("opening-night-supplier", capability); history.replaceState(null, "", location.pathname); }
    setToken(capability);
    if (!capability) { setError("Open the private supplier link from the producer’s execution desk."); return; }
    void load(capability).catch(error => setError(error.message));
  }, [load]);
  const submit = async (fact: SupplierAction) => {
    if (!data || !accepted || busy || disruptionBlocked || closeoutBlocked) return; setBusy(true); setError(null);
    try {
      const response = await fetch("/api/supplier", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), expectedRevision: data.revision, planDigest: data.planDigest, fact, detail }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      setData(result); setAccepted(false); setDetail("");
    } catch (error) { setError(error instanceof Error ? error.message : "The supplier action could not complete."); await load(token).catch(() => undefined); }
    finally { setBusy(false); }
  };
  const state = data?.execution?.state;
  const signed = data?.protocol === 2;
  const confirmed = signed ? Boolean(state && ["confirmed", "delivered", "accepted", "returned"].includes(state)) : data?.facts.some(fact => fact.kind === "supplier_confirmed");
  const returned = signed ? state === "returned" || state === "returned_unaccepted" : data?.facts.some(fact => fact.kind === "return_accepted");
  const rejected = signed && state === "needs_attention" && !data?.execution?.acceptedAt;
  const returnUnaccepted = state === "returned_unaccepted";
  const rentalFee = data?.payments.some(payment => payment.purpose === "rental_fee" && payment.status === "succeeded");
  const canConfirm = signed ? state === "authorized" : !confirmed;
  const canReturn = signed ? rejected : confirmed && !returned;
  const action: SupplierAction = rejected ? "rejected_returned" : canReturn ? "return_accepted" : "supplier_confirmed";
  const actionTitle = rejected ? "Receive the rejected console." : canReturn ? "Record the controlled return." : "Confirm the exact reservation.";
  const actionDetail = rejected ? "Record receipt of the exact unit rejected by the lighting lead. This preserves the failed inspection and creates no rental fee. The producer must separately review any uncaptured authorization cancellation." : canReturn ? "Describe the controlled undamaged-return inspection at the scheduled return step or after an approved program cancellation. The original accepted fee stays recorded. The producer can request hold closure only after this record and the original fee receipt exist." : "Review this unit, delivery time, fee, deposit and current plan. This confirmation is separate from PayPal buyer approval.";
  return <main id="main" className="supplier-page">
    <header><span className="return-brand">OPENING NIGHT<span>.</span></span><Badge tone="blue">CONTROLLED SUPPLIER CLIENT</Badge></header>
    <div className="supplier-body">
      <span className="eyebrow">{data?.offer.supplier.toUpperCase() ?? "ENROLLED SUPPLIER"} / PRIVATE RESERVATION</span>
      <h1>Keep the promise<br /><em>behind the show.</em></h1>
      <p className="supplier-boundary">This is a separate controlled client for a fictional supplier. Its actions are attributed rehearsal evidence, not a claim of real crew participation or physical equipment inspection.</p>
      {error && <p className="payment-error" role="alert">{error}</p>}
      {reservationNotice && <p className="supplier-board-note">{reservationNotice}</p>}
      {!data && token && <SupplierDisruptionPanel bearer={token} onSaved={() => load(token)} onBlockedChange={setDisruptionBlocked} reservationBusy={busy || closeoutBlocked} />}
      {data ? <>
        <section className="supplier-terms">
          <div><Badge tone="amber">PLAN v{data.planVersion}</Badge><span className="mono">REVISION {data.revision}</span></div>
          <h2>{data.show}<span>{data.venue}</span></h2>
          <dl><div><dt>Console</dt><dd>{data.offer.unitId}</dd></div><div><dt>Delivery</dt><dd>{localTime(data.offer.deliveryAt)} CST</dd></div><div><dt>Rental fee</dt><dd>{formatMoney(data.offer.feeMinor)}</dd></div><div><dt>Damage hold</dt><dd>{formatMoney(data.offer.depositMinor)}</dd></div></dl>
          <p>{data.offer.terms}</p>
          <div className="supplier-milestones">
            <span>{confirmed ? <CheckCircle2 size={18} /> : <LockKeyhole size={18} />}{confirmed ? "Reservation confirmed" : state ? state.replaceAll("_", " ") : "Supplier confirmation pending"}</span>
            <span>{rentalFee ? <CheckCircle2 size={18} /> : <LockKeyhole size={18} />}{rentalFee ? "Rental fee captured" : rejected || returnUnaccepted ? "Condition rejected · no fee instruction" : "Fee capture awaits accepted delivery"}</span>
            <span>{returned ? <CheckCircle2 size={18} /> : <PackageCheck size={18} />}{returnUnaccepted ? "Rejected unit received by supplier" : returned ? "Controlled return recorded" : "Return inspection pending"}</span>
          </div>
        </section>
        <SupplierDisruptionPanel bearer={token} onSaved={() => load(token)} onBlockedChange={setDisruptionBlocked} reservationBusy={busy || closeoutBlocked} />
        {disruptionBlocked && <p className="supplier-board-note"><TriangleAlert size={18} />Reservation and handoff actions are paused while availability facts, original instructions or access are being checked.</p>}
        {signed && state === "confirmed" && data.execution && <section className="supplier-action" inert={disruptionBlocked || closeoutBlocked}><h2>Prepare the driver handoff.</h2><p>Issue the signed code for this exact unit and reservation. The assigned driver scans it; the lighting lead accepts condition separately.</p><DeliveryIssuer executionId={data.execution.id} bearer={token} onChanged={() => { void load(token); }} /></section>}
        {returnUnaccepted && <p className="supplier-board-note"><TriangleAlert size={18} />The rejected unit is accounted for. Its original authorization remains open until the producer’s explicit cancellation is confirmed by PayPal.</p>}
        {(canConfirm || canReturn) && <section className="supplier-action">
          <h2>{actionTitle}</h2><p>{actionDetail}</p>
          <label className="supplier-detail">{rejected ? "Rejected unit receipt and condition note" : canReturn ? "Controlled return condition note" : "Controlled reservation note"}<textarea value={detail} onChange={event => setDetail(event.target.value)} minLength={12} maxLength={1200} rows={4} placeholder={rejected ? "Describe receipt of the rejected unit and its recorded condition…" : canReturn ? "Describe the controlled inspection and condition…" : "Record the reviewed unit, delivery and reservation terms…"} /></label>
          <label className="payment-consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} /><span>I reviewed these current terms. This action records a controlled fixture event; it does not claim physical verification.</span></label>
          <div className="payment-actions"><Button variant="primary" disabled={!accepted || detail.trim().length < 12 || disruptionBlocked || closeoutBlocked} busy={busy} onClick={() => void submit(action)}>{rejected ? "Record rejected unit received" : canReturn ? "Record controlled undamaged return" : "Confirm controlled reservation"}<ArrowRight size={16} /></Button></div>
          <small className="muted">Fixture clock {localTime(data.clock)} CST{rejected ? " · the rejected-return record creates no fee or accepted-condition fact." : data.operatingMode ? " · the program cancellation permits an attributed return inspection; captured fees remain in their original ledger." : " · ordinary return acceptance opens at 23:30."}</small>
        </section>}
        <div className="payment-actions"><Button disabled={busy} onClick={() => void load(token).catch(error => setError(error.message))}><RefreshCw size={15} />Refresh reservation and handoff</Button></div>
      </> : !error && !reservationNotice && <p role="status">Reading your scoped reservation…</p>}
      {token ? <SupplierRentalCloseout bearer={token} onSaved={() => load(token)} onBlockedChange={setCloseoutBlocked} reservationBusy={busy || disruptionBlocked} /> : null}
    </div>
  </main>;
}
