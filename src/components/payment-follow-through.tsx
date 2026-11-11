"use client";
import { useCallback, useEffect, useState } from "react";
import { Check, CircleDashed, Clock3, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import type { ConsoleData } from "@/domain/contracts";
import { financialSummary } from "@/domain/finance";
import { Badge, Button } from "./ui";

type Status = "queued" | "running" | "waiting" | "complete" | "needs_attention";
interface WorkState {
  jobs: { id: string; kind: string; status: Status; attempts: number; maxAttempts: number; runAfter: string; lastCode: string | null; updatedAt: string }[];
  counts: Partial<Record<Status, number>>; deliveries: { received: number; processed: number };
  workerConfigured: boolean; webhookConfigured: { venue: boolean; brightline: boolean };
}
const labels: Record<Status, string> = { queued: "Queued", running: "Checking", waiting: "Waiting to reconcile", complete: "Resolved", needs_attention: "Review needed" };
const reasons: Record<string, string> = { PROVIDER_OUTCOME_UNKNOWN: "Provider outcome is still unknown. The same payment will not be sent again.", EXPLICIT_RETRY_REQUIRED: "Review the refused or unsent operation before an explicit retry.", ATTEMPT_LIMIT: "Automatic checks reached their limit. Keep the original payment and inspect its provider state.", OPERATION_LEASE_ACTIVE: "The original request still owns this operation.", RESOURCE_BINDING_REQUIRED: "The original order has no verified provider identity yet.", APPROVAL_EXPIRED: "The original approval expired. Review current authority before continuing.", AUTHORITY_REVOKED: "The approving session is no longer active.", HOLD_EXPIRED: "The equipment hold expired. Reconfirm capacity or review the uncaptured authorization.", RFQ_PLAN_CHANGED: "The production changed while suppliers replied. Collect fresh quotes against the current plan.", RFQ_EXPIRED: "Supplier terms expired before the full collection completed.", SUPPLIER_UNAVAILABLE: "A supplier response is still pending. Received quotes are saved under their original request identities.", SUPPLIER_HOLD_EXPIRED: "The supplier hold expired before dispatch. No new payment was authorized." };
export function PaymentFollowThrough({ data, onChange }: { data: ConsoleData; onChange: (value: ConsoleData) => void }) {
  const [state, setState] = useState<WorkState | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/jobs", { cache: "no-store", ...(signal ? { signal } : {}) }); const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "The payment follow-through status is unavailable.");
    setState(body); setError(null);
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error.message); }); return () => controller.abort(); }, [load, data.show.revision]);
  const unresolved = (state?.counts.queued ?? 0) + (state?.counts.running ?? 0) + (state?.counts.waiting ?? 0);
  useEffect(() => { if (!unresolved) return; const controller = new AbortController(); const timer = setInterval(() => { void load(controller.signal).catch(() => { /* Keep the last verified status visible. */ }); }, 15000); return () => { clearInterval(timer); controller.abort(); }; }, [unresolved, load]);
  const resume = async () => {
    setBusy(true); setError(null); setNotice("");
    try { const response = await fetch("/api/jobs", { method: "POST" }); const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "The saved work could not be checked."); onChange(body); await load(); setNotice(body.tick.processed ? "Saved work checked. Provider uncertainty stays visible until resolved." : "No saved work is due yet. Its next check remains scheduled."); }
    catch (error) { setError(error instanceof Error ? error.message : "The saved work could not be checked."); }
    finally { setBusy(false); }
  };
  const review = state?.counts.needs_attention ?? 0; const disputed = financialSummary(data.show).disputedEvidenceCount;
  const active = state?.jobs.filter(job => job.status !== "complete").slice(0, 5) ?? [];
  if (!state) return <div className="payment-follow-through" aria-busy={!error}><div className="follow-through-heading"><CircleDashed size={20} /><div><h3>Payment follow-through</h3><p role="status">{error ?? "Loading the saved work and delivery evidence…"}</p></div></div>{error && <Button onClick={() => { void load().catch(error => setError(error.message)); }}>Check status again</Button>}</div>;
  return <div className="payment-follow-through">
    <div className="follow-through-heading"><CircleDashed size={20} /><div><h3>Every commitment has a follow-through.</h3><p>Approved work survives a closed tab. Unknown outcomes stay pending until PayPal can confirm them.</p></div><Badge tone={review || disputed ? "amber" : "muted"}>{review ? `${review} TO REVIEW` : unresolved ? `${unresolved} IN PROGRESS` : "SAVED WITH THE SHOW"}</Badge></div>
    {disputed > 0 && <p className="payment-readback-warning" role="alert"><TriangleAlert size={18} />A provider update requires review of {disputed} historical receipt{disputed === 1 ? "" : "s"}. Financial readiness stays blocked until their current state is verified.</p>}
    <div className="follow-through-summary"><span><Check size={14} />{state?.counts.complete ?? 0} resolved</span><span><Clock3 size={14} />{unresolved} pending</span><span><ShieldCheck size={14} />{state?.deliveries.processed ?? 0} signed deliveries reconciled</span></div>
    {active.length > 0 && <ul className="follow-through-list">{active.map(job => <li key={job.id}><span className={`tiny-dot ${job.status === "needs_attention" ? "amber" : "blue"}`} /><div><strong>{job.kind === "webhook_reconcile" ? "Provider update" : job.kind === "supplier_rfq" ? "Supplier quotes" : job.kind === "supplier_expire" ? "Reservation expiry" : job.kind === "supplier_confirm" ? "Supplier confirmation" : "Approved payment"}</strong><p>{job.lastCode ? reasons[job.lastCode] ?? "The current provider state needs another bounded check." : "The original operation and its exact approved terms are saved."}</p></div><Badge tone={job.status === "needs_attention" ? "amber" : "muted"}>{labels[job.status]}</Badge></li>)}</ul>}
    <div className="follow-through-actions"><Button disabled={busy || !unresolved} busy={busy} onClick={() => void resume()}><RefreshCw size={14} />Resume due work</Button><details><summary>Delivery evidence & recovery</summary><p>{state?.workerConfigured ? "A worker capability is configured. Completed work above may come from the scheduler or a producer’s manual check." : "Automatic scheduling is not enabled for this deployment. The producer can resume saved work when its check is due."}</p><p>{state?.deliveries.received ? `${state.deliveries.received} authentic verified PayPal deliveries are recorded for this production.` : "No authentic signed PayPal delivery has been recorded for this production yet."} Local wire fixtures do not contribute to this count.</p><p>{state?.webhookConfigured.venue && state?.webhookConfigured.brightline ? "Both merchant verification IDs are configured." : "Merchant webhook registration remains a qualification step."} Buyer approval, delivery acceptance, and monetary execution remain separate.</p></details></div>
    <p className="follow-through-notice" role="status" aria-live="polite">{notice}</p>
    {error && <p className="payment-error" role="alert">{error}</p>}
  </div>;
}
