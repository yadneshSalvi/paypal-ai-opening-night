"use client";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import type { Candidate, ShowSnapshot } from "@/domain/contracts";
import { approvedCandidate, buildCostCurve, sampleCostCurve, type CostCommitment } from "@/domain/cost-curve";
import { formatMoney } from "@/domain/time";
import { Badge } from "../ui";
import { venueClock } from "./format";
const CostCurveChart = dynamic(() => import("./cost-curve-chart"), { ssr: false, loading: () => <p className="cost-curve-fallback" role="status">Preparing the cost curve…</p> });

const usd = (minor: number) => formatMoney(minor, true);
const signed = (minor: number) => `${minor < 0 ? "−" : minor > 0 ? "+" : ""}${usd(Math.abs(minor))}`;
function CommitmentState({ row }: { row: CostCommitment }) {
  if (row.confirmation === "confirmed") return <Badge tone="green">CONFIRMED · PROVIDER RECORD</Badge>;
  if (row.confirmation === "partly_confirmed") return <Badge tone="amber">PARTLY CONFIRMED</Badge>;
  return <Badge tone="blue">MODELED · NOT A PAYMENT</Badge>;
}

/**
 * Time-phased cumulative cost for the show day. `preview` pins a candidate from the caller (the recovery studio);
 * without it the producer can pick one from the latest rescue run.
 */
