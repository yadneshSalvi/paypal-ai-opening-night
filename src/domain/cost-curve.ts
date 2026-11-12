/**
 * Time-phased cumulative planned cost for the show day (an S-curve).
 *
 * Every value here is a projection of the canonical production model. It is a planning figure, not
 * payroll and not a payment: crew labour is each person's assigned time multiplied by the roster's
 * hourly rate, and recovery commitments are the approved (or previewed) plan's own cost statement
 * placed at the scenario instant the plan schedules them. Provider-verified money is reported
 * beside each commitment and never substituted for the plan amount.
 */
import type { Candidate, Resource, ShowSnapshot, Task } from "./contracts";
import { financialSummary } from "./finance";

const HOUR_MS = 3_600_000;
export type CostCurvePlanKey = "baseline" | "current" | "candidate";
export type CostCommitmentId = "rental_fee" | "vip_remedies" | "projected_overtime";
export type CostConfirmation = "modeled" | "partly_confirmed" | "confirmed";

export interface CostCommitment {
  id: CostCommitmentId; label: string; at: string; amountMinor: number;
  /** Provider-verified amount recorded against this commitment. Always 0 for previews and projections. */
  confirmedMinor: number; confirmation: CostConfirmation;
  /** Why the amount sits at this instant. */
  timing: string;
}
/** A damage-deposit authorization is reserved buyer funds. It is never a cost, expense or revenue. */
export interface CostHold { label: string; from: string; amountMinor: number; authorizedMinor: number; releasedMinor: number }
export interface CostCurvePlan {
  key: CostCurvePlanKey; label: string; candidateId: string | null; approved: boolean;
  /** Assigned crew time × hourly rate, rounded once to the cent. */
  laborMinor: number;
  /** Rental fee + projected overtime + ticket remedies. Equals the plan's stated cost exactly. */
  commitmentMinor: number; totalMinor: number;
  /** The plan's own cost statement, when it has one. */
  statedCostMinor: number | null;
  commitments: CostCommitment[]; hold: CostHold | null;
  /** Rate-weighted milliseconds (cents·ms per hour) at each labour breakpoint, strictly increasing in time. */
  labor: { at: number; weighted: number }[];
}
export interface CostCurvePoint { at: string; baselineMinor: number; currentMinor: number; candidateMinor: number | null; holdMinor: number }
export interface CostCurve {
  currency: "USD"; zone: string; startAt: string; endAt: string; clock: string;
  baseline: CostCurvePlan; current: CostCurvePlan; candidate: CostCurvePlan | null;
  /** Exact values at every instant where any series changes slope or steps. Steps appear as two points. */
  points: CostCurvePoint[];
}

const ms = (instant: string) => Date.parse(instant);
/** Same spelling as the canonical instants (`2026-11-14T23:20:00Z`). */
const iso = (value: number) => new Date(value).toISOString().replace(".000Z", "Z");
const roundMinor = (weighted: number) => Math.round(weighted / HOUR_MS);

