"use client";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpRight, Check, ChevronDown, ChevronUp, Compass, LoaderCircle, RotateCcw } from "lucide-react";
import type { JudgeBeat, JudgeBeatId, JudgeCrewLink, JudgeProvenance, JudgeView } from "@/domain/judge/contracts";
import { Button } from "../ui";
import { announceRehearsal } from "../production-fetch";
import { JUDGE_COLLAPSED_STORAGE, JUDGE_REFRESH_EVENT, JudgeRequestError, TOUR_DESCRIPTION, beatFingerprint, beatProgress, errorText, pathOf, postJudge, readJudge, safeHttpUrl, safeQrSvg, sessionEnded } from "./judge-client";

type Source = "initial" | "retry" | "poll" | "sync" | "advance";
type Busy = "advance" | "start" | "reset" | null;
type OpenWindow = (url: string, name: string, features: string) => unknown;
const MAX_CHUNKS = 60;
const CONTROLLED_WINDOW = "opening-night-controlled-device";
const provenance: Record<JudgeProvenance, { label: string; meaning: string }> = {
  live: { label: "LIVE", meaning: "Computed or executed now by the application, the scheduling engine or the model." },
  replay: { label: "REPLAY", meaning: "A replayed, controlled payment outcome. No PayPal request was made." },
  controlled: { label: "CONTROLLED", meaning: "A controlled fixture client or declaration, not a real person or a physical act." },
  judge: { label: "YOU", meaning: "Performed by you in this private rehearsal." },
};
const fullLoad = (url: string) => location.assign(url);
const browserOpen: OpenWindow = (url, name, features) => window.open(url, name, features);
const consolePath = (view: string | undefined) => view === undefined ? null : view === "show" ? "/" : `/${view}`;

function ProvenanceBadge({ kind }: { kind: JudgeProvenance }) {
  const item = provenance[kind] ?? provenance.controlled;
  return <span className={`judge-provenance ${kind}`} title={item.meaning}>{item.label}<span className="sr-only">: {item.meaning}</span></span>;
}

/** `cue` is the GO beat: the same two crew clients issue DOORS GO and HOUSE OPEN through their own duties. */
function CrewLinkCard({ link, serverAt, openWindow, mode }: { link: JudgeCrewLink; serverAt: string; openWindow: OpenWindow; mode: "acknowledge" | "cue" }) {
  const [blocked, setBlocked] = useState(false);
  const url = safeHttpUrl(link.url), ended = Date.parse(link.expiresAt) <= Date.parse(serverAt);
  const status = <p className={`judge-crew-status ${link.acknowledged ? "done" : ""}`} role="status">{link.acknowledged ? <Check size={14} aria-hidden="true" /> : <span className="tiny-dot amber" aria-hidden="true" />}{link.acknowledged ? `Acknowledged as ${link.personName}` : ended ? "This link has ended. Restart the tour for a current one." : "Waiting for the acknowledgment"}</p>;
  if (link.kind === "judge_phone") {
    const qr = safeQrSvg(link.qrSvg);
    return <article className="judge-crew-card phone" data-kind="judge_phone">
      <header><ProvenanceBadge kind="judge" /><div><strong>{link.personName}</strong><span>{link.role}</span></div></header>
      {qr ? <div className="judge-qr" role="img" aria-label={`QR code that opens the run sheet for ${link.personName}`} dangerouslySetInnerHTML={{ __html: qr }} /> : <p className="judge-note">The QR code could not be drawn. Use the link below.</p>}
      <p className="judge-crew-copy">{mode === "cue" ? `Scan with your own phone to open the crew client as ${link.personName}. You are standing in for this fictional crew member in your private rehearsal; the cue is real and issued by you.` : `Scan with your own phone to acknowledge the run sheet as ${link.personName}. You are standing in for this fictional crew member in your private rehearsal; the acknowledgment is real and made by you.`}</p>
      {url && !ended && <a className="judge-text-link" href={url} target="_blank" rel="noreferrer">Open on this device instead <ArrowUpRight size={13} aria-hidden="true" /><span className="sr-only"> (opens a new tab)</span></a>}
      {status}
    </article>;
  }
  const open = () => { if (url) setBlocked(!openWindow(url, CONTROLLED_WINDOW, "popup,width=390,height=844")); };
  return <article className="judge-crew-card controlled" data-kind="controlled_device">
    <header><ProvenanceBadge kind="controlled" /><div><strong>{link.personName}</strong><span>{link.role}</span></div></header>
    <p className="judge-controlled-label">CONTROLLED DEVICE - phone-sized window on this computer, not a physical phone</p>
    {url && !ended && <Button onClick={open}>{mode === "acknowledge" && !link.acknowledged ? "Acknowledge on the controlled device" : "Open the controlled device"}</Button>}
    {blocked && url && <p className="judge-note" role="alert">The browser blocked the window. <a className="judge-text-link" href={url} target="_blank" rel="noreferrer">Open the controlled device in a new tab</a></p>}
    {status}
  </article>;
}

