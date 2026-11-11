"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, LoaderCircle, ShieldCheck } from "lucide-react";
import type { PublicWallet } from "@/domain/commerce-contracts";
import { Badge, Button } from "./ui";

export function WalletReturn() {
  const [wallet, setWallet] = useState<PublicWallet | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  const check = async () => {
    setBusy(true); setError(null);
    try {
      const params = new URLSearchParams(location.search), setupId = params.get("setup"), state = params.get("state");
      if (!setupId) throw new Error("This wallet return is missing its original request identity. Open the saved request in the box office.");
      const response = await fetch("/api/commerce", state ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "wallet_return", setupId, state, cancel: params.get("cancel") === "1" }) } : { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.commerce?.wallet || result.commerce.wallet.id !== setupId) throw new Error(result.error ?? "The original wallet request could not be verified.");
      setWallet(result.commerce.wallet);
      if (["ready", "cancelled"].includes(result.commerce.wallet.status)) history.replaceState(null, "", "/wallet/return?setup=" + encodeURIComponent(setupId));
    } catch (error) { setError(error instanceof Error ? error.message : "The saved method could not be verified."); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (!once.current) { once.current = true; void check(); } }, []);
  const ready = wallet?.status === "ready", cancelled = wallet?.status === "cancelled";
  return <main className="payment-return wallet-return">
    <Link className="return-brand" href="/">OPENING NIGHT<span>.</span></Link>
    <section><Badge tone="blue">PAYPAL SANDBOX · SAVE ONLY</Badge>
      <div className={"return-symbol " + (ready ? "confirmed" : "checking")}>{busy ? <LoaderCircle className="spin" size={36} /> : ready ? <CheckCircle2 size={40} /> : <ShieldCheck size={40} />}</div>
      <h1>{busy ? "Checking the saved method." : ready ? "Wallet saved. $0 charged." : cancelled ? "Saving stopped here." : "The original request stays."}</h1>
      <p role={error ? "alert" : "status"}>{error ?? (ready ? "PayPal confirmed this method’s ownership. Saving did not reserve funds or authorize a ticket purchase. Return to the box office to review the exact 80-ticket approval, amount, and expiry." : cancelled ? "The method is disabled for this rehearsal. Existing PayPal records and payment receipts are retained. No ticket run was approved by this step." : busy ? "Reading the original PayPal setup and its customer association…" : "Saving is not yet verified. The original request remains recorded; return to the box office to check its exact state without creating a replacement.")}</p>
      <div className="payment-actions"><Link className="button primary" href="/box-office">Return to box office <ArrowRight size={16} /></Link>{!busy && !ready && !cancelled && <Button onClick={() => void check()}>Check this return again</Button>}</div>
    </section><footer>Saving a method, approving purchases, and receiving captures are separate steps.</footer>
  </main>;
}
