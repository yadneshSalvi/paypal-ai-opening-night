"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, LoaderCircle, ShieldCheck } from "lucide-react";
import { Badge, Button } from "./ui";
import { productionFetch } from "./production-fetch";
export function PaymentReturn({ tenantId }: { tenantId: string | null }) {
  const [state, setState] = useState<"checking" | "confirmed" | "pending" | "canceled" | "error">("checking"); const [message, setMessage] = useState("Reading the exact order and its current PayPal approval…"); const once = useRef(false);
  useEffect(() => {
    if (once.current) return; once.current = true;
    const params = new URLSearchParams(location.search); const intentId = params.get("intent"), nonce = params.get("state");
    if (params.get("cancel") === "1") { setState("canceled"); setMessage("You left PayPal before approval. The existing order remains recorded; no completed payment is assumed."); return; }
    if (!intentId || !nonce) { setState("error"); setMessage("This checkout return is missing its original operation identity."); return; }
    if (!tenantId) { setState("error"); setMessage("Reopen the original rehearsal before checking this payment return. Its original checkout and receipts remain saved."); return; }
    void productionFetch(tenantId, "/api/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "complete_checkout", intentId, state: nonce }) }).then(async response => { const result = await response.json(); if (!response.ok || !result.operation) throw new Error(result.error ?? "The exact checkout could not be verified."); const verified = result.operation.status === "succeeded"; setState(verified ? "confirmed" : "pending"); setMessage(verified ? "The provider receipt is saved against this exact production and original order. Delivery, refunds, and crew readback still require their own evidence." : result.operation.error ?? "The payment outcome remains pending. Its durable identity is preserved; return to the desk to reconcile it safely."); if (verified) history.replaceState(null, "", "/payments/return"); }).catch(error => { setState("error"); setMessage(error.message); });
  }, [tenantId]);
  return <main className="payment-return"><Link className="return-brand" href="/">OPENING NIGHT<span>.</span></Link><section><Badge tone="blue">PAYPAL SANDBOX</Badge><div className={"return-symbol " + state}>{state === "checking" ? <LoaderCircle className="spin" size={36} /> : state === "confirmed" ? <CheckCircle2 size={40} /> : <ShieldCheck size={40} />}</div><h1>{state === "checking" ? "Checking the promise." : state === "confirmed" ? "Receipt confirmed." : state === "canceled" ? "Your approval is still yours." : "The record stays intact."}</h1><p role="status">{message}</p><div className="payment-actions"><Link className="button primary" href="/execution">Return to execution <ArrowRight size={16} /></Link><Link className="button secondary" href="/box-office">Open box office</Link>{state === "error" && <Button onClick={() => location.reload()}>Check return again</Button>}</div></section><footer>Fictional show. Real sandbox receipts. Every green light needs evidence.</footer></main>;
}
