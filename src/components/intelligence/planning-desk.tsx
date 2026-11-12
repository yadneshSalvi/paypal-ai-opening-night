"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, FileCheck2, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import type { ConsoleData } from "@/domain/contracts";
import { intelligenceDependencyDelta, intelligenceReviewDelta, intelligenceToolLabels, type IntelligenceConversation, type IntelligenceProposal, type IntelligenceRunView, type IntelligenceToolResult, type IntelligenceWorkspace } from "@/domain/intelligence";
import { formatMoney, localTime } from "@/domain/time";
import { ProductionCanvas, type CanvasProps } from "../production-canvas";
import { productionFetch } from "../production-fetch";
import { Badge, Button, Modal } from "../ui";
import { VoiceRecord } from "./voice-record";
import { clearExactPlanningRequest, planningRequestKey, readPlanningInstruction, retryPlanningInstruction, type RetainedPlanningInstruction } from "./planning-dispatch";
import { PlanningMessage } from "./planning-message";

export function PlanningDesk({ data, onData, canvas }: { data: ConsoleData; onData: (data: ConsoleData) => void; canvas: CanvasProps }) {
  const tenantId = data.show.tenantId;
  const [workspace, setWorkspace] = useState<IntelligenceWorkspace | null>(null), [initial, setInitial] = useState<IntelligenceConversation | null>(null);
  const [runs, setRuns] = useState<IntelligenceRunView[]>([]), [receipts, setReceipts] = useState<IntelligenceToolResult[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [generation, setGeneration] = useState(0), [busy, setBusy] = useState<string | null>(null);
  const [reviewCommandId, setReviewCommandId] = useState<string | null>(null);
  const [heldRequestId, setHeldRequestId] = useState<string | null>(null);
  const [missingInstruction, setMissingInstruction] = useState<RetainedPlanningInstruction | null>(null);
  const [voiceRefresh, setVoiceRefresh] = useState(0);
  const onVoiceSaved = useCallback(() => setVoiceRefresh(value => value + 1), []);
  const onInstructionHeld = useCallback((requestId: string) => { setHeldRequestId(requestId); setMissingInstruction(null); }, []);
  const [review, setReview] = useState<IntelligenceProposal | null>(null), [consent, setConsent] = useState(false);
  const load = useCallback(async (conversationId?: string) => {
    setMissingInstruction(null);
    const response = await productionFetch(tenantId, "/api/intelligence", { cache: "no-store" }), payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "The saved decision record could not open.");
    const desk = payload as IntelligenceWorkspace; setWorkspace(desk);
    const selected = conversationId ?? desk.conversations[0]?.id;
    if (selected) {
      const saved = await productionFetch(tenantId, `/api/intelligence?conversationId=${selected}`, { cache: "no-store" }), conversation = await saved.json();
      if (!saved.ok) throw new Error(conversation.error ?? "The saved conversation could not open.");
      setInitial(conversation); setRuns(conversation.runs); setReceipts(conversation.receipts.map((row: IntelligenceConversation["receipts"][number]) => row.result));
      const key = `opening-night-planning:${tenantId}:${selected}`, held = sessionStorage.getItem(key);
      const exactTerminal = held && (conversation as IntelligenceConversation).runs.some(run => run.requestId === held && !["dispatching", "running", "indeterminate"].includes(run.state));
      if (exactTerminal) clearExactPlanningRequest(key, held!);
      setHeldRequestId(exactTerminal ? null : held);
    } else { setInitial(null); setRuns([]); setReceipts([]); const draft = sessionStorage.getItem(`opening-night-draft-conversation:${tenantId}`); setHeldRequestId(draft ? sessionStorage.getItem(`opening-night-planning:${tenantId}:${draft}`) : null); }
    setGeneration(value => value + 1);
  }, [tenantId]);
  useEffect(() => { let cancelled = false; setLoading(true); void load().catch(error => { if (!cancelled) setError(error.message); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [load]);
  const onRun = useCallback((run: IntelligenceRunView) => { setRuns(previous => [...previous.filter(item => item.id !== run.id), run].sort((a, b) => a.sequence - b.sequence)); }, []);
  const onTool = useCallback((result: IntelligenceToolResult) => {
    setReceipts(previous => [...previous.filter(item => item.evidenceId !== result.evidenceId), result]);
    if (result.name === "proposeRecovery" && result.ok) {
      const proposal = (result.data as { proposal: IntelligenceProposal }).proposal;
      setWorkspace(previous => previous ? { ...previous, proposals: [proposal, ...previous.proposals.filter(item => item.id !== proposal.id)] } : previous);
    }
  }, []);
  const startSeparateConversation = () => {
    const original = initial?.id ?? sessionStorage.getItem(`opening-night-draft-conversation:${tenantId}`), held = original ? sessionStorage.getItem(`opening-night-planning:${tenantId}:${original}`) : null;
    if (held) { setHeldRequestId(held); setError("The original request outcome is still unresolved. Read that exact identity before starting separate work."); return; }
    sessionStorage.setItem(`opening-night-draft-conversation:${tenantId}`, crypto.randomUUID());
    setInitial(null); setRuns([]); setReceipts([]); setError(null); setGeneration(value => value + 1);
  };
  async function readOriginalRequest() {
    if (!heldRequestId) return;
    setBusy("original-request"); setError(null); setMissingInstruction(null);
    try {
      const response = await productionFetch(tenantId, `/api/intelligence?requestId=${heldRequestId}`, { cache: "no-store" }), value = await response.json();
      if (!response.ok) {
        if (response.status === 404) {
          const conversationId = initial?.id ?? sessionStorage.getItem(`opening-night-draft-conversation:${tenantId}`);
          const saved = conversationId ? readPlanningInstruction(planningRequestKey(tenantId, conversationId)) : null;
          if (saved?.command.requestId === heldRequestId) setMissingInstruction(saved);
          throw new Error("No original result was found for this access. The instruction remains held; no replacement was sent.");
        }
        throw new Error(value.error ?? "The original result is temporarily unavailable.");
      }
      if ((value as IntelligenceRunView).requestId !== heldRequestId) throw new Error("The returned result does not match the retained instruction.");
      await load((value as IntelligenceRunView).conversationId);
    } catch (error) { setError(error instanceof Error ? error.message : "The original result could not be read."); }
    finally { setBusy(null); }
  }
  async function retryOriginalInstruction() {
    if (!missingInstruction) return;
    setBusy("original-retry"); setError(null);
    try {
      const response = await productionFetch(tenantId, "/api/intelligence", { cache: "no-store" }), current = await response.json() as IntelligenceWorkspace & { error?: string };
      if (!response.ok || !current.sessionExpiresAt || !current.sessionAccessId) throw new Error(current.error ?? "The original current access could not be verified.");
      const run = await retryPlanningInstruction({ tenantId, sessionExpiresAt: current.sessionExpiresAt, sessionAccessId: current.sessionAccessId }, missingInstruction);
      await load(run.conversationId);
    } catch (error) { setError(error instanceof Error ? error.message : "The original instruction remains held."); }
    finally { setBusy(null); }
  }
  async function recover(run: IntelligenceRunView) {
    setBusy(run.id); setError(null);
    try {
      const response = await productionFetch(tenantId, `/api/intelligence?runId=${run.id}`, { cache: "no-store" }), current = await response.json();
      if (!response.ok) throw new Error(current.error ?? "The saved response could not be read.");
      for (const call of (current as IntelligenceRunView).result?.choices[0].message.tool_calls ?? []) {
        const result = await productionFetch(tenantId, "/api/intelligence/tools", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: run.id, callId: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) }) });
        const body = await result.json(); if (!result.ok) throw new Error(body.error ?? "The saved step could not be recovered.");
      }
      await load(run.conversationId);
    } catch (error) { setError(error instanceof Error ? error.message : "The saved response could not be recovered."); } finally { setBusy(null); }
  }
  const pending = Boolean(heldRequestId) || runs.some(run => ["running", "dispatching", "indeterminate"].includes(run.state));
  const last = runs.at(-1), lastCheck = [...receipts].reverse().find(receipt => receipt.name === "checkAssignment" && receipt.ok);
  const lastNeedsRecovery = last && (["dispatching", "running"].includes(last.state) || (last.state === "completed" && Boolean(last.result?.choices[0].message.tool_calls?.length)));
  const checked = lastCheck?.data as { taskName: string; allowedByQualification: boolean; issues: { message: string; sourceId: string }[]; qualifiedAlternatives: { name: string }[] } | undefined;
  return <>
    <div className="intelligence-heading"><div className="intelligence-mark"><Sparkles size={22} /></div><div><span className="eyebrow">THE PRODUCTION DESK</span><h2>Find the next safe move.</h2><p>Ask about a crew assignment. Compare the alternatives. Review the exact change.</p></div><Badge tone={workspace?.providerAvailable ? "blue" : "muted"}>{workspace?.providerMode === "controlled_fixture" ? "CONTROLLED AI INPUTS" : workspace?.providerAvailable ? "AI PLANNING" : "SAVED PLANNING"}</Badge></div>
    {loading ? <div className="intelligence-status" role="status">Restoring your private planning record…</div> : error && !workspace ? <div className="intelligence-status"><p role="alert">{error}</p><Button onClick={() => { setError(null); void load().catch(error => setError(error.message)); }}>Restore planning record</Button></div> : <div className="intelligence-guidance"><ShieldCheck size={16} /><span>The plan moves only after your review. Crew sign-offs, commercial approvals and cues stay with their assigned people.</span></div>}
    {workspace?.providerMode === "controlled_fixture" && <p className="intelligence-status">Controlled response fixtures exercise the native planning flow. No model or payment provider is called.</p>}
    {workspace && <div className="intelligence-conversation-controls"><label>Saved conversation<select aria-label="Saved planning conversation" disabled={loading || Boolean(busy)} value={initial?.id ?? ""} onChange={event => { const id = event.target.value; if (!id) return; setBusy("history"); setError(null); void load(id).catch(error => setError(error.message)).finally(() => setBusy(null)); }}><option value="" disabled>New conversation</option>{workspace.conversations.map(conversation => <option key={conversation.id} value={conversation.id}>{new Date(conversation.createdAt).toLocaleString()} · {conversation.id.slice(0, 8)}</option>)}</select></label><Button disabled={loading || Boolean(busy) || pending} onClick={startSeparateConversation}>Start a separate conversation</Button></div>}
    {initial?.canContinue === false && <p className="intelligence-status" role="status">{initial.continuationMessage}</p>}
    {heldRequestId && <div className="intelligence-status" role="status"><span>An original request still needs its saved result. Its identity is retained.</span><Button disabled={Boolean(busy)} busy={busy === "original-request"} onClick={() => void readOriginalRequest()}>Read original request</Button></div>}
    {missingInstruction && <div className="intelligence-retry-review"><h3>Review the original instruction.</h3><p className="intelligence-retained-prompt">{missingInstruction.command.prompt ?? "Continue from the exact saved tool outcome in this conversation."}</p><p>The original lookup found no saved request. A retry checks again and uses the same identity, content and original access. Current production sources will be checked when this instruction reaches the server.</p><small>Original access ends {new Date(missingInstruction.sessionExpiresAt).toLocaleString()}.</small><Button disabled={Boolean(busy) || !workspace?.sessionExpiresAt || workspace.sessionExpiresAt !== missingInstruction.sessionExpiresAt || workspace.sessionAccessId !== missingInstruction.sessionAccessId} busy={busy === "original-retry"} onClick={() => void retryOriginalInstruction()}>Retry this exact instruction</Button></div>}
    <ProductionCanvas key={`${generation}:${data.show.revision}`} {...canvas} {...(!loading && workspace?.sessionExpiresAt && workspace?.sessionAccessId && initial?.canContinue !== false ? { assistant: { tenantId, initial, sessionExpiresAt: workspace.sessionExpiresAt, sessionAccessId: workspace.sessionAccessId, onRun, onTool, onVoiceSaved, onInstructionHeld } } : {})} />
    <VoiceRecord tenantId={tenantId} refresh={voiceRefresh} />
    <section className="intelligence-record" aria-label="Saved planning decisions">
      <div className="intelligence-record-heading"><div><span className="eyebrow">DECISION RECORD</span><h3>{checked && !checked.allowedByQualification ? "A fast fix still needs the right skills." : "Every proposal keeps its evidence."}</h3></div><Button disabled={Boolean(busy) || pending} onClick={() => { setBusy("restore"); setError(null); void load(last?.conversationId).catch(error => setError(error.message)).finally(() => setBusy(null)); }}><RefreshCw size={14} />Restore saved conversation</Button></div>
      {checked && <div className={`intelligence-check ${checked.allowedByQualification ? "passed" : "rejected"}`}><ShieldCheck size={22} /><div><b>{checked.allowedByQualification ? "Qualification checked" : "Assignment rejected"} · {checked.taskName}</b>{checked.issues.map((issue, index) => <p key={index}>{issue.message} <a href="/evidence">{issue.sourceId}</a></p>)}{!checked.allowedByQualification && <p>Qualified alternative: {checked.qualifiedAlternatives.map(person => person.name).join(", ") || "No verified qualification on the roster"}.</p>}<small>No assignment changed.</small></div></div>}
      {error && workspace && <p className="error-note" role="alert">{error}</p>}
      {last && <div className="intelligence-run-status" role="status"><span className={`tiny-dot ${last.state === "completed" ? "green" : "amber"}`} /><span>{last.message}</span>{lastNeedsRecovery && <Button disabled={Boolean(busy)} busy={busy === last.id} onClick={() => void recover(last)}>Recover this saved step</Button>}</div>}
      {workspace && !workspace.providerAvailable && <p className="intelligence-muted">This environment has no connected planning model. Saved decisions and manual recovery controls remain available.</p>}
      <div className="intelligence-proposals">{workspace?.proposals.map(proposal => {
        const current = proposal.baseRevision === data.show.revision, allowed = ["feasible", "feasible_with_approval"].includes(proposal.candidate.report.status) && proposal.candidate.report.engine?.status === "passed";
        return <article key={proposal.id}><div className="intelligence-proposal-top"><Badge tone={proposal.state === "reviewed" ? "green" : allowed ? "blue" : "amber"}>{proposal.state === "reviewed" ? "REVIEWED" : allowed ? "READY FOR REVIEW" : "CONSTRAINTS UNRESOLVED"}</Badge><span className="mono">r{proposal.baseRevision}</span></div><h3>{proposal.candidate.name.replace(/^(?:Reviewed|AI) alternative · /, "")}</h3><p>{proposal.candidate.summary}</p><dl><div><dt>Doors</dt><dd>{localTime(proposal.candidate.patch.doorsAt)} CST</dd></div><div><dt>Modeled exposure</dt><dd>{formatMoney(proposal.candidate.cost.totalMinor)}</dd></div></dl>{proposal.candidate.report.issues.slice(0, 3).map((issue, index) => <p className="intelligence-issue" key={index}>{issue.message}</p>)}<footer>{proposal.state === "reviewed" ? <Link href="/recovery">Open the recovery workbench <ArrowRight size={15} /></Link> : <Button variant="primary" disabled={!current || !allowed || Boolean(busy)} onClick={() => { setReview(proposal); setConsent(false); setReviewCommandId(crypto.randomUUID()); }}>{current ? "Review this alternative" : "Historical proposal"}<ArrowRight size={15} /></Button>}<small>{proposal.state === "reviewed" ? "Plan approval is separate." : "Active calls remain unchanged."}</small></footer></article>;
      })}</div>
      {runs.length > 0 && <details className="intelligence-history"><summary>{runs.length} saved responses · {receipts.length} verified steps</summary>{runs.map(run => <div key={run.id}><span className="mono">{String(run.sequence).padStart(2, "0")}</span><div><b>{run.state.replaceAll("_", " ")}{run.provenance === "controlled_fixture" ? " · controlled response" : ""}</b><PlanningMessage text={run.result?.choices[0].message.content ?? run.result?.choices[0].message.tool_calls?.map(call => intelligenceToolLabels[call.function.name]).join(", ") ?? run.message} /><small>Production r{run.revision} · {new Date(run.createdAt).toLocaleString()}</small></div></div>)}</details>}
    </section>
    {review && <Modal title="Review the alternative. Keep the authority." onClose={() => { if (!busy) setReview(null); }}><div className="intelligence-review"><FileCheck2 size={30} /><h3>{review.candidate.name.replace(/^(?:Reviewed|AI) alternative · /, "")}</h3><p>{review.candidate.summary}</p><dl><div><dt>Source production</dt><dd>Revision {review.baseRevision}</dd></div><div><dt>Native engine</dt><dd>{review.candidate.report.engine?.status}</dd></div><div><dt>Doors</dt><dd>{localTime(review.candidate.patch.doorsAt)} CST</dd></div><div><dt>Modeled exposure</dt><dd>{formatMoney(review.candidate.cost.totalMinor)}</dd></div></dl><p>Modeled rental {formatMoney(review.candidate.cost.rentalMinor)} · overtime {formatMoney(review.candidate.cost.overtimeMinor)} · VIP remedy {formatMoney(review.candidate.cost.remedyMinor)}. Separate damage authorization: {formatMoney(data.show.offers.find(offer => offer.id === review.candidate.patch.offerId)?.depositMinor ?? 0)}. These are proposed amounts, not executed payments.</p><h4>Proposed call changes</h4><ul>{intelligenceReviewDelta(data.show, review.candidate).map(change => { const task = change.after ?? change.before!; return <li key={task.id}><b>{task.name} <Badge tone={change.kind === "removed" ? "amber" : "blue"}>{change.kind.toUpperCase()}</Badge></b>{change.before && <span>Before: {localTime(change.before.start)}–{localTime(change.before.end)} · {change.before.resources.map(id => data.show.resources.find(person => person.id === id)?.name ?? id).join(", ") || "Milestone"}</span>}{change.after ? <span>Proposed: {localTime(change.after.start)}–{localTime(change.after.end)} · {change.after.resources.map(id => data.show.resources.find(person => person.id === id)?.name ?? id).join(", ") || "Milestone"}</span> : <span>This call would be canceled. No cancellation or refund has been executed.</span>}</li>; })}</ul><details className="intelligence-review-source"><summary>Review dependency changes</summary><ul>{(["removed", "added"] as const).flatMap(kind => intelligenceDependencyDelta(data.show, review.candidate)[kind].map(edge => <li key={`${kind}:${edge.id}`}><b>{kind === "added" ? "Add" : "Remove"}: {[edge.from, edge.to].map(id => review.candidate.patch.tasks.find(task => task.id === id)?.name ?? data.show.tasks.find(task => task.id === id)?.name ?? id).join(" → ")}</b><span>{edge.financial ? "Requires verified financial evidence" : "Operational dependency"} · lag {edge.lagMinutes} minutes</span></li>))}</ul></details><div className="intelligence-required-approvals"><h4>Still requires separate approval</h4>{review.candidate.approvals.map(item => <p key={item.id}>{item.label} · {item.role.replaceAll("_", " ")}</p>)}<p>{review.candidate.patch.canceledPerk ? "The proposed VIP perk cancellation requires its own exact-capture remedy." : "No VIP perk cancellation is proposed."}</p></div><details className="intelligence-review-source"><summary>Source and exact proposal identity</summary><p>Current production revision {review.baseRevision}; all hard constraints are rechecked when this review is saved.</p><p>Source SHA-256 <code>{review.sourceDigest}</code></p><p>Proposal SHA-256 <code>{review.digest}</code></p></details><label className="check-label"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />I reviewed this exact alternative and its constraints. Add it to the recovery workbench for separate plan approval.</label><div className="modal-actions"><Button disabled={Boolean(busy)} onClick={() => setReview(null)}>Back</Button><Button variant="primary" disabled={!consent || Boolean(busy) || review.baseRevision !== data.show.revision} busy={busy === "review"} onClick={async () => {
      setBusy("review"); setError(null);
      try { const response = await productionFetch(tenantId, "/api/intelligence/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proposalId: review.id, proposalDigest: review.digest, expectedRevision: data.show.revision, commandId: reviewCommandId, reviewed: true }) }); const payload = await response.json(); if (!response.ok) { if (["STALE_REVISION", "PROPOSAL_SOURCE_CHANGED"].includes(payload.code)) { const current = await productionFetch(tenantId, "/api/show", { cache: "no-store" }); if (current.ok) onData(await current.json()); } throw new Error(payload.error); } onData(payload); setReview(null); await load(last?.conversationId); }
      catch (error) { setError(error instanceof Error ? error.message : "This alternative could not be reviewed."); } finally { setBusy(null); }
    }}>Add reviewed alternative <Check size={16} /></Button></div>{error && <p className="error-note" role="alert">{error}</p>}</div></Modal>}
  </>;
}
