"use client";
/** Persistent production header pieces. Every value is a read model of stored, confirmed state: nothing here issues a cue, moves money or infers work. */
import Link from "next/link";
import { ArrowUpRight, Clock3 } from "lucide-react";
import type { ConsoleData, ReadinessGate } from "@/domain/contracts";
import { financialSummary } from "@/domain/finance";
import { countdown, formatMoney, localTime } from "@/domain/time";
import { Badge } from "./ui";
import { currentGo, currentHouseOpen, currentReadiness } from "./presentation/model";

/** Guided demonstration rehearsals replay payment outcomes. The flag is optional on older read models. */
export const isDemonstration = (data: Pick<ConsoleData, "controlledQa">) => (data as { demonstration?: boolean }).demonstration === true;
export const DEMONSTRATION_NOTICE = "GUIDED DEMONSTRATION · payment outcomes are replayed; no PayPal request is made";

export type CueLight = "standby" | "progress" | "go";
export interface HeaderSegment { id: string; label: string; value: string; complete: boolean; href: string; name: string }
export interface HeaderCounter { id: "refunds" | "crew"; label: string; done: number; total: number; href: string; name: string }
export interface ExposureMeter { kind: "captured" | "committed"; amountMinor: number; amount: string; label: string; qualifier: string | null; href: string; name: string }
export interface HeaderModel {
  title: string; planVersion: number; approvedAt: string | null; versionLabel: string; versionName: string;
  doorsIn: string; doorsAt: string; zone: string; light: CueLight; word: string; lightName: string;
  /** Null when no readiness report was computed for this exact revision. Never substituted. */
  segments: HeaderSegment[] | null; complete: number; total: number;
  exposure: ExposureMeter; counters: HeaderCounter[]; rehearsalBadge: string;
}