export function CostCurvePanel({ show, preview }: { show: ShowSnapshot; preview?: Candidate | null }) {
  const approved = approvedCandidate(show), options = useMemo(() => (show.runs.at(-1)?.candidates ?? []).filter(candidate => candidate.id !== approved?.id), [show.runs, approved?.id]);
  const [chosen, setChosen] = useState("");
  const candidate = preview !== undefined ? preview : options.find(row => row.id === chosen) ?? null;
  const curve = useMemo(() => buildCostCurve(show, candidate), [show, candidate]), rows = useMemo(() => sampleCostCurve(curve, 60), [curve]);
  const { baseline, current } = curve, compared = curve.candidate ?? current, day = curve.startAt, clock = (instant: string) => venueClock(instant, day);
  const hold = compared.hold, laborDelta = compared.laborMinor - baseline.laborMinor;
  return <section className="graph-panel cost-curve" aria-labelledby="cost-curve-title">
    <div className="graph-heading"><div><span className="eyebrow">TIME-PHASED COST · SHOW DAY · VENUE TIME</span><h2 id="cost-curve-title">Cumulative planned cost</h2></div><div><Badge tone="blue">MODELED FROM THE PLAN</Badge></div></div>
    <p className="cost-curve-lede">Crew labour is each person’s assigned time at the roster’s hourly rate. Recovery commitments are the plan’s own figures, placed at the venue time the plan schedules them. A planned cost is not a captured payment: provider-confirmed amounts are listed separately, and the damage deposit is a hold, never a cost.</p>
    <dl className="cost-curve-totals">
      <div><dt>{baseline.label}</dt><dd>{usd(baseline.totalMinor)}</dd><small>Assigned crew labour</small></div>
      <div className={current.approved ? "is-plan" : ""}><dt>{current.label}</dt><dd>{usd(current.totalMinor)}</dd><small>{current.approved ? `Labour ${usd(current.laborMinor)} + recovery ${usd(current.commitmentMinor)}` : "No recovery plan approved"}</small></div>
      {curve.candidate && <div className="is-preview"><dt>{curve.candidate.label}</dt><dd>{usd(curve.candidate.totalMinor)}</dd><small>Labour {usd(curve.candidate.laborMinor)} + recovery {usd(curve.candidate.commitmentMinor)} · not approved</small></div>}
      {compared.statedCostMinor !== null && <div><dt>Recovery commitments</dt><dd>{usd(compared.commitmentMinor)}</dd><small>{compared.commitments.map(row => usd(row.amountMinor)).join(" + ")} · equals the plan’s stated cost</small></div>}
      {hold && <div className="is-hold"><dt>Deposit hold</dt><dd>{usd(hold.amountMinor)}</dd><small>{hold.authorizedMinor > 0 ? hold.releasedMinor >= hold.authorizedMinor ? "Authorization confirmed, then released" : "Authorization confirmed by provider record" : "Planned authorization"} · not a cost</small></div>}
    </dl>
    {preview === undefined && options.length > 0 && <label className="select-label cost-curve-preview"><span>Compare a candidate from the latest rescue run</span><select value={chosen} onChange={event => setChosen(event.target.value)}><option value="">No preview</option>{options.map(row => <option key={row.id} value={row.id}>{row.name} · {show.offers.find(offer => offer.id === row.patch.offerId)?.supplier ?? row.patch.offerId} · {usd(row.cost.totalMinor)} · {row.report.status.replaceAll("_", " ")}</option>)}</select></label>}
    <CostCurveChart curve={curve} />
    {compared.commitments.length > 0 ? <div className="table-wrap cost-curve-table"><table className="data-table"><caption>Dated recovery commitments in {compared.label}. Planned amounts are modeled; a confirmed amount is a verified sandbox provider record.</caption><thead><tr><th scope="col">Venue time</th><th scope="col">Commitment</th><th scope="col">Planned</th><th scope="col">Confirmed</th><th scope="col">State</th></tr></thead><tbody>
      {compared.commitments.map(row => <tr key={row.id}><td className="mono">{clock(row.at)}</td><th scope="row"><b>{row.label}</b><small>{row.timing}</small></th><td className="mono">{usd(row.amountMinor)}</td><td className="mono">{usd(row.confirmedMinor)}</td><td><CommitmentState row={row} /></td></tr>)}
      <tr className="cost-curve-sum"><td /><th scope="row"><b>Recovery commitments</b><small>Matches the plan’s stated cost of {usd(compared.statedCostMinor ?? 0)}</small></th><td className="mono">{usd(compared.commitmentMinor)}</td><td className="mono">{usd(compared.commitments.reduce((total, row) => total + row.confirmedMinor, 0))}</td><td /></tr>
      {hold && <tr><td className="mono">{clock(hold.from)}</td><th scope="row"><b>{hold.label}</b><small>Reserved buyer funds. Not counted in any cost above.</small></th><td className="mono">{usd(hold.amountMinor)}</td><td className="mono">{usd(hold.authorizedMinor)}</td><td><Badge tone="muted">HOLD · NOT A COST</Badge></td></tr>}
    </tbody></table></div> : <p className="cost-curve-note">No recovery plan is approved or previewed, so the current plan carries only assigned crew labour.</p>}
    {laborDelta !== 0 && <p className="cost-curve-note">Assigned crew labour is {usd(compared.laborMinor)} against a baseline of {usd(baseline.laborMinor)} ({signed(laborDelta)}), because the plan changes which calls are assigned. This is a planning figure, not a saving or a payroll amount: crew pay follows approved time reports in Wrap.</p>}
    <details className="cost-curve-data"><summary>Cost curve data table</summary><div className="table-wrap"><table className="data-table"><caption>Cumulative planned cost at each hour of the show day, venue time (America/Chicago). The last row is the end of each curve.</caption><thead><tr><th scope="col">Venue time</th><th scope="col">{baseline.label}</th><th scope="col">{current.label}</th>{curve.candidate && <th scope="col">{curve.candidate.label}</th>}{hold && <th scope="col">Deposit hold (not a cost)</th>}</tr></thead><tbody>
      {rows.map(row => <tr key={row.at}><th scope="row" className="mono">{clock(row.at)}</th><td className="mono">{usd(row.baselineMinor)}</td><td className="mono">{usd(row.currentMinor)}</td>{curve.candidate && <td className="mono">{usd(row.candidateMinor ?? 0)}</td>}{hold && <td className="mono">{usd(row.holdMinor)}</td>}</tr>)}
    </tbody></table></div></details>
  </section>;
}