/** A person assigned to overlapping tasks is costed once for that time. */
function laborBreakpoints(tasks: Pick<Task, "start" | "end" | "resources">[], resources: Resource[]) {
  const rates = new Map(resources.filter(row => row.kind === "person" && row.rateMinor > 0).map(row => [row.id, row.rateMinor]));
  const slope = new Map<number, number>();
  for (const [personId, rate] of rates) {
    const spans = tasks.filter(task => task.resources.includes(personId)).map(task => [ms(task.start), ms(task.end)] as [number, number]).filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
    let open: [number, number] | null = null;
    const close = (span: [number, number]) => { slope.set(span[0], (slope.get(span[0]) ?? 0) + rate); slope.set(span[1], (slope.get(span[1]) ?? 0) - rate); };
    for (const span of spans) {
      if (open && span[0] <= open[1]) open[1] = Math.max(open[1], span[1]);
      else { if (open) close(open); open = [...span]; }
    }
    if (open) close(open);
  }
  const labor: CostCurvePlan["labor"] = []; let rate = 0, weighted = 0, previous = 0;
  for (const at of [...slope.keys()].sort((a, b) => a - b)) {
    weighted += rate * (at - previous); rate += slope.get(at)!; previous = at;
    labor.push({ at, weighted });
  }
  return labor;
}
function laborAt(plan: CostCurvePlan, at: number): number {
  const rows = plan.labor; if (!rows.length || at <= rows[0].at) return 0;
  const last = rows[rows.length - 1]; if (at >= last.at) return last.weighted;
  const index = rows.findIndex(row => row.at > at), before = rows[index - 1], after = rows[index];
  return before.weighted + (after.weighted - before.weighted) * (at - before.at) / (after.at - before.at);
}
/** Cumulative planned cost at an instant. `inclusive: false` reads the value just before any step at that instant. */
export function costAt(plan: CostCurvePlan, instant: string, inclusive = true): number {
  const at = ms(instant);
  return roundMinor(laborAt(plan, at)) + plan.commitments.reduce((total, row) => total + (ms(row.at) < at || inclusive && ms(row.at) === at ? row.amountMinor : 0), 0);
}
export function holdAt(curve: CostCurve, instant: string): number {
  const hold = curve.candidate?.hold ?? curve.current.hold; return hold && ms(hold.from) <= ms(instant) ? hold.amountMinor : 0;
}

function confirmation(amountMinor: number, confirmedMinor: number): CostConfirmation { return confirmedMinor <= 0 ? "modeled" : confirmedMinor >= amountMinor ? "confirmed" : "partly_confirmed"; }
function plan(key: CostCurvePlanKey, label: string, tasks: Task[], show: ShowSnapshot, candidate: Candidate | null, approved: boolean, remedyAt: string | null): CostCurvePlan {
  const labor = laborBreakpoints(tasks, show.resources), laborMinor = roundMinor(labor.at(-1)?.weighted ?? 0);
  const commitments: CostCommitment[] = []; let hold: CostHold | null = null;
  if (candidate) {
    const offer = show.offers.find(row => row.id === candidate.patch.offerId), find = (id: string) => candidate.patch.tasks.find(task => task.id === id)?.start;
    const authorizedAt = find("rental-authorized") ?? show.clock, capturedAt = find("rental-captured") ?? authorizedAt;
    const money = approved ? financialSummary(show) : null, supportOnly = candidate.patch.programMode === "support_only";
    const add = (id: CostCommitmentId, label: string, at: string, amountMinor: number, confirmedMinor: number, timing: string) => { if (amountMinor > 0) commitments.push({ id, label, at, amountMinor, confirmedMinor: Math.min(amountMinor, Math.max(0, confirmedMinor)), confirmation: confirmation(amountMinor, confirmedMinor), timing }); };
    add("vip_remedies", supportOnly ? "Ticket remedies" : "VIP soundcheck remedies", remedyAt ?? authorizedAt, candidate.cost.remedyMinor, money ? supportOnly ? money.settledTicketRefundMinor : money.vipRemedyMinor : 0, approved && remedyAt ? "Committed when the plan was approved" : "Committed on approval; shown at the plan’s authorization milestone");
    add("rental_fee", `${offer?.supplier ?? "Supplier"} rental fee`, capturedAt, candidate.cost.rentalMinor, money?.rentalCapturedMinor ?? 0, "Captured after accepted delivery");
    add("projected_overtime", "Projected crew overtime", candidate.patch.crewFinishAt, candidate.cost.overtimeMinor, 0, "Falls due at crew finish; payable only from approved time reports");
    commitments.sort((a, b) => ms(a.at) - ms(b.at));
    if (offer && offer.depositMinor > 0) hold = { label: `${offer.supplier} damage deposit hold`, from: authorizedAt, amountMinor: offer.depositMinor, authorizedMinor: money ? Math.min(offer.depositMinor, Math.max(0, money.authorizedMinor - offer.feeMinor)) : 0, releasedMinor: money?.releasedMinor ?? 0 };
  }
  const commitmentMinor = commitments.reduce((total, row) => total + row.amountMinor, 0);
  return { key, label, candidateId: candidate?.id ?? null, approved, laborMinor, commitmentMinor, totalMinor: laborMinor + commitmentMinor, statedCostMinor: candidate?.cost.totalMinor ?? null, commitments, hold, labor };
}