const ratio = (gate: ReadinessGate | undefined) => { const match = gate && /^(\d+) \/ (\d+)\b/.exec(gate.value); return match ? { done: Number(match[1]), total: Number(match[2]) } : null; };
const zoneLabel = (instant: string, zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(new Date(instant)).find(part => part.type === "timeZoneName")?.value ?? zone;

/** The approved candidate must still be the stored decision: same identifier and same digest. */
export function approvedCandidate(data: ConsoleData) {
  const plan = data.show.approvedPlan;
  return plan ? data.show.runs.flatMap(run => run.candidates).find(row => row.id === plan.candidateId && row.digest === plan.digest) ?? null : null;
}

export function exposureMeter(data: ConsoleData): ExposureMeter {
  const demonstration = isDemonstration(data), controlled = Boolean(data.controlledQa), candidate = approvedCandidate(data);
  if (candidate) {
    const amount = formatMoney(candidate.cost.totalMinor), qualifier = demonstration ? "replayed payments" : controlled ? "controlled inputs" : null;
    return { kind: "committed", amountMinor: candidate.cost.totalMinor, amount, label: "committed", qualifier, href: "/execution", name: `${amount} committed: approved incremental recovery items for ${candidate.name}${qualifier ? ` (${qualifier})` : ""}. An approval is not a payment. Open the execution evidence.` };
  }
  const finance = financialSummary(data.show), amount = formatMoney(finance.grossCapturedMinor);
  const label = demonstration ? "replayed captures" : controlled ? "controlled captures" : "captured";
  return { kind: "captured", amountMinor: finance.grossCapturedMinor, amount, label, qualifier: "at stake", href: "/box-office", name: `${amount} ${demonstration ? "replayed gross captures; no PayPal request is made" : controlled ? "controlled gross captures; no provider qualification" : "verified gross captured"}, at stake. Gross is not profit. Open the capture ledger.` };
}

/** Background counters exist only for a stored obligation that the current report still shows incomplete. */
export function headerCounters(data: ConsoleData): HeaderCounter[] {
  const report = currentReadiness(data), { show } = data;
  if (!report || currentGo(data)) return [];
  const counters: HeaderCounter[] = [], candidate = approvedCandidate(data), sheet = show.sheets.at(-1);
  const refunds = report.gates.find(gate => gate.id === "refunds"), refundRatio = ratio(refunds);
  const remedyStored = Boolean(show.cancellationDecision) || Boolean(candidate?.patch.canceledPerk) || show.financialEvidence.some(row => row.kind === "refund" && (row.purpose === "vip_remedy" || row.purpose === "event_remedy"));
  if (refunds && refundRatio && !refunds.complete && remedyStored) { const label = show.cancellationDecision ? "Remedies" : "VIP refunds"; counters.push({ id: "refunds", label, ...refundRatio, href: refunds.href, name: `${label}: ${refundRatio.done} of ${refundRatio.total} confirmed in the current readiness report. Open the remedy evidence.` }); }
  const crew = report.gates.find(gate => gate.id === "crew"), crewRatio = ratio(crew);
  const published = Boolean(show.approvedPlan && sheet && sheet.candidateId === show.approvedPlan.candidateId);
  if (crew && crewRatio && !crew.complete && published) counters.push({ id: "crew", label: "Crew", ...crewRatio, href: crew.href, name: `Crew: ${crewRatio.done} of ${crewRatio.total} current-sheet acknowledgments. Open the crew readback evidence.` });
  return counters;
}

export function headerModel(data: ConsoleData): HeaderModel {
  const { show } = data, report = currentReadiness(data), go = currentGo(data), houseOpen = currentHouseOpen(data), demonstration = isDemonstration(data);
  const approval = show.approvedPlan ? show.events.findLast(row => row.type === "rescue.approved" && row.at === show.approvedPlan!.approvedAt) : null;
  const approvedAt = approval ? localTime(approval.fixtureAt) : null;
  const light: CueLight = go ? "go" : show.approvedPlan ? "progress" : "standby";
  const word = houseOpen ? "HOUSE OPEN" : go ? "GO" : light === "progress" ? "IN PROGRESS" : "STANDBY";
  const segments = report ? report.gates.map(gate => ({ id: gate.id, label: gate.label, value: gate.value, complete: gate.complete, href: gate.href, name: `${gate.label}: ${gate.complete ? "clear" : "pending"} · ${gate.value}` })) : null;
  const complete = segments?.filter(row => row.complete).length ?? 0, total = segments?.length ?? 0;
  return {
    title: show.title, planVersion: show.planVersion, approvedAt,
    versionLabel: show.approvedPlan ? `v${show.planVersion} · approved${approvedAt ? " " + approvedAt : ""}` : `PLAN v${show.planVersion}`,
    versionName: show.approvedPlan ? `Plan version ${show.planVersion}, approved${approvedAt ? ` at ${approvedAt} scenario time` : ""}. Open the approved decision.` : `Plan version ${show.planVersion}. No recovery decision is approved. Open the recovery studio.`,
    doorsIn: countdown(show.clock, show.doorsAt), doorsAt: localTime(show.doorsAt), zone: zoneLabel(show.doorsAt, show.zone), light, word,
    lightName: `Cue light ${light === "go" ? "green" : light === "progress" ? "amber" : "red"}: ${word}. ${report ? `${complete} of ${total} DOORS gates clear` : "Current readiness has not been read"}. Open the execution evidence.`,
    segments, complete, total, exposure: exposureMeter(data), counters: headerCounters(data),
    rehearsalBadge: demonstration ? "GUIDED DEMONSTRATION" : "SANDBOX REHEARSAL",
  };
}

/** Left: show identity and the plan version with its approval time when a decision is stored. */
export function HeaderIdentity({ data }: { data: ConsoleData }) {
  const model = headerModel(data);
  return <><span className="header-show" title={model.title}>{model.title}</span><span className="header-separator" /><Link className="header-version" href="/recovery" aria-label={model.versionName}>{model.versionLabel}</Link><Badge tone="amber">{model.rehearsalBadge}</Badge></>;
}

/** Centre: doors countdown in display numerals with the venue zone and the worded cue light. */
export function HeaderCue({ data }: { data: ConsoleData }) {
  const model = headerModel(data);
  return <div className="header-centre">
    <Link className="clock-chip header-countdown" href="/plan" aria-label={`Doors in ${model.doorsIn}. Doors ${model.doorsAt} ${model.zone}. Open the production plan.`}><Clock3 size={14} aria-hidden="true" /> DOORS IN <b>{model.doorsIn}</b><small>{model.zone}</small></Link>
    <Link className={`cue-badge ${model.light === "go" ? "green" : model.light === "progress" ? "amber" : "red"}`} href="/execution" aria-label={model.lightName} data-cue-light={model.light}><span className="tiny-dot" />{model.word}<span>{model.complete}/{model.total}</span></Link>
  </div>;
}

/** Right: exposure meter from the stored ledgers and one readiness segment per current DOORS gate. */
export function HeaderStakes({ data }: { data: ConsoleData }) {
  const model = headerModel(data), meter = model.exposure;
  return <>
    <Link className="exposure-meter" href={meter.href} aria-label={meter.name} data-exposure={meter.kind}><b>{meter.amount}</b><span>{meter.label}</span>{meter.qualifier && <small>· {meter.qualifier}</small>}</Link>
    <ReadinessStrip data={data} />
  </>;
}

export function ReadinessStrip({ data, className = "" }: { data: ConsoleData; className?: string }) {
  const model = headerModel(data);
  if (!model.segments) return <Link className={`readiness-strip unread ${className}`} href="/presentation" aria-label="Current DOORS readiness has not been read for this revision. Open the current production read.">READINESS UNREAD</Link>;
  return <div className={`readiness-strip ${className}`} role="group" aria-label={`DOORS readiness: ${model.complete} of ${model.total} gates clear`}><ol>{model.segments.map(segment => <li key={segment.id}><Link href={segment.href} className={`readiness-segment ${segment.complete ? "complete" : "pending"}`} data-gate={segment.id} data-state={segment.complete ? "clear" : "pending"} aria-label={segment.name} title={segment.name} /></li>)}</ol></div>;
}

/** Docked under the strip: batch counters while incomplete, then the gross capture evidence link. */
export function HeaderDock({ data }: { data: ConsoleData }) {
  const model = headerModel(data), finance = financialSummary(data.show), demonstration = isDemonstration(data);
  return <div className="header-dock">
    {model.counters.map(counter => <Link key={counter.id} className="header-counter" href={counter.href} aria-label={counter.name} data-counter={counter.id}>{counter.label} <b className="mono">{counter.done}/{counter.total}</b></Link>)}
    {model.exposure.kind === "committed" && <Link className="header-dock-committed" href={model.exposure.href} aria-label={model.exposure.name}><b>{model.exposure.amount}</b> committed</Link>}
    <Link href="/box-office">{demonstration ? "Replayed captures" : data.controlledQa ? "Controlled gross captures" : "Verified gross captured"} <b>{formatMoney(finance.grossCapturedMinor)}</b><ArrowUpRight size={12} /></Link>
  </div>;
}

/** The one notice that explains what kind of rehearsal the viewer is reading. */
export function RehearsalNotice({ data }: { data: ConsoleData }) {
  if (!data.controlledQa) return null;
  if (isDemonstration(data)) return <div className="crew-warning qa-fixture-notice demonstration-notice"><strong>{DEMONSTRATION_NOTICE}</strong><p>Each payment record in this rehearsal is a replayed outcome and keeps that label. Approvals, readbacks and cues are still recorded through the ordinary application paths; none of them establishes an actual PayPal transaction or physical work.</p></div>;
  return <div className="crew-warning qa-fixture-notice"><strong>{data.controlledPlanningQa ? "ISOLATED PLANNING QA · CONTROLLED AI INPUTS" : "ISOLATED CREW QA · CONTROLLED READINESS INPUTS"}</strong><p>{data.controlledPlanningQa ? "Fictional production sources and controlled response fixtures exercise the real planning services. Model and payment providers are disabled. No financial or crew completion is established by this rehearsal." : "Supplier confirmation, accepted delivery, rental authorization and fee capture, and 38 refund outcomes are controlled test inputs. Provider actions are disabled. Actual provider qualification remains separate."}</p></div>;
}
