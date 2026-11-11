"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, ExternalLink, Fingerprint, LockKeyhole, RefreshCw, ShieldCheck, WalletCards } from "lucide-react";
import type { ConsoleData } from "@/domain/contracts";
import type { PublicPayment } from "@/domain/payment-authority";
import type { PaymentRequest } from "@/server/payment-service";
import { formatMoney } from "@/domain/time";
import { Badge, Button, Modal } from "./ui";
import { PaymentFollowThrough } from "./payment-follow-through";
import { currentRentalExecution } from "@/domain/supplier-contracts";
import { currentActual, uniqueActual } from "@/domain/finance";

type Review = "rental" | "standard" | "vip" | "fee" | "release";
const reviewCopy: Record<Review, { title: string; amount: number; detail: string; action: string }> = {
  rental: { title: "Review the supplier authorization", amount: 78000, detail: "Brightline’s separate sandbox merchant will request a $780 authorization: $480 fee plus a $300 damage hold. You approve the order in PayPal. No rental fee is captured by this step.", action: "Create exact PayPal checkout" },
  fee: { title: "Capture the accepted rental fee", amount: 48000, detail: "Capture $480 from this production’s original $780 Brightline authorization after the controlled delivery acceptance. Preserve $300 for damage inspection.", action: "Capture $480 fee" },
  release: { title: "Release the remaining authorization", amount: 30000, detail: "Void the uncaptured balance after the supplier’s recorded undamaged return. This releases the remaining $300 hold; the captured $480 fee is unchanged.", action: "Release remaining $300 hold" },
  standard: { title: "Review the admission checkout", amount: 3500, detail: "One controlled standard admission ticket. PayPal approval will complete a $35 sandbox purchase.", action: "Create exact PayPal checkout" },
  vip: { title: "Review the VIP checkout", amount: 5000, detail: "One controlled VIP ticket: $35 admission and a separately itemized $15 soundcheck visit. PayPal approval will complete a $50 sandbox purchase.", action: "Create exact PayPal checkout" },
};
export function PaymentDesk({ data, onChange, mode = "rental" }: { data: ConsoleData; onChange: (data: ConsoleData) => void; mode?: "rental" | "tickets" | "wrap" }) {
  const [payments, setPayments] = useState<PublicPayment[]>([]); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const [review, setReview] = useState<Review | null>(null); const [confirmed, setConfirmed] = useState(false); const [supplierUrl, setSupplierUrl] = useState<string | null>(null);
  const load = useCallback(async () => { const response = await fetch("/api/payments", { cache: "no-store" }); const result = await response.json(); if (!response.ok) throw new Error(result.error); setPayments(result.payments); }, []);
  useEffect(() => { void load().catch(error => setError(error.message)); }, [load, data.show.revision]);
  const { show } = data;
  const execution = currentRentalExecution(show);
  const [holdNow, setHoldNow] = useState(Date.now());
  useEffect(() => { if (show.commercialProtocol !== 2) return; const timer = setInterval(() => setHoldNow(Date.now()), 1000); return () => clearInterval(timer); }, [show.commercialProtocol]);
  const holdReady = show.commercialProtocol !== 2 || Boolean(execution && ["held", "awaiting_payment", "authorized"].includes(execution.state) && Date.parse(execution.holdExpiresAt) > holdNow);
  useEffect(() => { for (const tier of ["standard", "vip"] as const) { const key = "opening-night-pending-ticket:" + show.tenantId + ":" + tier; if (show.tickets.some(ticket => ticket.id === sessionStorage.getItem(key) && ticket.captureId)) sessionStorage.removeItem(key); } }, [show.tenantId, show.tickets]);
  const actual = currentActual(show).filter(e => e.planVersion === show.planVersion);
  const rental = payments.find(p => p.purpose === "rental_order" && p.planVersion === show.planVersion);
  const history = uniqueActual(show).filter(e => e.planVersion === show.planVersion);
  const everAuthorized = history.some(e => e.kind === "authorization" && e.purpose === "rental");
  const everCaptured = history.some(e => e.kind === "capture" && e.purpose === "rental");
  const everReleased = history.some(e => e.kind === "void" && e.purpose === "deposit");
  const authorized = actual.some(e => e.kind === "authorization" && e.purpose === "rental");
  const captured = actual.some(e => e.kind === "capture" && e.purpose === "rental");
  const released = actual.some(e => e.kind === "void" && e.purpose === "deposit");
  const hasFact = (kind: string) => show.facts.some(f => f.kind === kind && f.planVersion === show.planVersion);
  const perform = async (request: PaymentRequest) => {
    setBusy(request.type); setError(null);
    try {
      const response = await fetch("/api/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }); const result = await response.json();
      if (!response.ok || !result.show) throw new Error(result.error ?? "This payment is awaiting reconciliation.");
      setPayments(result.payments); onChange(result); setReview(null); setConfirmed(false);
      if (result.operation.error) setError(result.operation.error);
    } catch (error) { setError(error instanceof Error ? error.message : "The payment could not be confirmed."); }
    finally { setBusy(null); }
  };
  const inviteSupplier = async () => {
    setBusy("supplier"); setError(null);
    try { const response = await fetch("/api/supplier/invite", { method: "POST" }); const result = await response.json(); if (!response.ok) throw new Error(result.error); setSupplierUrl(result.url); }
    catch (error) { setError(error instanceof Error ? error.message : "The supplier portal could not open."); }
    finally { setBusy(null); }
  };
  const commit = () => {
    if (!confirmed || !review) return;
    if (review === "rental") void perform({ type: "rental_checkout", expectedRevision: show.revision });
    else if (review === "fee" && rental) void perform({ type: "capture_rental_fee", intentId: rental.id, expectedRevision: show.revision });
    else if (review === "release" && rental) void perform({ type: "release_rental_hold", intentId: rental.id, expectedRevision: show.revision });
    else if (review === "standard" || review === "vip") {
      const key = "opening-night-pending-ticket:" + show.tenantId + ":" + review;
      const ticketId = sessionStorage.getItem(key) ?? crypto.randomUUID(); sessionStorage.setItem(key, ticketId);
      void perform({ type: "ticket_checkout", ticketId, tier: review, expectedRevision: show.revision }).then(() => { /* The same ticket identity is retained until its result is visible. */ });
    }
  };
  const open = (value: Review) => { setConfirmed(false); setReview(value); };
  const relevant = payments.filter(p => mode === "tickets" ? p.seller === "venue" : p.seller === "brightline");
  return <section id={mode === "rental" ? "rental-payment" : undefined} className="payment-desk" aria-label={mode === "tickets" ? "Ticket payments" : "Supplier payment execution"}>
    <div className="payment-desk-head"><div className="payment-desk-symbol"><WalletCards size={24} /></div><div><span className="eyebrow">{mode === "tickets" ? "BOX OFFICE" : "BRIGHTLINE RENTALS"} / PAYPAL SANDBOX</span><h2>{mode === "tickets" ? "Make the promise traceable." : mode === "wrap" ? "Release the final hold." : "Secure the console. Preserve the hold."}</h2></div><Badge tone={authorized ? "green" : "blue"}>{mode === "tickets" ? "ITEMIZED CHECKOUT" : authorized ? "AUTHORIZATION VERIFIED" : everAuthorized ? "CURRENT CHECK REQUIRED" : "BUYER APPROVAL REQUIRED"}</Badge></div>
    {mode === "rental" && <>
      <div className="payment-allocation"><div><span>Rental fee</span><strong>$480</strong><small>Captured after accepted delivery</small></div><b>+</b><div><span>Damage authorization</span><strong>$300</strong><small>Held until undamaged return</small></div><b>=</b><div><span>Buyer authorizes</span><strong>$780</strong><small>Separate supplier merchant</small></div></div>
      <div className="payment-actions">{!rental ? <Button variant="primary" disabled={!show.approvedPlan || !holdReady || Boolean(busy)} onClick={() => open("rental")}>Review $780 authorization <ArrowRight size={16} /></Button> : rental.approvalUrl && !everAuthorized && holdReady ? <a href={rental.approvalUrl} className="button primary">Continue at PayPal <ExternalLink size={15} /></a> : <span className="payment-confirmed"><ShieldCheck size={18} />{authorized ? "$780 authorization verified" : everAuthorized ? "Historical authorization saved; current provider review is pending" : "Checkout recorded; provider evidence is pending"}</span>}<Button onClick={inviteSupplier} busy={busy === "supplier"} disabled={!show.approvedPlan || Boolean(busy)}>Open controlled supplier portal</Button>{show.commercialProtocol !== 2 && <Button onClick={() => open("fee")} disabled={!authorized || !hasFact("delivery_accepted") || !hasFact("supplier_confirmed") || everCaptured || Boolean(busy)}>{captured ? <Check size={16} /> : <LockKeyhole size={16} />}{captured ? "$480 fee captured" : everCaptured ? "$480 captured · current check pending" : "Review $480 fee capture"}</Button>}</div>
      <p className="payment-footnote">{show.commercialProtocol === 2 && !holdReady && !authorized ? "Reconfirm the equipment hold before continuing buyer approval. " : ""}Supplier confirmation, accepted delivery, and fee capture are separate steps. This is a controlled fictional rental with real sandbox payment records.</p>
    </>}
    {mode === "tickets" && <><p className="payment-description">A $35 admission remains intact when the separately priced $15 soundcheck visit is canceled. Each checkout is one controlled ticket with its own original capture.</p><div className="payment-actions"><Button variant="primary" disabled={Boolean(busy)} onClick={() => open("standard")}>Review $35 admission <ArrowRight size={15} /></Button><Button disabled={Boolean(busy)} onClick={() => open("vip")}>Review $50 VIP ticket</Button></div><p className="payment-footnote">Actual purchases are added to the receipt ledger. A planned cohort never becomes sales merely by opening a rehearsal.</p></>}
    {mode === "wrap" && <><p className="payment-description">The supplier records the controlled console’s undamaged return. PayPal then verifies and voids the remaining $300 authorization; this is a release, not revenue or a refund.</p><div className="payment-actions"><Button onClick={inviteSupplier} busy={busy === "supplier"}>Open return inspection</Button><Button variant="primary" disabled={!hasFact("return_accepted") || !captured || everReleased || Boolean(busy)} onClick={() => open("release")}>{released ? "Hold released" : everReleased ? "Hold released · current check pending" : "Review $300 hold release"}</Button></div></>}
    {error && <p className="payment-error" role="alert">{error}</p>}
    {relevant.length > 0 && <div className="payment-operation-list">{relevant.slice(-6).map(operation => <div className="payment-operation" key={operation.id}><Fingerprint size={16} /><div><b>{operation.purpose.replaceAll("_", " ")}</b><small>{operation.resources.map(r => r.kind + " " + r.reference).join(" · ") || "No provider resource confirmed yet"}</small></div><strong>{formatMoney(operation.purpose === "rental_release" ? 30000 : operation.amountMinor)}</strong><Badge tone={operation.status === "succeeded" ? "green" : operation.status === "refused" ? "red" : "amber"}>{operation.purpose.endsWith("order") && operation.status === "succeeded" ? "ORDER CREATED" : operation.status.replaceAll("_", " ").toUpperCase()}</Badge>{operation.approvalUrl && operation.purpose === "ticket_order" && !show.tickets.some(t => t.id === operation.ticketId) && <a className="button secondary" href={operation.approvalUrl}>Approve in PayPal</a>}{["pending_reconciliation", "dispatching", "claimed"].includes(operation.status) && <Button disabled={Boolean(busy)} onClick={() => perform({ type: "reconcile", intentId: operation.id })}><RefreshCw size={14} />Check provider</Button>}{["refused", "not_sent"].includes(operation.status) && <Button disabled={Boolean(busy)} onClick={() => perform({ type: "retry_refused", intentId: operation.id })}>Retry verified refusal</Button>}</div>)}</div>}
    {review && <Modal title={reviewCopy[review].title} onClose={() => { if (!busy) setReview(null); }}><div className="payment-review"><span className="eyebrow">EXACT APPROVED AMOUNT · USD</span><strong>{formatMoney(reviewCopy[review].amount)}</strong><p>{reviewCopy[review].detail}</p><label className="payment-consent"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>I approve this exact sandbox operation and its stated allocation for the current production.</span></label><div className="modal-actions"><Button onClick={() => setReview(null)} disabled={Boolean(busy)}>Back</Button><Button variant="primary" disabled={!confirmed} busy={Boolean(busy)} onClick={commit}>{reviewCopy[review].action}<ArrowRight size={15} /></Button></div><small className="muted">Plan v{show.planVersion} · revision {show.revision} · duplicate requests reuse the same recorded operation.</small></div></Modal>}
    {supplierUrl && <Modal title="Controlled Brightline supplier client" onClose={() => setSupplierUrl(null)}><p>This private capability opens a separate supplier role for this rehearsal. It can confirm the selected terms and record an attributed return inspection. It does not represent participation by a real rental company.</p><div className="modal-actions"><a className="button primary" href={supplierUrl} target="_blank" rel="noreferrer">Open supplier client <ExternalLink size={15} /></a><Button onClick={async () => { await navigator.clipboard.writeText(new URL(supplierUrl, location.origin).href); }}>Copy private link</Button></div></Modal>}
    <PaymentFollowThrough data={data} onChange={onChange} />
  </section>;
}
