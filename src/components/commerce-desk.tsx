"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, Clock3, Fingerprint, LockKeyhole, Pause, RefreshCw, ShieldCheck, Ticket, TriangleAlert, WalletCards } from "lucide-react";
import type { ConsoleData } from "@/domain/contracts";
import type { CohortMode, CommerceLineState, CommerceOverview, PublicCohort, PublicCommerceLine, PublicRemedyPreview } from "@/domain/commerce-contracts";
import { formatMoney } from "@/domain/time";
import { Badge, Button, Modal, SectionHeading } from "./ui";
import { CohortResumeAction, CohortResumeSummary, cohortResumeReviewIsCurrent } from "./commerce-resume";

type Reply = ConsoleData & { commerce: CommerceOverview; work?: { status: string; code?: string } | null };
type Review = { type: "wallet" | "stop_wallet" | "stop_cohort" | "stop_remedy" } |
  { type: "cohort"; cohort: PublicCohort; revision: number } |
  { type: "resume_cohort"; cohort: PublicCohort } |
  { type: "remedy"; preview: PublicRemedyPreview; revision: number } |
  { type: "retry"; kind: "ticket" | "remedy" | "wallet"; line?: PublicCommerceLine };
const lineLabels: Record<CommerceLineState, string> = { waiting: "Awaiting consent", queued: "Queued", creating: "Creating checkout", approval_required: "Buyer approval needed", capturing: "Confirming capture", captured: "Captured", refunding: "Confirming remedy", refunded: "Refunded", pending: "Outcome pending", refused: "Request refused", stopped: "Stopped", needs_attention: "Review needed" };
const stateLabels: Record<string, string> = { draft: "REVIEW REQUIRED", approved: "APPROVED", paused: "PAUSED FOR REVIEW", revoked: "UNSTARTED WORK STOPPED", expired: "CONSENT EXPIRED", complete: "ALL ORIGINAL RECEIPTS RECORDED" };
const walletLabels: Record<string, string> = { preparing: "PREPARING APPROVAL", approval_required: "AWAITING PAYPAL APPROVAL", saving: "VERIFYING SAVED METHOD", ready: "WALLET SAVED", pending_reconciliation: "OUTCOME NOT YET KNOWN", refused: "PROVIDER REFUSED", cancelled: "DISABLED HERE", expired: "SAVE REQUEST EXPIRED", needs_attention: "REVIEW NEEDED" };
const explanations: Record<string, string> = {
  CAPTURE_STATE_REVIEW_REQUIRED: "The original capture remains recorded. Its current provider state needs review before it can clear financial readiness.",
  COHORT_BUYER_APPROVAL_REQUIRED: "PayPal needs the buyer to approve this original checkout. Resolve it before resuming the remaining tickets.",
  COHORT_PAYMENT_UNCERTAIN: "The last purchase has an unknown result. The run is paused and keeps that ticket’s original instruction.",
  COHORT_PAYMENT_REFUSED: "PayPal refused the last instruction. Review that ticket before deciding whether to retry its same checkout.",
  COHORT_CAPTURE_PENDING: "PayPal has a capture in progress. It must finish before another ticket starts.",
  COHORT_READBACK_REQUIRED: "The saved purchase needs review before the run continues. A request that has not reached PayPal may continue under its original approval; an uncertain payment must be resolved first.",
  CHECKOUT_ORIGIN: "The saved checkout is waiting for its approved return address. Its original ticket and approval remain saved.",
  COHORT_PAUSED: "The remaining tickets wait for the paused ticket to be resolved.",
  WALLET_OUTCOME_UNKNOWN: "PayPal may have saved the method. Its original request is retained; a replacement will not be created.",
  WALLET_RESPONSE_LOST: "The provider response was interrupted. Keep this save request while its outcome is investigated.",
  WALLET_CAPABILITY_REQUIRED: "This sandbox merchant cannot currently use this wallet capability. Individual PayPal approval remains available.",
  WALLET_CUSTOMER_MISMATCH: "The saved method’s customer association could not be verified. It cannot authorize this ticket run.",
  WALLET_CUSTOMER_UNPROVEN: "The saved method’s customer association has not been proven. No cohort charge is allowed.",
  WALLET_APPROVED_SETUP_REQUIRED: "PayPal has not confirmed the expected wallet approval. The original request remains recorded.",
  WALLET_BUYER_APPROVAL_REQUIRED: "Continue to PayPal to approve saving this method.",
  ATTEMPT_LIMIT: "Automatic checks reached their limit. Review the saved instruction and check its current provider state.",
  EXPLICIT_RETRY_REQUIRED: "This refused instruction needs explicit review before the same request can be retried.",
  APPROVAL_EXPIRED: "The original approval expired. Its receipts remain available.",
  COHORT_CONSENT_EXPIRED: "The 24-hour charge approval expired. Existing outcomes can still be checked.",
  WALLET_AUTHORITY_REVOKED: "This wallet was disabled for the rehearsal. Unstarted purchases cannot use it.",
  REMEDY_INDIVIDUAL_REVIEW_REQUIRED: "This remedy was approved individually. Its original instruction can be reviewed in the individual ticket desk.",
  REMEDY_CURRENT_STATE_REQUIRED: "The refund receipt is recorded, but the current capture and refund amounts do not yet prove the exact $15 remedy.",
};
function explanation(code: string | null | undefined) { return code ? explanations[code] ?? "This original instruction needs review. Confirmed receipts remain saved while its current state is checked." : ""; }
function dateTime(value: string | null) { return value ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value)) : "After approval"; }
function confirmed(line: PublicCommerceLine) { return line.state === "captured" || line.state === "refunded"; }
function LineProgress({ lines, total, label }: { lines: PublicCommerceLine[]; total: number; label: string }) {
  const complete = lines.filter(confirmed).length;
  return <div className="commerce-progress">
    <div className="commerce-progress-copy"><span>{label}</span><b>{complete}<small> / {total}</small></b></div>
    <div className="commerce-stamps" aria-hidden="true">{Array.from({ length: total }, (_, index) => { const line = lines[index]; return <span key={index} className={line?.lastCode === "CAPTURE_STATE_REVIEW_REQUIRED" ? "attention" : line && confirmed(line) ? "confirmed" : line && ["pending", "refused", "needs_attention", "approval_required"].includes(line.state) ? "attention" : line?.intentId ? "started" : ""} />; })}</div>
    <p className="small-text">Each mark represents one original {total === 80 ? "ticket" : "capture-specific remedy"}. Only verified receipts fill the confirmed marks.</p>
  </div>;
}