export function approvedCandidate(show: ShowSnapshot): Candidate | null {
  return show.runs.flatMap(run => run.candidates).find(candidate => candidate.id === show.approvedPlan?.candidateId && candidate.digest === show.approvedPlan.digest) ?? null;
}

/**
 * Baseline run sheet versus the current plan, and optionally a previewed candidate.
 * The end of each curve equals `laborMinor + commitmentMinor`, and `commitmentMinor` equals the
 * plan's stated `cost.totalMinor`; both identities are asserted by tests/cost-curve.test.ts.
 */
export function buildCostCurve(show: ShowSnapshot, preview: Candidate | null = null): CostCurve {
  const first = [...show.sheets].sort((a, b) => a.version - b.version)[0];
  const baselineTasks = (first?.tasks ?? show.tasks).map(task => ({ ...task, start: task.baselineStart, end: task.baselineEnd }));
  const approved = approvedCandidate(show);
  const approvalEvent = approved ? [...show.events].reverse().find(event => event.type === "rescue.approved") : undefined;
  const baseline = plan("baseline", `Baseline run sheet${first ? ` v${first.version}` : ""}`, baselineTasks, show, null, false, null);
  const current = plan("current", approved ? `Approved plan v${show.planVersion} · ${approved.name}` : `Current plan v${show.planVersion}`, show.tasks, show, approved, Boolean(approved), approvalEvent?.fixtureAt ?? null);
  const candidate = preview && preview.id !== approved?.id ? plan("candidate", `Preview · ${preview.name}`, preview.patch.tasks, show, preview, false, null) : null;
  const plans = [baseline, current, ...(candidate ? [candidate] : [])];
  const instants = new Set<number>();
  for (const row of plans) { row.labor.forEach(point => instants.add(point.at)); row.commitments.forEach(item => instants.add(ms(item.at))); if (row.hold) instants.add(ms(row.hold.from)); }
  const ordered = [...instants].sort((a, b) => a - b), startAt = iso(ordered[0] ?? ms(show.clock)), endAt = iso(ordered.at(-1) ?? ms(show.clock));
  const curve: CostCurve = { currency: "USD", zone: show.zone, startAt, endAt, clock: show.clock, baseline, current, candidate, points: [] };
  const holdFrom = (candidate?.hold ?? current.hold)?.from;
  for (const value of ordered) {
    const at = iso(value), steps = plans.some(row => row.commitments.some(item => ms(item.at) === value)) || holdFrom !== undefined && ms(holdFrom) === value;
    const point = (inclusive: boolean): CostCurvePoint => ({ at, baselineMinor: costAt(baseline, at, inclusive), currentMinor: costAt(current, at, inclusive), candidateMinor: candidate ? costAt(candidate, at, inclusive) : null, holdMinor: inclusive ? holdAt(curve, at) : holdFrom !== undefined && ms(holdFrom) < value ? holdAt(curve, at) : 0 });
    if (steps) curve.points.push(point(false));
    curve.points.push(point(true));
  }
  return curve;
}
/** Evenly spaced readings for the accessible table. The final row is always the end of the curve. */
export function sampleCostCurve(curve: CostCurve, stepMinutes = 60): CostCurvePoint[] {
  const rows: CostCurvePoint[] = [], end = ms(curve.endAt);
  const read = (value: number) => { const at = iso(value); rows.push({ at, baselineMinor: costAt(curve.baseline, at), currentMinor: costAt(curve.current, at), candidateMinor: curve.candidate ? costAt(curve.candidate, at) : null, holdMinor: holdAt(curve, at) }); };
  for (let at = ms(curve.startAt); at < end; at += stepMinutes * 60_000) read(at);
  read(end);
  return rows;
}
