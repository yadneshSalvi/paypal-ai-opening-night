"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { ViewProps } from "../production-console";
import { StageMap } from "../stage-map";
import { localTime } from "@/domain/time";
import { pendingObservations, productionIdentity } from "./model";
import { useLinkedSelection } from "./selection";
import { SelectionInspector } from "./selection-inspector";
import { CanonicalCallList, CommitmentPanel, GuidedReview, ReadinessPanel, ResourcePanel, SourcePanel, SupplierPanel } from "./panels";
import { useProductionRead } from "./use-production-read";
import { QuietGoView, useCueWatch } from "./cue-watch";
import { GoStaging } from "./go-staging";
import { isDemonstration } from "../production-header";
import { ClockReview } from "./clock-review";
import { PresentationCanvas } from "./canvas";
import { usePrintEvidence } from "../print-evidence";

const tabs = [{ id: "stage", label: "Stage" }, { id: "timeline", label: "Timeline" }, { id: "people", label: "Crew & equipment" }, { id: "suppliers", label: "Suppliers" }, { id: "sources", label: "Sources" }, { id: "readiness", label: "Readiness" }, { id: "commitments", label: "Commitments" }, { id: "guide", label: "Next decision" }] as const;
type Tab = typeof tabs[number]["id"];
export function PresentationView({ data, onData, run, busy, licenseKey, active = true, onQuietChange, onAccessEnded }: ViewProps & { active?: boolean; onQuietChange?: (quiet: boolean) => void; onAccessEnded?: () => void }) {
  const identity = productionIdentity(data), linked = useLinkedSelection(), [tab, setTab] = useState<Tab>("stage"), [full, setFull] = useState(false), [narrow, setNarrow] = useState(false), [now, setNow] = useState(Date.now());
  const heading = useRef<HTMLHeadingElement>(null), tabRefs = useRef<(HTMLButtonElement | null)[]>([]), prefix = useId();
  const printRoot = useRef<HTMLDivElement>(null); usePrintEvidence(printRoot);
  const read = useProductionRead(data, onData, Boolean(busy), active), fresh = active && ["ready", "reading"].includes(read.phase) && read.confirmedAt > 0 && now - read.confirmedAt < 30_000;
  const cue = useCueWatch(data, fresh, active && !busy), quiet = Boolean(cue.quiet);
  const latest = useRef({ watching: cue.watching, quiet, refresh: read.refresh, busy }); latest.current = { watching: cue.watching, quiet, refresh: read.refresh, busy };
  useEffect(() => { const media = matchMedia("(max-width: 600px)"); const resize = () => setNarrow(media.matches); resize(); media.addEventListener("change", resize); return () => media.removeEventListener("change", resize); }, []);
  useEffect(() => {
    void read.refresh();
    const focus = () => { if (document.visibilityState === "visible") void latest.current.refresh(); };
    const interval = window.setInterval(() => { setNow(Date.now()); if ((latest.current.watching || latest.current.quiet) && !latest.current.busy) void latest.current.refresh(); }, 4000);
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", focus);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); };
  }, [identity, read.refresh]);
  useEffect(() => { if (!active || read.phase === "ended") linked?.clear(); }, [read.phase, active, linked?.clear]);
  useEffect(() => { onQuietChange?.(quiet); return () => onQuietChange?.(false); }, [quiet, onQuietChange]);
  useEffect(() => { if (read.phase === "ended") onAccessEnded?.(); }, [read.phase, onAccessEnded]);
  useEffect(() => { setTab("stage"); setFull(false); }, [identity]);
  function chooseTab(next: Tab) { setTab(next); }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault(); chooseTab(tabs[next].id); tabRefs.current[next]?.focus();
  }
  const selectedTaskIds = linked?.detail?.tasks.map(row => row.id) ?? [], selectedResourceIds = linked?.detail?.resources.map(row => row.id) ?? [];
  const native = (mode: "split" | "scheduler" = "split") => <PresentationCanvas show={data.show} licenseKey={licenseKey} selection={linked?.selection ?? null} selectedTaskIds={selectedTaskIds} selectedResourceIds={selectedResourceIds} onSelect={selection => linked?.select(selection)} full={full} narrow={narrow} mode={mode} />;
  if (!active || read.phase === "ended") return <section className="presentation-workspace presentation-access-ended" aria-label="Presentation access ended"><h1 ref={heading} tabIndex={-1}>Current production access is unavailable.</h1><p>{read.message ?? "Another production is selected. Reopen the current production before reading its source or presentation views."}</p><p>The previous presentation and linked source content are closed. No cue was issued by this view.</p><Link href="/">Open the current production</Link></section>;
  return <>
    <div className="presentation-workspace" ref={printRoot} inert={quiet} aria-hidden={quiet ? true : undefined}>
      <header className="presentation-heading"><div><span className="presentation-kicker">PRESENTATION / CURRENT PRODUCTION</span><h1 ref={heading} tabIndex={-1} data-presentation-heading>{data.show.title}</h1><p>{data.show.venue} · {data.show.showDate} · plan v{data.show.planVersion} · run sheet v{data.show.sheets.at(-1)?.version ?? "not published"}</p></div><div className="presentation-heading-actions"><button type="button" disabled={Boolean(busy) || read.phase === "reading"} onClick={() => void read.refresh()}>{read.phase === "reading" ? "Reading current production…" : "Refresh current production"}</button><button type="button" onClick={() => window.print()}>Print this evidence view</button><Link href="/execution">Ordinary execution desk</Link></div></header>
      <div className="presentation-source-slate"><div><span>SCENARIO / ACCELERATED FIXTURE CLOCK</span><strong>{localTime(data.show.clock)} CST</strong></div><div><span>LAST CONFIRMED SERVER READ</span><strong>{new Date(data.serverAt).toISOString()}</strong><small>Revision {data.show.revision} · {fresh ? "current read confirmed" : "refresh required before cue watch or time control"}</small></div><p>{isDemonstration(data) ? "Guided demonstration. Payment outcomes are replayed; no PayPal request is made. Physical participation remains separate." : data.controlledQa ? "Controlled inputs exercise real application behavior. Provider outcomes and physical participation remain separate." : "Source provenance stays attached to each original record. A schedule, readiness report or illustration does not prove physical execution."}</p></div>
      {read.message && <div className="presentation-read-error" role={read.phase === "unavailable" ? "alert" : "status"}><strong>{read.phase === "unavailable" ? "Current read did not complete." : "Read observation"}</strong><p>{read.message}</p><p>The last confirmed snapshot is retained and labeled. It cannot start a quiet cue view or a time instruction while unconfirmed.</p><button type="button" disabled={read.phase === "reading" || Boolean(busy)} onClick={() => void read.refresh()}>Retry the current read</button></div>}
      <div className="presentation-tabs" role="tablist" aria-label="Presentation views">{tabs.map((entry, index) => <button ref={node => { tabRefs.current[index] = node; }} key={entry.id} id={`${prefix}-${entry.id}-tab`} type="button" role="tab" aria-selected={tab === entry.id} aria-controls={`${prefix}-${entry.id}-panel`} tabIndex={tab === entry.id ? 0 : -1} onClick={() => chooseTab(entry.id)} onKeyDown={event => tabKey(event, index)}>{entry.label}</button>)}</div>
      <div className="presentation-content-layout"><section role="tabpanel" id={`${prefix}-${tab}-panel`} aria-labelledby={`${prefix}-${tab}-tab`} tabIndex={0} className="presentation-active-panel">
        {tab === "stage" && <><div className="presentation-panel-heading"><div><span className="presentation-kicker">SCHEMATIC / LINKED CANONICAL IDS</span><h2>One room. Every consequence connected.</h2><p>Select a department, call or equipment record. The same IDs follow into the timeline, crew and sources.</p></div><button type="button" onClick={() => chooseTab("timeline")}>Inspect the native timeline</button></div><StageMap data={data} disrupted={data.show.incidents.some(row => row.kind === "console" && row.confirmed)} /><CanonicalCallList data={data} /></>}
        {tab === "timeline" && <><div className="presentation-panel-heading"><div><span className="presentation-kicker">BRYNTUM ENTERPRISE 8.0.0 / READ ONLY</span><h2>Calls and people share the same committed model.</h2><p>56-pixel rows, fixed name columns and a bounded venue-time range. Dependency lines are actual canonical edges.</p></div><label><input type="checkbox" checked={full} onChange={event => setFull(event.target.checked)} /> Include preparation calls</label></div>{native()}<CanonicalCallList data={data} full={full} /></>}
        {tab === "people" && <><div className="presentation-panel-heading"><div><span className="presentation-kicker">QUALIFICATION / CURRENT ASSIGNMENTS</span><h2>Every call has real resource IDs.</h2><p>Select a native event or resource row. A roster entry alone does not establish attendance, acknowledgment or completion.</p></div></div>{native("scheduler")}<ResourcePanel data={data} /></>}
        {tab === "suppliers" && <><div className="presentation-panel-heading"><div><span className="presentation-kicker">SOURCE TERMS / NO AUTOMATIC COMMITMENT</span><h2>Delivery changes the whole chain.</h2><p>Inspect exact fees, held deposits and source terms independently. A quoted arrival is a proposal until the ordinary workflow verifies it.</p></div></div><SupplierPanel data={data} />{linked?.selection?.kind === "supplier" && <section aria-label="Native unapproved supplier delivery preview">{native()}<CanonicalCallList data={data} /></section>}</>}
        {tab === "sources" && <SourcePanel data={data} />}
        {tab === "readiness" && <ReadinessPanel data={data} />}
        {tab === "commitments" && <CommitmentPanel data={data} />}
        {tab === "guide" && <GuidedReview data={data} />}
      </section><SelectionInspector data={data} /></div>
      <GoStaging data={data} />
      <section className="presentation-watch" aria-label="Explicit quiet cue presentation"><div><span className="presentation-kicker">SILENT PRESENTATION / ACTUAL CUE ONLY</span><h2>Let the real GO hold the room.</h2><p>Watch for a newly recorded current DOORS_GO from its authorized operator. This page reads only; opening or watching it never issues a cue. A saved historical GO does not replay on mount.</p></div><button type="button" disabled={!fresh || Boolean(busy) || cue.watching || pendingObservations(data.show).length > 0} onClick={cue.arm}>Watch for the next authorized GO</button>{cue.watching && <><p role="status">Watching current production reads. Waiting for a new, verified current cue; all ordinary approval and person-specific steps remain required.</p><button type="button" onClick={cue.stop}>Stop watching</button></>}{cue.message && <p role="status">{cue.message}</p>}</section>
      {cue.watching && <p className="presentation-qualification">Stop the cue watch before opening a scenario time review. A time preview never competes with the quiet cue view.</p>}
      <ClockReview data={data} run={run} busy={Boolean(busy)} fresh={fresh && !cue.watching && !quiet} refresh={read.refresh} />
      <p className="presentation-qualification">Silent illustrative stage. Application records show intent and attributed evidence, not physical entry. Native rendering, human interpretation and the complete recorded journey require their own observations.</p>
    </div>
    {cue.quiet && <QuietGoView data={data} quiet={cue.quiet} onStop={cue.stop} onPresented={cue.presented} />}
  </>;
}