export function CommerceDesk({ data, onChange }: { data: ConsoleData; onChange: (value: ConsoleData) => void }) {
  const [state, setState] = useState<CommerceOverview | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null), [notice, setNotice] = useState(""), [review, setReview] = useState<Review | null>(null);
  const [accepted, setAccepted] = useState(false), [understood, setUnderstood] = useState(false);
  const [ledger, setLedger] = useState<"ticket" | "remedy">("ticket"), [filter, setFilter] = useState("all"), [page, setPage] = useState(0);
  const current = useRef({ data, onChange }); current.current = { data, onChange };
  const pending = useRef(false), sequence = useRef(0);
  const receive = useCallback((body: Reply) => {
    setState(body.commerce);
    if (body.show.revision > current.current.data.show.revision) current.current.onChange(body);
  }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    const number = ++sequence.current;
    const response = await fetch("/api/commerce", { cache: "no-store", ...(signal ? { signal } : {}) }); const body = await response.json();
    if (!response.ok || !body.commerce) throw new Error(body.error ?? "The saved ticket run could not be loaded.");
    if (number === sequence.current && !pending.current) receive(body);
  }, [receive]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error.message); }); return () => controller.abort(); }, [load, data.show.tenantId, data.show.revision]);
  const active = Boolean(state?.wallet && ["preparing", "approval_required", "saving"].includes(state.wallet.status) || state?.cohort?.state === "approved" || state?.remedyBatch?.state === "approved");
  useEffect(() => {
    const controller = new AbortController();
    const check = () => { if (!pending.current && document.visibilityState === "visible") void load(controller.signal).catch(() => { /* Preserve the latest observed state during a transient read failure. */ }); };
    const timer = active ? setInterval(check, 8000) : null; window.addEventListener("focus", check);
    return () => { if (timer) clearInterval(timer); window.removeEventListener("focus", check); controller.abort(); };
  }, [active, load]);
  const perform = async (request: Record<string, unknown>, message = ""): Promise<Reply | null> => {
    if (pending.current) return null; pending.current = true; ++sequence.current;
    setBusy(String(request.type)); setError(null); setNotice("");
    try {
      const response = await fetch("/api/commerce", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }); const body = await response.json();
      if (!response.ok || !body.commerce) throw new Error(body.error ?? "The original instruction could not be checked.");
      receive(body); setNotice(body.work?.status === "needs_attention" ? explanation(body.work.code) : message); return body;
    } catch (error) { setError(error instanceof Error ? error.message : "The instruction could not finish."); return null; }
    finally { pending.current = false; setBusy(null); }
  };
  const resumeWork = async () => {
    if (pending.current) return; pending.current = true; ++sequence.current; setBusy("work"); setError(null); setNotice("");
    try {
      const response = await fetch("/api/jobs", { method: "POST" }); const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "The saved work could not be resumed.");
      if (body.show.revision > current.current.data.show.revision) current.current.onChange(body);
      setNotice(body.tick.processed ? "Due instructions checked. Each result remains attached to its original ticket or capture." : "No instruction is due yet. Saved work retains its scheduled check.");
    } catch (error) { setError(error instanceof Error ? error.message : "Saved work could not be checked."); }
    finally { pending.current = false; setBusy(null); await load().catch(error => setError(error.message)); }
  };
  const open = (next: Review) => { setAccepted(false); setUnderstood(false); setError(null); setReview(next); };
  const reviewCohort = async (mode: CohortMode) => {
    const body = await perform({ type: "cohort_draft", mode, walletId: mode === "saved_wallet" ? state?.wallet?.walletId ?? null : null, expectedRevision: data.show.revision });
    if (body?.commerce.cohort) open({ type: "cohort", cohort: body.commerce.cohort, revision: body.show.revision });
  };
  const confirmReview = async () => {
    if (!review || !state) return; const cohort = state.cohort, batch = state.remedyBatch, wallet = state.wallet; let result: Reply | null = null;
    if (review.type === "wallet") result = await perform({ type: "wallet_start", idempotencyKey: crypto.randomUUID(), expectedRevision: data.show.revision, saveOnly: true }, "The original wallet-saving request is retained. No purchase is authorized.");
    if (review.type === "cohort") result = await perform({ type: "cohort_approve", cohortId: review.cohort.id, digest: review.cohort.digest, expectedRevision: review.revision, maximumMinor: 337000, maximumTickets: 80, oneControlledBuyer: true, separatePurchases: true }, "The exact 80-ticket approval is saved. Only verified captures will count toward the run.");
    if (review.type === "resume_cohort") result = await perform({ type: "cohort_resume", cohortId: review.cohort.id }, "The remaining original tickets may continue under the same approval and expiry.");
    if (review.type === "remedy") result = await perform({ type: "remedy_approve", digest: review.preview.digest, expectedRevision: review.revision, maximumMinor: 57000, perCaptureMinor: 1500, preserveAdmission: true }, "The 38 original-capture allocations are saved. Confirmed prior remedies are counted once.");
    if (review.type === "stop_cohort" && cohort) result = await perform({ type: "cohort_stop", cohortId: cohort.id }, "Unstarted purchases are stopped. An instruction already authorized for dispatch may finish.");
    if (review.type === "stop_remedy" && batch) result = await perform({ type: "remedy_stop", batchId: batch.id }, "Unstarted remedies are stopped. Existing receipts and in-flight instructions are retained.");
    if (review.type === "stop_wallet" && wallet) result = await perform({ type: "wallet_stop", setupId: wallet.id }, "This wallet is disabled for the rehearsal. Its PayPal record and any completed payments are retained.");
    if (review.type === "retry") {
      if (review.kind === "wallet" && wallet) result = await perform({ type: "wallet_retry", setupId: wallet.id });
      if (review.kind === "ticket" && cohort && review.line) result = await perform({ type: "ticket_retry", cohortId: cohort.id, ticketId: review.line.id });
      if (review.kind === "remedy" && batch && review.line) result = await perform({ type: "remedy_retry", batchId: batch.id, itemId: review.line.id });
    }
    if (result) {
      setReview(null);
      if (review.type === "wallet" && result.commerce.wallet?.approvalUrl) location.assign(result.commerce.wallet.approvalUrl);
    }
  };
  const lineAction = async (line: PublicCommerceLine, start = false) => {
    if (!state) return;
    const result = ledger === "ticket" && state.cohort
      ? await perform({ type: start ? "ticket_start" : "ticket_check", cohortId: state.cohort.id, ticketId: line.id }, "The original ticket instruction was checked.")
      : state.remedyBatch ? await perform({ type: "remedy_check", batchId: state.remedyBatch.id, itemId: line.id }, "The original capture-specific remedy was checked.") : null;
    const approval = result?.commerce.cohort?.lines.find(item => item.id === line.id)?.approvalUrl;
    if (start && approval) location.assign(approval);
  };
  const allLines = (ledger === "ticket" ? state?.cohort?.lines : state?.remedyBatch?.lines) ?? [];
  const filtered = allLines.filter(line => filter === "all" || filter === "unresolved" && (!confirmed(line) || line.lastCode === "CAPTURE_STATE_REVIEW_REQUIRED") || filter === "confirmed" && confirmed(line) || filter === line.tier);
  const pages = Math.max(1, Math.ceil(filtered.length / 10)), displayedPage = Math.min(page, pages - 1);
  const lines = filtered.slice(displayedPage * 10, (displayedPage + 1) * 10);
  const cohort = state?.cohort, wallet = state?.wallet, batch = state?.remedyBatch;
  const cohortActive = Boolean(cohort && ["approved", "paused"].includes(cohort.state));
  const staleReview = review && ("revision" in review && review.revision !== data.show.revision || review.type === "resume_cohort" && !cohortResumeReviewIsCurrent(review.cohort, cohort));
  if (!state) return <section className="commerce-loading" aria-busy={!error}><CircleDashed size={28} /><h2>Opening the ticket book.</h2><p role="status">{error ?? "Checking the saved wallet, original ticket allocations, and verified remedies…"}</p>{error && <Button onClick={() => { setError(null); void load().catch(error => setError(error.message)); }}>Check saved records again</Button>}</section>;
  return <section className="commerce-desk" aria-label="Controlled ticket cohort and remedies">
    <SectionHeading label="THE CONTROLLED TICKET RUN" title="One buyer. Eighty promises." aside={<Badge tone={cohort?.captureReviewCount ? "amber" : cohort?.state === "complete" ? "green" : "blue"}>{cohort?.captureReviewCount ? "CURRENT CAPTURE REVIEW REQUIRED" : cohort ? stateLabels[cohort.state] : "REVIEW BEFORE PURCHASE"}</Badge>} />
    <p className="commerce-intro">A single controlled sandbox buyer purchases 42 standard and 38 VIP tickets. These are 80 separate logical tickets, not 80 people or real-world attendance.</p>
    <div className="commerce-top-grid">
      <div className="commerce-run-card">
        <div className="commerce-allocation"><div><Ticket size={19} /><span className="eyebrow">STANDARD ADMISSION</span><strong>42 <small>× $35</small></strong><p>Entry to the show.</p><b>$1,470</b></div><div><Ticket size={19} /><span className="eyebrow">ADMISSION + VIP PERK</span><strong>38 <small>× $50</small></strong><p>$35 admission + $15 soundcheck visit.</p><b>$1,900</b></div></div>
        <div className="commerce-cap"><span>Maximum approved purchases<small>80 original ticket identities · USD</small></span><strong>$3,370</strong></div>
        {cohort && cohort.state !== "draft" ? <>
          <LineProgress lines={cohort.lines} total={80} label="Recorded original ticket captures" />
          <div className="commerce-run-facts"><span><b>{formatMoney(cohort.capturedMinor)}</b> captured</span><span><b>{cohort.reservedCount}</b> checkouts started</span><span><b>{cohort.unresolvedCount}</b> outcomes to review</span></div>
          <p className="commerce-expiry"><Clock3 size={14} />Charge approval ends {dateTime(cohort.expiresAt)}.</p>
          {cohort.captureReviewCount > 0 && <div className="commerce-callout"><TriangleAlert size={18} /><p>{cohort.captureReviewCount} original capture{cohort.captureReviewCount === 1 ? " is" : "s are"} retained in the gross history. Current provider review is required; {cohort.currentVerifiedCount} remain verified for readiness.</p></div>}
          {cohort.state === "paused" && <div className="commerce-callout"><TriangleAlert size={18} /><div><b>The run is paused.</b><p>{explanation(cohort.pauseCode)}</p></div></div>}
          {["revoked", "expired"].includes(cohort.state) && <p className="commerce-callout">Unstarted purchases have no current authority. Completed and in-flight instructions keep their original identities.</p>}
          <div className="commerce-actions">
            {cohort.state === "approved" && cohort.terms.mode === "saved_wallet" && <Button variant="primary" busy={busy === "work"} disabled={Boolean(busy)} onClick={() => void resumeWork()}>Resume due purchases <ArrowRight size={15} /></Button>}
            {cohort.terms.mode === "buyer_present" && cohortActive && <a className="button secondary" href="#commerce-ledger">Choose the next ticket <ArrowRight size={15} /></a>}
            <CohortResumeAction cohort={cohort} busy={Boolean(busy)} onReview={() => open({ type: "resume_cohort", cohort })} />
            {cohortActive && <Button variant="ghost" disabled={Boolean(busy)} onClick={() => open({ type: "stop_cohort" })}><Pause size={14} />Stop unstarted purchases</Button>}
          </div>
          <p className="small-text commerce-under-action">{cohort.terms.mode === "saved_wallet" ? "Approved work continues after this tab closes. A refused, uncertain, or buyer-action result pauses new tickets." : "Each ticket needs its own buyer approval in PayPal. The cohort itself never skips that step."}</p>
        </> : <div className="commerce-before-approval"><p>Saving a wallet and approving this ticket run are separate decisions. The run grants at most $3,370 for 24 hours; it can be stopped before unstarted purchases begin.</p><div className="commerce-actions">
          <Button variant="primary" disabled={Boolean(busy) || wallet?.status !== "ready"} busy={busy === "cohort_draft"} onClick={() => void reviewCohort("saved_wallet")}>Review 80-ticket run <ArrowRight size={15} /></Button>
          <Button variant="ghost" disabled={Boolean(busy)} onClick={() => void reviewCohort("buyer_present")}>Use individual PayPal approvals</Button>
        </div>{wallet?.status !== "ready" && <p className="small-text">Save and verify a wallet to use the bounded run, or approve tickets individually.</p>}</div>}
      </div>
      <aside className="commerce-wallet">
        <div className="commerce-wallet-heading"><span className="commerce-wallet-icon"><WalletCards size={25} /></span><Badge tone="blue">VENUE · PAYPAL SANDBOX</Badge></div>
        <span className="eyebrow">STEP 01 / SAVE ONLY</span><h2>A wallet is a method.<br />The approval is yours.</h2><p>Save one controlled buyer’s PayPal wallet for this rehearsal. This step charges $0 and reserves no funds.</p>
        {wallet ? <>
          <div className="commerce-wallet-state"><ShieldCheck size={18} /><div><Badge tone={wallet.status === "ready" ? "blue" : "amber"}>{walletLabels[wallet.status]}</Badge>{wallet.reference && <span className="mono">Saved method {wallet.reference}</span>}</div></div>
          {wallet.lastCode && wallet.status !== "ready" && <p className="commerce-status-message">{explanation(wallet.lastCode)}</p>}
          <div className="commerce-actions">
            {wallet.approvalUrl && <a className="button primary" href={wallet.approvalUrl}>Continue in PayPal <ArrowUpRight size={15} /></a>}
            {!["ready", "cancelled", "expired"].includes(wallet.status) && <Button disabled={Boolean(busy)} busy={busy === "wallet_check"} onClick={() => void perform({ type: "wallet_check", setupId: wallet.id }, "The original wallet request was checked.")}><RefreshCw size={14} />Check original request</Button>}
            {wallet.canRetry && <Button disabled={Boolean(busy)} onClick={() => open({ type: "retry", kind: "wallet" })}>Review refused save</Button>}
          </div>
          {wallet.status === "ready" ? <p className="small-text">Verified {dateTime(wallet.checkedAt)}. A separate, exact purchase approval is still required.</p> : <p className="small-text">Save request ends {dateTime(wallet.expiresAt)}.</p>}
          {!["cancelled", "expired"].includes(wallet.status) && <details className="commerce-wallet-options"><summary>Manage this rehearsal’s wallet</summary><p>Disabling the method here stops new local use. It keeps the PayPal saved-method record and every existing receipt.</p><Button variant="ghost" disabled={Boolean(busy)} onClick={() => open({ type: "stop_wallet" })}>{wallet.status === "ready" ? "Disable wallet here" : "Cancel this save request"}</Button></details>}
        </> : <Button variant="primary" disabled={Boolean(busy)} onClick={() => open({ type: "wallet" })}>Review wallet saving <ArrowRight size={15} /></Button>}
        <div className="commerce-wallet-foot"><LockKeyhole size={16} /><span>PayPal handles buyer approval. The saved method belongs to this production’s controlled operator.</span></div>
      </aside>
    </div>
    <section className="commerce-remedy" aria-labelledby="remedy-title">
      <div className="commerce-remedy-copy"><span className="eyebrow">STEP 03 / KEEP THE ADMISSION</span><h2 id="remedy-title">The show stays.<br />The perk is refunded.</h2><p>When the approved recovery cancels the soundcheck visit, return exactly $15 from each original VIP capture. Keep the $35 admission on every ticket.</p><div className="commerce-remedy-equation"><b>38</b><span>×</span><b>$15</b><span>=</span><b>$570</b></div><div className="commerce-remedy-principle"><Fingerprint size={17} />Every remedy belongs to one original capture.</div></div>
      <div className="commerce-remedy-work">
        <Badge tone={batch?.state === "complete" ? "green" : "amber"}>{batch ? stateLabels[batch.state] : state.remedyPreview.ready ? "READY FOR EXACT REVIEW" : "ORIGINAL CAPTURES REQUIRED"}</Badge>
        {batch ? <>
          <LineProgress lines={batch.lines} total={38} label="Verified $15 remedies" />
          <div className="commerce-run-facts"><span><b>{formatMoney(batch.refundedMinor)}</b> refunded</span><span><b>{formatMoney(batch.preservedAdmissionMinor)}</b> VIP admission retained on completed remedies</span></div>
          <p className="commerce-expiry"><Clock3 size={14} />Refund approval ends {dateTime(batch.expiresAt)}.</p>
          <div className="commerce-actions">
            {batch.state === "approved" && <Button variant="primary" busy={busy === "work"} disabled={Boolean(busy)} onClick={() => void resumeWork()}>Resume due remedies <ArrowRight size={15} /></Button>}
            <Button disabled={Boolean(busy)} onClick={() => { setLedger("remedy"); setFilter("all"); setPage(0); document.getElementById("commerce-ledger")?.scrollIntoView({ behavior: "instant", block: "start" }); }}>Review each original capture</Button>
            {batch.state === "approved" && <Button variant="ghost" disabled={Boolean(busy)} onClick={() => open({ type: "stop_remedy" })}>Stop unstarted remedies</Button>}
          </div><p className="small-text">{batch.state === "complete" ? "All thirty-eight original-capture remedies have qualifying provider receipts." : "A partial or pending batch does not clear the remedy readiness gate."}</p>
        </> : <>
          <div className="commerce-remedy-count"><strong>{state.remedyPreview.eligibleCount}</strong><span>/ 38 original VIP captures verified</span></div>
          <p>{state.remedyPreview.reason}</p>
          {state.remedyPreview.completedCount > 0 && <p>{state.remedyPreview.completedCount} prior remedies are retained. {formatMoney(state.remedyPreview.newAmountMinor)} remains to be refunded.</p>}
          <Button variant="primary" disabled={Boolean(busy) || !state.remedyPreview.ready} onClick={() => open({ type: "remedy", preview: state.remedyPreview, revision: data.show.revision })}>Review 38 exact remedies <ArrowRight size={15} /></Button>
        </>}
      </div>
    </section>
    <div className="commerce-notices" aria-live="polite">{notice && <p className="commerce-notice"><CheckCircle2 size={17} />{notice}</p>}{error && !review && <div className="commerce-error" role="alert"><TriangleAlert size={18} /><p>{error}</p><Button disabled={Boolean(busy)} onClick={() => { setError(null); void load().catch(error => setError(error.message)); }}>Refresh saved records</Button></div>}</div>
    {allLines.length > 0 && <section className="commerce-ledger" id="commerce-ledger" aria-labelledby="commerce-ledger-title">
      <SectionHeading label="ORIGINAL INSTRUCTIONS / CURRENT OUTCOMES" title="A traceable place for every ticket." />
      <div className="commerce-ledger-toolbar"><div className="commerce-ledger-switch"><button type="button" aria-pressed={ledger === "ticket"} onClick={() => { setLedger("ticket"); setFilter("all"); setPage(0); }}>Purchases <span>{cohort?.lines.length ?? 0}</span></button><button type="button" aria-pressed={ledger === "remedy"} disabled={!batch} onClick={() => { setLedger("remedy"); setFilter("all"); setPage(0); }}>Remedies <span>{batch?.lines.length ?? 0}</span></button></div><label>Show<select value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }}><option value="all">Every instruction</option><option value="unresolved">Unresolved</option><option value="confirmed">Confirmed receipts</option>{ledger === "ticket" && <><option value="standard">Standard admission</option><option value="vip">VIP admission + perk</option></>}</select></label></div>
      <h3 id="commerce-ledger-title" className="sr-only">{ledger === "ticket" ? "Ticket purchases" : "Original capture remedies"}</h3>
      {lines.length ? <ol className="commerce-lines" start={displayedPage * 10 + 1}>{lines.map(line => <li key={line.id}>
        <span className={"commerce-line-number " + (confirmed(line) ? "done" : "")}>{confirmed(line) ? <Check size={17} /> : String(line.ordinal).padStart(2, "0")}</span>
        <div className="commerce-line-detail"><strong>{ledger === "remedy" ? "VIP perk remedy" : line.tier === "vip" ? "VIP admission + soundcheck" : "Standard admission"}<span>{formatMoney(line.amountMinor)}</span></strong><p>{line.captureReference ? "Original capture " + line.captureReference : ledger === "ticket" ? "Ticket " + String(line.ordinal).padStart(2, "0") + " of 80 · original allocation retained" : "Original capture check pending"}{line.refundReference ? " · refund " + line.refundReference : ""}</p>{line.lastCode && <p className="commerce-line-reason">{explanation(line.lastCode)}</p>}</div>
        <Badge tone={line.lastCode === "CAPTURE_STATE_REVIEW_REQUIRED" ? "amber" : confirmed(line) ? "green" : ["pending", "refused", "needs_attention", "approval_required"].includes(line.state) ? "amber" : "muted"}>{line.lastCode === "CAPTURE_STATE_REVIEW_REQUIRED" ? "Capture recorded · review" : lineLabels[line.state]}</Badge>
        <div className="commerce-line-actions">
          {line.approvalUrl && <a className="button secondary" href={line.approvalUrl}>Open PayPal <ArrowUpRight size={13} /></a>}
          {ledger === "ticket" && cohort?.terms.mode === "buyer_present" && cohort.state === "approved" && !line.intentId && <Button ariaLabel={`Approve ${formatMoney(line.amountMinor)} for ticket ${line.ordinal} of 80`} disabled={Boolean(busy)} onClick={() => void lineAction(line, true)}>Approve {formatMoney(line.amountMinor)}</Button>}
          {line.intentId && (!confirmed(line) || line.lastCode === "CAPTURE_STATE_REVIEW_REQUIRED") && <Button ariaLabel={`Check original ${ledger === "ticket" ? "ticket" : "remedy"} ${line.ordinal}`} disabled={Boolean(busy)} onClick={() => void lineAction(line)}><RefreshCw size={13} />Check original</Button>}
          {line.state === "refused" && <Button ariaLabel={`Review retry for ${ledger === "ticket" ? "ticket" : "remedy"} ${line.ordinal}`} disabled={Boolean(busy)} onClick={() => open({ type: "retry", kind: ledger, line })}>Review retry</Button>}
        </div>
      </li>)}</ol> : <p className="commerce-no-lines">No instructions match this view. Every original record remains saved.</p>}
      <div className="commerce-pagination"><span>{filtered.length ? (displayedPage * 10 + 1) + "–" + Math.min((displayedPage + 1) * 10, filtered.length) + " of " + filtered.length : "0"} {ledger === "ticket" ? "tickets" : "remedies"}</span><div><Button disabled={displayedPage === 0} onClick={() => setPage(displayedPage - 1)}><ChevronLeft size={16} />Previous</Button><Button disabled={displayedPage + 1 >= pages} onClick={() => setPage(displayedPage + 1)}>Next <ChevronRight size={16} /></Button></div></div>
    </section>}
    {review && <Modal title={review.type === "wallet" ? "Save the method. Keep the decision." : review.type === "cohort" ? "Review the exact 80-ticket approval." : review.type === "resume_cohort" ? "Review the paused ticket run." : review.type === "remedy" ? "Thirty-eight precise remedies." : review.type === "retry" ? "Review the original refused instruction." : review.type === "stop_wallet" ? "Disable this rehearsal’s wallet?" : review.type === "stop_cohort" ? "Stop unstarted purchases?" : "Stop unstarted remedies?"} onClose={() => { if (!busy) setReview(null); }}>
      <div className="commerce-review"><Badge tone="blue">CONTROLLED PAYPAL SANDBOX</Badge>
        {review.type === "wallet" && <><div className="commerce-review-amount"><span>Amount charged by saving</span><strong>$0</strong></div><p>PayPal will ask the controlled buyer to save a method for the venue. Saving does not reserve money or approve the 80-ticket run.</p><p>After PayPal confirms the saved method, review a separate purchase approval with the exact ticket count, $3,370 ceiling, 24-hour expiry, and stop control.</p><label className="commerce-consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} /><span>I control this sandbox buyer and approve saving this method only.</span></label></>}
        {review.type === "cohort" && <><div className="commerce-review-amount"><span>Maximum across 80 separate purchases</span><strong>$3,370</strong></div><dl className="commerce-review-terms"><div><dt>Standard admission</dt><dd>42 × $35 = $1,470</dd></div><div><dt>VIP admission + perk</dt><dd>38 × $50 = $1,900</dd></div><div><dt>Merchant</dt><dd>Venue sandbox account</dd></div><div><dt>Payment method</dt><dd>{review.cohort.terms.mode === "saved_wallet" ? "Verified saved PayPal wallet" : "Individual PayPal approval per ticket"}</dd></div><div><dt>Charge window</dt><dd>24 hours after this approval</dd></div><div><dt>Each VIP ticket</dt><dd>$35 admission + $15 perk</dd></div></dl><p>{review.cohort.terms.mode === "saved_wallet" ? "The venue may start these separate ticket purchases with this saved method, up to the exact total and count. Each request verifies the current approval before dispatch." : "This records the fixed ticket allocation. Every purchase still requires its own buyer approval in PayPal."}</p><p>You can stop unstarted instructions. A request already authorized immediately before the stop may finish. An unknown result keeps its original ticket; it is never replaced by another charge.</p><label className="commerce-consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} /><span>I control this one sandbox buyer. These 80 logical tickets do not represent 80 independent people.</span></label><label className="commerce-consent"><input type="checkbox" checked={understood} onChange={event => setUnderstood(event.target.checked)} /><span>I approve at most 42 × $35 and 38 × $50, totaling $3,370 USD, under these exact limits.</span></label></>}
        {review.type === "resume_cohort" && <CohortResumeSummary cohort={review.cohort} accepted={accepted} onAccepted={setAccepted} />}
        {review.type === "remedy" && <><div className="commerce-review-amount"><span>New refunds still to send</span><strong>{formatMoney(review.preview.newAmountMinor)}</strong></div><dl className="commerce-review-terms"><div><dt>Original allocation</dt><dd>38 × $15 = $570</dd></div><div><dt>Already confirmed</dt><dd>{review.preview.completedCount} remedies · {formatMoney(review.preview.completedCount * 1500)}</dd></div><div><dt>Admission kept per VIP ticket</dt><dd>$35</dd></div><div><dt>Approved recovery</dt><dd>Plan v{review.preview.planVersion}</dd></div><div><dt>Refund window</dt><dd>24 hours after this approval</dd></div></dl><p>Every refund uses its own original $50 VIP capture. Prior confirmed remedies are counted once. Uncertain or pending results stay unresolved.</p><details className="commerce-capture-review"><summary>Review all 38 original capture references</summary><ol>{review.preview.captureReferences.map((reference, index) => <li key={index}><span>{String(index + 1).padStart(2, "0")}</span><b className="mono">{reference}</b><span>$15</span></li>)}</ol></details><label className="commerce-consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} /><span>I approve exactly $15 per original VIP capture, no more than $570 in total, retaining each $35 admission.</span></label></>}
        {review.type === "retry" && <><p>The provider must have refused the request, or the request must be proved not sent. Retrying keeps the same original instruction and its unchanged amount.</p>{review.line && <div className="commerce-review-amount"><span>{review.kind === "ticket" ? "Original ticket purchase" : "Original capture remedy"}</span><strong>{formatMoney(review.line.amountMinor)}</strong></div>}<p>An unknown result cannot be retried as a new payment. Current ownership, consent, and available amounts are checked again.</p><label className="commerce-consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} /><span>I have reviewed the original refusal and approve this same instruction being retried.</span></label></>}
        {review.type.startsWith("stop_") && <><p>{review.type === "stop_wallet" ? "This disables the method for this rehearsal. No new local purchase may use it. The saved method remains in PayPal, and any completed payments remain recorded." : "Unstarted instructions will stop. Completed receipts remain intact, and any instruction already authorized immediately before this stop may still finish."}</p><p>This action does not reverse completed payments or erase an unknown outcome.</p></>}
        {staleReview && <p className="commerce-error" role="alert">The production changed while this review was open. Close this review and inspect the current terms again.</p>}
        {error && <p className="commerce-error" role="alert">{error}</p>}
        <div className="modal-actions"><Button disabled={Boolean(busy)} onClick={() => setReview(null)}>Keep reviewing</Button><Button variant="primary" busy={Boolean(busy)} disabled={Boolean(busy) || Boolean(staleReview) || !review.type.startsWith("stop_") && (!accepted || review.type === "cohort" && !understood)} onClick={() => void confirmReview()}>{review.type === "wallet" ? "Save only · continue to PayPal" : review.type === "cohort" ? review.cohort.terms.mode === "saved_wallet" ? "Approve up to $3,370" : "Approve individual-checkout cohort" : review.type === "resume_cohort" ? "Check and resume remaining tickets" : review.type === "remedy" ? "Approve " + formatMoney(review.preview.newAmountMinor) + " remaining" : review.type === "retry" ? "Retry the same instruction" : review.type === "stop_wallet" ? "Disable here" : "Stop unstarted work"}<ArrowRight size={14} /></Button></div>
      </div>
    </Modal>}
  </section>;
}