/**
 * Docked guide for a guided demonstration. For an ordinary rehearsal it is
 * only a small pill that explains the tour and offers to start one. It never
 * issues GO or HOUSE OPEN: those stay on the normal command path.
 */
export function JudgeGuide({ tenantId, view: consoleView, revision, hidden = false, navigate = fullLoad, openWindow = browserOpen, pollMs = 2500 }: { tenantId: string; view?: string; revision?: number; hidden?: boolean; navigate?: (url: string) => void; openWindow?: OpenWindow; pollMs?: number }) {
  const [judge, setJudge] = useState<JudgeView | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "ended">("loading");
  const [loadError, setLoadError] = useState<string | null>(null), [actionError, setActionError] = useState<string | null>(null), [connectionLost, setConnectionLost] = useState(false);
  const [stored, setStored] = useState<boolean | null>(null), [offerOpen, setOfferOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null), [confirmReset, setConfirmReset] = useState(false), [peek, setPeek] = useState<JudgeBeatId | null>(null);
  const judgeRef = useRef<JudgeView | null>(null), revisionRef = useRef(revision); revisionRef.current = revision;
  const lock = useRef(false), reading = useRef(false), epoch = useRef(0), mounted = useRef(true), pendingKey = useRef<{ beatId: JudgeBeatId; key: string } | null>(null);
  const pill = useRef<HTMLButtonElement>(null), collapse = useRef<HTMLButtonElement>(null), moveFocus = useRef<"pill" | "panel" | null>(null);
  const titleId = useId();

  const accept = useCallback((next: JudgeView, source: Source) => {
    const previous = judgeRef.current;
    // A slow poll never replaces a newer state of the same demonstration.
    if (source === "poll" && previous && previous.tenantId === next.tenantId && previous.revision !== null && next.revision !== null && next.revision < previous.revision) return;
    judgeRef.current = next; setJudge(next); setPhase("ready"); setLoadError(null); setConnectionLost(false);
    if (previous && previous.currentBeatId !== next.currentBeatId) setPeek(null);
    const changed = source === "advance" || Boolean(previous && previous.revision !== next.revision && next.revision !== revisionRef.current);
    if (next.active && changed) window.dispatchEvent(new Event(JUDGE_REFRESH_EVENT));
  }, []);
  const load = useCallback(async (source: Source) => {
    if (reading.current || lock.current) return; reading.current = true; const at = epoch.current;
    if (source === "retry") { setPhase("loading"); setLoadError(null); }
    try { const next = await readJudge(tenantId); if (mounted.current && at === epoch.current) accept(next, source); }
    catch (reason) {
      if (!mounted.current || at !== epoch.current) return;
      if (sessionEnded(reason)) setPhase("ended");
      else if (source === "poll" || source === "sync") setConnectionLost(true);
      else { setPhase("error"); setLoadError(errorText(reason, "The guided tour could not be read.")); }
    } finally { reading.current = false; }
  }, [tenantId, accept]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { try { const value = sessionStorage.getItem(JUDGE_COLLAPSED_STORAGE); if (value === "1" || value === "0") setStored(value === "1"); } catch { /* The guide opens in its default state without browser storage. */ } }, []);
  useEffect(() => { void load("initial"); }, [load]);
  // The judge acted in the normal console (for example GO): read the guide again.
  useEffect(() => { const current = judgeRef.current; if (revision !== undefined && current?.active && current.revision !== revision) void load("sync"); }, [revision, load]);

  const beats = judge?.beats ?? [];
  const current = beats.find(beat => beat.id === judge?.currentBeatId) ?? null;
  const complete = Boolean(judge?.active && beats.length > 0 && !current && beats.every(beat => beat.status === "done"));
  const shown = beats.find(beat => beat.id === peek) ?? current ?? beats.at(-1) ?? null;
  const waiting = Boolean(judge?.active && phase === "ready" && !busy && !hidden && current && (current.waitingOn || judge.busy || current.id === "crew" && judge.crewLinks.some(link => !link.acknowledged)));
  useEffect(() => {
    if (!waiting) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => { if (timer) clearInterval(timer); timer = null; };
    const start = () => { stop(); if (document.visibilityState !== "hidden") timer = setInterval(() => void load("poll"), pollMs); };
    const visibility = () => { if (document.visibilityState === "hidden") stop(); else { void load("poll"); start(); } };
    start(); document.addEventListener("visibilitychange", visibility);
    return () => { stop(); document.removeEventListener("visibilitychange", visibility); };
  }, [waiting, load, pollMs]);

  const collapsed = stored ?? false;
  const setCollapsed = (value: boolean, focus: boolean) => {
    setStored(value); if (value) setConfirmReset(false); if (focus) moveFocus.current = value ? "pill" : "panel";
    try { sessionStorage.setItem(JUDGE_COLLAPSED_STORAGE, value ? "1" : "0"); } catch { /* The choice still holds for this page. */ }
  };
  useEffect(() => { if (moveFocus.current === "pill") pill.current?.focus(); else if (moveFocus.current === "panel") collapse.current?.focus(); moveFocus.current = null; });

  const advance = async (beat: JudgeBeat) => {
    if (lock.current) return; lock.current = true; epoch.current++; setBusy("advance"); setActionError(null);
    try {
      let stalled = 0;
      for (let call = 0; call < MAX_CHUNKS && mounted.current; call++) {
        // A chunk that failed without an answer is retried under its own identity.
        const key = pendingKey.current?.beatId === beat.id ? pendingKey.current.key : crypto.randomUUID();
        pendingKey.current = { beatId: beat.id, key };
        const before = beatFingerprint(judgeRef.current, beat.id);
        const next = await postJudge(tenantId, { action: "advance", beatId: beat.id, idempotencyKey: key });
        pendingKey.current = null; if (!mounted.current) return;
        accept(next, "advance");
        const after = next.beats.find(item => item.id === beat.id);
        if (!next.active || next.currentBeatId !== beat.id || !after?.canAdvance || after.steps.every(step => step.done)) break;
        stalled = beatFingerprint(next, beat.id) === before ? stalled + 1 : 0;
        if (stalled >= 2) break;
      }
    } catch (reason) {
      if (reason instanceof JudgeRequestError && reason.status < 500) pendingKey.current = null;
      if (!mounted.current) return;
      if (sessionEnded(reason)) setPhase("ended"); else setActionError(errorText(reason, "The beat could not advance."));
    } finally { epoch.current++; lock.current = false; if (mounted.current) setBusy(null); }
  };
  const begin = async (action: "start" | "reset") => {
    if (lock.current) return; lock.current = true; epoch.current++; setBusy(action); setActionError(null);
    try {
      const next = await postJudge(tenantId, { action });
      if (next.tenantId && next.tenantId !== tenantId) announceRehearsal(next.tenantId);
      // The session now points at the demonstration: load it from the server. The guide stays busy until then.
      navigate("/");
    } catch (reason) { lock.current = false; if (mounted.current) { setBusy(null); setActionError(errorText(reason, action === "reset" ? "The tour could not restart." : "The guided tour could not start.")); } }
  };
  const escape = (event: KeyboardEvent<HTMLElement>, close: () => void) => { if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); close(); } };

  if (hidden) return null;
  const startButton = <Button variant="primary" busy={busy === "start"} disabled={Boolean(busy)} onClick={() => void begin("start")}>Start the guided tour</Button>;
  const failure = actionError && <p className="judge-error" role="alert">{actionError}</p>;

  // Ordinary rehearsal, or a guide state that is not known yet: only the entry pill.
  if (!judge?.active || phase !== "ready") {
    const closeOffer = () => { setOfferOpen(false); moveFocus.current = "pill"; };
    return <aside className="judge-guide entry" aria-label="Guided tour">
      {offerOpen && <div className="judge-panel judge-offer" id={titleId + "-panel"} onKeyDown={event => escape(event, closeOffer)}>
        <div className="judge-panel-head"><span className="eyebrow">GUIDED TOUR</span><button ref={collapse} type="button" className="icon-button judge-collapse" aria-label="Close the guided tour offer" onClick={closeOffer}><ChevronDown size={18} /></button></div>
        <div className="judge-panel-body">
          {phase === "loading" && <p className="judge-note" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Reading the guided tour…</p>}
          {phase === "error" && <><p className="judge-error" role="alert">{loadError}</p><Button onClick={() => void load("retry")}>Try again</Button></>}
          {phase === "ended" && <><h2 className="judge-title">This guided session has ended.</h2><p className="judge-summary">Its saved records stay with that demonstration. You can start a new private guided tour now.</p>{startButton}</>}
          {phase === "ready" && <><h2 className="judge-title">Take the guided tour</h2><p className="judge-summary">{TOUR_DESCRIPTION}</p><p className="judge-note">Starting it creates a new private demonstration alongside this rehearsal. This rehearsal stays saved.</p>{startButton}</>}
          {failure}
        </div>
      </div>}
      {!offerOpen && <button ref={pill} type="button" className={`judge-pill quiet ${phase === "ended" ? "attention" : ""}`} aria-expanded={false} onClick={() => { setOfferOpen(true); moveFocus.current = "panel"; }}><Compass size={15} aria-hidden="true" />{phase === "ended" ? "Guided tour ended" : "Guided tour"}</button>}
    </aside>;
  }

  const number = shown ? beats.indexOf(shown) + 1 : 0, total = beats.length, currentNumber = current ? beats.indexOf(current) + 1 : total;
  const acknowledged = judge.acknowledged;
  if (collapsed) return <aside className="judge-guide" aria-label="Guided tour"><button ref={pill} type="button" className="judge-pill" aria-expanded={false} aria-label={`Open the guided tour. ${complete ? "Tour complete" : current ? `Beat ${currentNumber} of ${total}: ${current.cue}` : ""}`} onClick={() => setCollapsed(false, true)}><Compass size={15} aria-hidden="true" /><span>Guided tour</span><b className="mono">{complete ? "COMPLETE" : `${currentNumber}/${total}`}</b>{current && <em>{current.cue}</em>}{current?.id === "crew" && acknowledged && <b className="mono">{acknowledged.current}/{acknowledged.required}</b>}<ChevronUp size={15} aria-hidden="true" /></button></aside>;

  const isCurrent = Boolean(shown && current && shown.id === current.id), progress = shown ? beatProgress(shown) : { done: 0, total: 0 };
  const running = shown?.steps.find(step => !step.done), here = shown ? consolePath(consoleView) === pathOf(shown.href) : false;
  const hasReplay = Boolean(shown?.steps.some(step => step.provenance === "replay"));
  return <aside className="judge-guide" aria-labelledby={titleId}>
    <div className="judge-panel" onKeyDown={event => escape(event, () => confirmReset ? setConfirmReset(false) : setCollapsed(true, true))}>
      <div className="judge-panel-head">
        <span className="eyebrow">GUIDED TOUR <span className="judge-count mono">{complete && !peek ? "COMPLETE" : `BEAT ${number}/${total}`}</span></span>
        <button ref={collapse} type="button" className="icon-button judge-collapse" aria-expanded={true} aria-label="Collapse the guided tour" onClick={() => setCollapsed(true, true)}><ChevronDown size={18} /></button>
      </div>
      <div className="judge-panel-body">
        {shown && <>
          <div className="judge-cue-row"><span className="judge-cue">{shown.cue}</span><span className="judge-time mono">{shown.scenarioTime}</span><span className={`judge-state ${shown.status}`}>{shown.status === "done" ? "DONE" : shown.status === "current" ? "NOW" : "UPCOMING"}</span></div>
          <h2 id={titleId} className="judge-title">{shown.title}</h2>
          <p className="judge-summary">{shown.summary}</p>
          {complete && !peek && <p className="judge-note strong" role="status">The tour is complete. Every record it made stays in this private rehearsal.</p>}
          {shown.steps.length > 0 && <ol className="judge-steps" aria-label={`Steps in ${shown.cue}: ${progress.done} of ${progress.total} done`}>{shown.steps.map(step => <li key={step.id} className={step.done ? "done" : busy === "advance" && isCurrent && step === running ? "running" : ""}>
            <span className="judge-tick" aria-hidden="true">{step.done ? <Check size={12} /> : busy === "advance" && isCurrent && step === running ? <LoaderCircle size={12} className="spin" /> : null}</span>
            <span className="judge-step-label"><span className="sr-only">{step.done ? "Done: " : "Not done: "}</span>{step.label}{step.detail && <small className="mono">{step.detail}</small>}</span>
            <ProvenanceBadge kind={step.provenance} />
          </li>)}</ol>}
          {hasReplay && <p className="judge-payment-notice" role="note"><ProvenanceBadge kind="replay" />{judge.paymentNotice}</p>}
          {shown.id === "crew" && acknowledged && <p className="judge-ack" role="status" aria-live="polite"><span className="eyebrow">RUN SHEET ACKNOWLEDGED</span><strong>{acknowledged.current}<i>/</i>{acknowledged.required}</strong><span className="sr-only"> crew acknowledgments, read from this rehearsal</span></p>}
          {shown.id === "go" && <p className="judge-note strong">Readiness is computed from eight gates; GO only enables when all are current. You issue DOORS GO and confirm HOUSE OPEN yourself, through the same commands the crew use. The guide has no shortcut for either.</p>}
          {(shown.id === "crew" || shown.id === "go") && isCurrent && judge.crewLinks.length > 0 && <div className="judge-crew">{judge.crewLinks.map(link => <CrewLinkCard key={link.kind + link.personId} link={link} serverAt={judge.serverAt} openWindow={openWindow} mode={shown.id === "go" ? "cue" : "acknowledge"} />)}</div>}
        </>}
        <ol className="judge-stepper" aria-label="All beats of the tour">{beats.map((beat, index) => <li key={beat.id}><button type="button" className={`${beat.status} ${shown?.id === beat.id ? "shown" : ""}`} aria-current={beat.status === "current" ? "step" : undefined} aria-pressed={shown?.id === beat.id} aria-label={`Beat ${index + 1} of ${total}: ${beat.cue}, ${beat.status === "done" ? "done" : beat.status === "current" ? "current" : "upcoming"}`} title={beat.cue} onClick={() => setPeek(beat.id === judge.currentBeatId ? null : beat.id)}>{beat.status === "done" ? <Check size={13} aria-hidden="true" /> : <span aria-hidden="true">{index + 1}</span>}</button></li>)}</ol>
        <details className="judge-legend"><summary>What the labels mean</summary><dl>{(Object.keys(provenance) as JudgeProvenance[]).map(kind => <div key={kind}><dt><span className={`judge-provenance ${kind}`}>{provenance[kind].label}</span></dt><dd>{provenance[kind].meaning}</dd></div>)}</dl></details>
        {judge.accessExpiresAt && <p className="judge-faint">Private access to this demonstration ends {new Date(judge.accessExpiresAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}. A new tour can always be started.</p>}
      </div>
      <div className="judge-panel-actions">
        {connectionLost && <p className="judge-note" role="status">The guide could not refresh just now. It keeps trying while this beat waits.</p>}
        {failure}
        <p className="sr-only" role="status" aria-live="polite">{busy === "advance" && shown ? `${shown.cue}: ${progress.done} of ${progress.total} steps done` : ""}</p>
        {confirmReset ? <div className="judge-confirm" role="group" aria-label="Restart the tour">
          <p>Restart from the first beat? Progress in this guided rehearsal starts over.</p>
          <div className="judge-action-row"><Button variant="primary" busy={busy === "reset"} disabled={Boolean(busy)} onClick={() => void begin("reset")}>Restart now</Button><Button disabled={Boolean(busy)} onClick={() => setConfirmReset(false)}>Keep going</Button></div>
        </div> : <>
          {shown && isCurrent && busy === "advance" && <p className="judge-progress"><span className="mono">{progress.done}/{progress.total}</span> {running ? <>{running.label}{running.detail && <small className="mono"> {running.detail}</small>}</> : "Finishing the beat"}</p>}
          {isCurrent && judge.busy && busy !== "advance" && <p className="judge-progress" role="status"><LoaderCircle size={13} className="spin" aria-hidden="true" /> This beat is still working. The guide updates when it finishes.</p>}
          {shown && isCurrent && !shown.canAdvance && shown.waitingOn && !judge.busy && busy !== "advance" && <p className="judge-waiting"><span className="tiny-dot amber" aria-hidden="true" /><span><b>Waiting on you.</b> {shown.waitingOn}</span></p>}
          {shown && !isCurrent && !complete && <p className="judge-faint">{shown.status === "done" ? "This beat is done. Its result stays in the production." : "This beat comes later in the tour."}</p>}
          <div className="judge-action-row">
            {shown && isCurrent && shown.canAdvance && <Button variant="primary" busy={busy === "advance"} disabled={Boolean(busy)} onClick={() => void advance(shown)}>{shown.advanceLabel}</Button>}
            {shown && !isCurrent && current && <Button onClick={() => setPeek(null)}>Back to the current beat</Button>}
            {shown && (here ? <span className="judge-here">You are on this view</span> : <Link className="judge-show-link" href={shown.href}>Show me <ArrowUpRight size={14} aria-hidden="true" /></Link>)}
            {complete && !peek && <Link className="judge-show-link" href="/evidence">Evidence room <ArrowUpRight size={14} aria-hidden="true" /></Link>}
          </div>
          <button type="button" className="judge-restart" disabled={Boolean(busy)} onClick={() => setConfirmReset(true)}><RotateCcw size={13} aria-hidden="true" /> Restart the tour</button>
        </>}
      </div>
    </div>
  </aside>;
}
