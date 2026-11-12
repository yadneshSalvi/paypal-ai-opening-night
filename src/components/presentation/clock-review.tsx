"use client";
import { useEffect, useRef, useState } from "react";
import type { ConsoleData } from "@/domain/contracts";
import type { Command } from "@/domain/commands";
import { atVenue, localTime, restLabel } from "@/domain/time";
import type { RunCommand } from "../production-console";
import { Modal } from "../ui";
import { confirmedClockTransition, pendingObservations, productionIdentity, type ClockTransition } from "./model";

export const clockTargets: Extract<Command, { type: "advance" }>["time"][] = ["16:10", "17:15", "17:20", "18:15", "18:35", "18:45", "19:00", "19:35", "20:00", "20:10", "20:40", "20:45", "22:15", "23:30"];
export function ClockReview({ data, run, busy, fresh, refresh }: { data: ConsoleData; run: RunCommand; busy: boolean; fresh: boolean; refresh: () => Promise<boolean> }) {
  const identity = productionIdentity(data), [open, setOpen] = useState(false), [target, setTarget] = useState(clockTargets[0]), [attempt, setAttempt] = useState<"idle" | "sending" | "unknown">("idle");
  const submitting = useRef(false), owner = useRef(identity); owner.current = identity;
  const [reviewRevision, setReviewRevision] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null), [slate, setSlate] = useState<ClockTransition | null>(null);
  const previous = useRef(data), roleAllowed = data.currentActor.roles.some(role => ["producer", "stage_manager"].includes(role)), supportedFixture = data.show.showDate === "2026-11-14", allowed = roleAllowed && supportedFixture;
  const targets = supportedFixture ? clockTargets.filter(time => Date.parse(atVenue(time)) > Date.parse(data.show.clock)) : [], pending = pendingObservations(data.show);
  useEffect(() => {
    const transition = confirmedClockTransition(previous.current, data); previous.current = data;
    if (transition) { setSlate(transition); setAttempt("idle"); setNotice("The server recorded this scenario clock transition. No execution evidence was created."); }
  }, [data]);
  useEffect(() => { if (!slate) return; const timeout = window.setTimeout(() => setSlate(null), 2000); return () => window.clearTimeout(timeout); }, [slate]);
  useEffect(() => { setOpen(false); setNotice(null); setSlate(null); setAttempt("idle"); }, [identity]);
  useEffect(() => { if (!fresh) setOpen(false); }, [fresh]);
  useEffect(() => { if (open && reviewRevision !== data.show.revision && !submitting.current) { setOpen(false); setNotice("The production changed after this time review opened. Inspect the current clock and open a new exact review."); } }, [open, reviewRevision, data.show.revision]);
  async function advance() {
    if (submitting.current || busy || !fresh || !allowed || reviewRevision !== data.show.revision || !targets.includes(target) || attempt === "unknown") return;
    submitting.current = true; setAttempt("sending"); const scope = identity, original = data;
    try {
      const result = await run({ type: "advance", time: target });
      if (owner.current !== scope) return;
      setOpen(false);
      if (result && confirmedClockTransition(original, result)) { setAttempt("idle"); setNotice("Scenario clock advanced by the authorized application command. Physical work remains unproven."); }
      else { setAttempt("unknown"); setNotice("This attempt did not return a confirmed clock transition. Read the current production before another explicit review; no result is assumed."); }
    } catch { if (owner.current === scope) { setOpen(false); setAttempt("unknown"); setNotice("This attempt did not return a confirmed clock transition. Read the current production before another explicit review; no result is assumed."); } }
    finally { submitting.current = false; }
  }
  async function recover() { if (await refresh()) { setAttempt("idle"); setNotice("The current production was read. Review its actual scenario clock before any new instruction; the previous response is not called successful."); } }
  return <section className="presentation-clock-review" aria-label="Explicit scenario time control">
    <div><span className="presentation-kicker">SCENARIO CLOCK / ACCELERATED FIXTURE</span><strong>{localTime(data.show.clock)} CST</strong><p>Time advances only through the existing authorized command. A skipped interval does not record work, delivery, payment, readback or an artist arrival.</p></div>
    {allowed && targets.length > 0 && <button type="button" disabled={busy || !fresh || attempt !== "idle"} onClick={() => { setTarget(targets[0]); setReviewRevision(data.show.revision); setOpen(true); }}>Review a scenario time skip</button>}
    {supportedFixture && !roleAllowed && <p>Your current role can inspect time. It cannot advance the scenario clock.</p>}
    {!supportedFixture && <p>This production has no supported November 14 scenario time skip. Its current clock remains read only here.</p>}
    {supportedFixture && !targets.length && <p>No later supported scenario time remains.</p>}
    {notice && <p role="status">{notice}</p>}
    {attempt === "unknown" && <button type="button" disabled={busy} onClick={() => void recover()}>Read current clock before another review</button>}
    {pending.length > 0 && <div className="presentation-pending" role="status"><strong>{pending.length} pending financial observations remain visible</strong>{pending.map(row => <span key={row.id}>{row.label}</span>)}</div>}
    {slate && <div className="presentation-time-slate" role="status"><span>SCENARIO CLOCK · CONFIRMED APPLICATION EVENT</span><strong>TIME SKIP → {localTime(slate.to)} CST</strong><p>+{restLabel(Math.round(slate.elapsedMinutes))} · fixture clock · from {localTime(slate.from)} CST</p><small>No physical execution or provider result was created.</small>{pending.length > 0 && <p>{pending.length} financial observations remain pending. See the retained observation list below.</p>}</div>}
    {open && <Modal title="Review the exact scenario time skip." dismissible={!submitting.current && !busy} onClose={() => setOpen(false)}><div className="presentation-clock-dialog"><p>This advances the controlled November 14 scenario. It preserves source evidence and does not complete the work between these times.</p><dl><div><dt>Current confirmed time</dt><dd>{localTime(data.show.clock)} CST</dd></div><div><dt>Source</dt><dd>Existing authorized scenario-clock command · revision {data.show.revision}</dd></div></dl><label>New scenario time<select autoFocus value={target} onChange={event => setTarget(event.target.value as typeof target)}>{targets.map(time => <option key={time} value={time}>{time} CST · +{(Date.parse(atVenue(time)) - Date.parse(data.show.clock)) / 60000} minutes</option>)}</select></label>{pending.length > 0 && <p>{pending.length} pending financial observations remain unresolved after a clock skip.</p>}<button type="button" disabled={busy || submitting.current || !fresh} onClick={() => void advance()}>Advance only the scenario clock to {target} CST</button><button type="button" disabled={busy || submitting.current} onClick={() => setOpen(false)}>Keep the current time</button></div></Modal>}
  </section>;
}
