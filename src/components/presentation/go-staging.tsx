"use client";
/** GO staging for presentation mode. A read model only: it never issues, replays or implies a cue. */
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ConsoleData } from "@/domain/contracts";
import { localTime } from "@/domain/time";
import { currentGo, currentReadiness, productionIdentity, type CurrentCue } from "./model";

/** Initial read-through of the stack: one item every 750 ms (about six seconds for eight), each with a 150 ms tick. */
export const CUE_FILL_STEP_MS = 750, CUE_TICK_MS = 150;
export type GoStage = "unread" | "fill" | "standby" | "go";
export interface GoStagingItem { id: string; label: string; word: string; complete: boolean }
export interface GoStagingModel {
  stage: GoStage; items: GoStagingItem[]; complete: number; total: number; doors: string;
  /** `STANDBY — DOORS 19:00` only when the current conjunction is true; `GO — DOORS 19:00` only from a verified current GO. */
  bar: string | null; cue: CurrentCue | null; headliner: { label: string; clear: boolean };
}
/** HEADLINER_START is its own gate. A DOORS GO never turns it green. */
export function headlinerChip(data: ConsoleData): GoStagingModel["headliner"] {
  const report = currentReadiness(data, "HEADLINER_START"), onSite = report?.gates.find(row => row.id === "headliner-checkin");
  if (!report) return { label: "HEADLINER_START · separate gate not read", clear: false };
  if (report.ready) return { label: "HEADLINER_START · separate readiness clear", clear: true };
  return { label: onSite && !onSite.complete ? `HEADLINER_START · on site ${onSite.value.replace(" · ", " ")}` : `HEADLINER_START · ${report.blockers.length} separate ${report.blockers.length === 1 ? "blocker" : "blockers"}`, clear: false };
}
/** The GO state exists only while `currentGo` verifies a recorded GO against the report of this exact revision. */
export function goStagingModel(data: ConsoleData): GoStagingModel {
  const report = currentReadiness(data), cue = currentGo(data), doors = localTime(data.show.doorsAt);
  const items = report?.gates.map(gate => ({ id: gate.id, label: gate.label, word: gate.value.replace(" / ", "/"), complete: gate.complete })) ?? [];
  const conjunction = Boolean(report?.ready && items.length > 0 && items.every(row => row.complete));
  const stage: GoStage = !report ? "unread" : cue ? "go" : conjunction ? "standby" : "fill";
  return { stage, items, complete: items.filter(row => row.complete).length, total: items.length, doors, bar: stage === "go" ? `GO — DOORS ${doors}` : stage === "standby" ? `STANDBY — DOORS ${doors}` : null, cue, headliner: headlinerChip(data) };
}
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The cue stack reads top to bottom in report order, collapses into one bar when the conjunction is true,
 * and reads GO only from a verified current cue. Reduced motion skips the read-through and keeps every word.
 */
export function GoStaging({ data }: { data: ConsoleData }) {
  const model = goStagingModel(data), identity = productionIdentity(data), count = model.items.length;
  // A production opened after its GO shows the recorded state at once; a past cue is never re-staged.
  const [staged, setStaged] = useState(() => model.stage === "go" || model.stage === "unread" || reducedMotion());
  const [seen, setSeen] = useState(identity);
  if (seen !== identity) { setSeen(identity); setStaged(model.stage === "go" || model.stage === "unread" || reducedMotion()); }
  useEffect(() => {
    if (staged) return;
    const timer = window.setTimeout(() => setStaged(true), count * CUE_FILL_STEP_MS + CUE_TICK_MS);
    return () => window.clearTimeout(timer);
  }, [staged, identity, count]);
  const collapsed = staged && (model.stage === "standby" || model.stage === "go");
  return <section className="go-staging" aria-label="DOORS cue stack" data-stage={model.stage} data-staged={staged} data-collapsed={collapsed}>
    <div className="go-staging-heading"><div><span className="presentation-kicker">DOORS READINESS / CUE STACK</span><h2>{model.stage === "go" ? "The cue is recorded." : model.stage === "standby" ? "Every gate is clear. The call belongs to its operator." : "Earn the green light."}</h2></div>{model.stage !== "unread" && <span className="go-count" aria-label={`${model.complete} of ${model.total} DOORS gates clear`}>{model.complete}<small>/{model.total}</small></span>}</div>
    {model.stage === "unread" ? <p>Current readiness has not been read for this revision. No gate state is shown.</p> : <>
      <div className="go-stack-wrap" inert={collapsed} aria-hidden={collapsed ? true : undefined}><ol className="go-stack">{model.items.map((item, index) => <li key={item.id} data-gate={item.id} data-clear={item.complete} style={{ "--cue-index": index } as React.CSSProperties}><span className="go-tick" aria-hidden="true" /><strong>{item.label}</strong><span className="go-word">{item.word}</span><span className="go-state">{item.complete ? "Clear" : "Pending"}</span></li>)}</ol></div>
      {collapsed && <div className={`go-bar ${model.stage}`} role="status" data-bar={model.stage}><span className="go-bar-light" aria-hidden="true" /><strong>{model.bar}</strong>{model.stage === "go" && model.cue ? <span>GO recorded {localTime(model.cue.fixtureAt)} CST · {model.cue.person}</span> : <Link href="/execution#cue-execution">Readiness is clear. Only the assigned stage manager can call GO</Link>}</div>}
      <span className={`go-headliner-chip ${model.headliner.clear ? "clear" : "amber"}`} data-headliner={model.headliner.clear ? "clear" : "pending"}>{model.headliner.label}</span>
    </>}
    <p className="presentation-qualification">This stack is a read model of the current report. It does not issue a cue, and a recorded cue does not prove physical entry.</p>
  </section>;
}
