"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsoleData } from "@/domain/contracts";
import { localTime } from "@/domain/time";
import { headlinerChip } from "./go-staging";
import { QUIET_GO_MS, currentGo, currentHouseOpen, currentReadiness, pendingObservations, productionIdentity, watchCanPresent, type CueWatch, type CurrentCue } from "./model";

export interface QuietCue {
  production: string; cue: CurrentCue; startedAt: number | null; complete: boolean;
  snapshot: { clock: string; doorsAt: string; title: string; venue: string; planVersion: number; sheetVersion: number | null; headlinerReady: boolean };
}
export function useCueWatch(data: ConsoleData, fresh: boolean, enabled: boolean) {
  const identity = productionIdentity(data), [watch, setWatch] = useState<CueWatch | null>(null), [quiet, setQuiet] = useState<QuietCue | null>(null), [message, setMessage] = useState<string | null>(null);
  const live = useRef({ data, fresh, enabled }); live.current = { data, fresh, enabled };
  const cue = currentGo(data), valid = enabled && fresh && pendingObservations(data.show).length === 0 && quiet?.production === identity && quiet.cue.id === cue?.id;
  useEffect(() => {
    if (!enabled || !fresh || watch && watch.production !== identity) { setWatch(null); if (quiet) setMessage("Quiet view ended because current production access or readiness could not be confirmed."); setQuiet(null); return; }
    if (watch && !quiet) { const accepted = watchCanPresent(watch, data, fresh); if (accepted) { setQuiet({ production: identity, cue: accepted, startedAt: null, complete: false, snapshot: { clock: data.show.clock, doorsAt: data.show.doorsAt, title: data.show.title, venue: data.show.venue, planVersion: data.show.planVersion, sheetVersion: data.show.sheets.at(-1)?.version ?? null, headlinerReady: currentReadiness(data, "HEADLINER_START")?.ready === true } }); setWatch(null); setMessage(null); } }
    if (quiet && !valid) { setQuiet(null); setMessage("The current GO evidence changed. The quiet view stopped; inspect the latest report."); }
  }, [data, fresh, enabled, identity, watch, quiet, valid]);
  useEffect(() => {
    if (!quiet || quiet.startedAt === null || quiet.complete || !valid) return;
    const startedAt = quiet.startedAt;
    let timer: number;
    const check = () => {
      const current = live.current;
      if (!current.enabled || !current.fresh || productionIdentity(current.data) !== quiet.production || currentGo(current.data)?.id !== quiet.cue.id) return;
      const elapsed = performance.now() - startedAt;
      if (elapsed >= QUIET_GO_MS) setQuiet(previous => previous?.cue.id === quiet.cue.id ? { ...previous, complete: true } : previous);
      else timer = window.setTimeout(check, Math.max(1, QUIET_GO_MS - elapsed));
    };
    timer = window.setTimeout(check, Math.max(1, QUIET_GO_MS - (performance.now() - startedAt)));
    return () => window.clearTimeout(timer);
  }, [quiet, valid]);
  useEffect(() => {
    const changed = () => { if (document.visibilityState === "hidden") { setWatch(null); setQuiet(null); setMessage("Presentation paused while this page was hidden. Review the current production before watching a new cue."); } };
    document.addEventListener("visibilitychange", changed); return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const presented = useCallback((id: string, at: number) => {
    const current = live.current;
    if (!current.enabled || !current.fresh || !Number.isFinite(at) || document.visibilityState === "hidden" || currentGo(current.data)?.id !== id) return;
    setQuiet(previous => previous?.cue.id === id && previous.production === productionIdentity(current.data) && previous.startedAt === null ? { ...previous, startedAt: at } : previous);
  }, []);
  return {
    watching: enabled && watch?.production === identity, quiet: valid ? quiet : null, message, presented,
    arm: () => { if (enabled && fresh && pendingObservations(data.show).length === 0) { setQuiet(null); setMessage(null); setWatch({ production: identity, baselineCue: cue?.id ?? null, revision: data.show.revision }); } },
    stop: () => { setWatch(null); setQuiet(null); setMessage("Quiet presentation stopped. No cue or production state changed."); },
  };
}

export function QuietGoView({ data, quiet, onStop, onPresented }: { data: ConsoleData; quiet: QuietCue; onStop: () => void; onPresented: (id: string, at: number) => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement, overflow = document.body.style.overflow; document.body.style.overflow = "hidden"; close.current?.focus(); return () => { document.body.style.overflow = overflow; if (previous instanceof HTMLElement && previous.isConnected && !previous.closest("[inert]")) previous.focus({ preventScroll: true }); }; }, []);
  useEffect(() => {
    // Start the hold after a quiet frame can paint, not before React/SDK work.
    let second = 0; const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => onPresented(quiet.cue.id, performance.now())); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [quiet.cue.id, onPresented]);
  return <section className="presentation-quiet" role="region" aria-label="Confirmed GO quiet presentation" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onStop(); } else if (event.key === "Tab") { event.preventDefault(); close.current?.focus(); } }}>
    <div className="presentation-quiet-top"><span>CONFIRMED CURRENT CUE</span><button ref={close} type="button" onClick={onStop}>Leave quiet view</button></div>
    <div className="presentation-quiet-body"><div className="presentation-warm-stage" aria-hidden="true"><i /><i /><i /><span /></div><span className="presentation-cue-light" /><p>GO — DOORS {localTime(quiet.snapshot.doorsAt)} CST</p><span className={`go-headliner-chip ${headlinerChip(data).clear ? "clear" : "amber"}`} data-headliner={headlinerChip(data).clear ? "clear" : "pending"}>{headlinerChip(data).label}</span><h2>{quiet.snapshot.title}</h2><span>{quiet.snapshot.venue} · plan v{quiet.snapshot.planVersion} · run sheet v{quiet.snapshot.sheetVersion ?? "unavailable"}</span><strong>{currentHouseOpen(data) ? "HOUSE OPEN · separate FOH confirmation recorded" : "HOUSE OPEN awaits its separate FOH command"}</strong></div>
    <div className="presentation-quiet-evidence"><span>GO recorded {localTime(quiet.cue.fixtureAt)} CST · {quiet.cue.person}</span><span>{quiet.cue.attribution === "signed_controlled_crew" ? "Signed personal crew cue · controlled participation" : "Authorized application command · original source retained"}</span><code>{quiet.cue.id}</code><span>Scenario time at cue observation {localTime(quiet.snapshot.clock)} CST · accelerated fixture clock · silent</span><span>HEADLINER_START · {quiet.snapshot.headlinerReady ? "separate readiness clear; its start cue remains independent" : "separate gate remains unresolved"}</span><span>{quiet.complete ? "At least 14 seconds of quiet presentation completed." : "Quiet hold · background panels and counters are still."}</span><small>Illustrative light only. A recorded cue does not prove physical entry or stage execution.</small></div>
  </section>;
}
