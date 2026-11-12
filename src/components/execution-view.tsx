"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight, ArrowUpRight, Check, ChevronRight, Clock3 } from "lucide-react";
import { currentActual } from "@/domain/finance";
import { supplierIsConfirmed } from "@/domain/supplier-contracts";
import { atVenue, compareInstants, formatMoney, localTime } from "@/domain/time";
import type { Command } from "@/domain/commands";
import type { ViewProps } from "./production-console";
import { Badge, Button, PageHeading, SectionHeading } from "./ui";
import { PaymentDesk } from "./payment-desk";
import { SupplierExecutionDesk } from "./supplier-network";
import { CrewDutyDesk, CrewProtocolNotice, CueExecutionDesk } from "./crew-production";
import { isDemonstration } from "./production-header";

const clockChoices: Extract<Command, { type: "advance" }>["time"][] = ["16:10", "17:15", "17:20", "18:15", "18:35", "18:45", "19:00", "19:35", "20:00", "20:10", "20:40", "20:45", "22:15", "23:30"];
export function ExecutionView({ data, onData, run, busy }: ViewProps) {
  const { show } = data, demo = isDemonstration(data);
  const [choice, setChoice] = useState(clockChoices[1]);
  const actual = currentActual(show).filter(event => event.planVersion === show.planVersion);
  const candidate = show.runs.flatMap(rescue => rescue.candidates).find(item => item.id === show.approvedPlan?.candidateId);
  const offer = show.offers.find(item => item.id === candidate?.patch.offerId);
  const authorized = actual.find(event => event.kind === "authorization" && event.purpose === "rental" && event.amountMinor === (offer ? offer.feeMinor + offer.depositMinor : show.approvedPlan?.commercialCapMinor));
  const captured = actual.find(event => event.kind === "capture" && event.purpose === "rental" && event.parentId === authorized?.providerResourceId && event.amountMinor === offer?.feeMinor);
  const released = actual.find(event => event.kind === "void" && event.purpose === "deposit" && event.parentId === authorized?.providerResourceId);
  const confirmed = supplierIsConfirmed(show);
  const published = Boolean(show.approvedPlan && show.sheets.at(-1)?.candidateId === show.approvedPlan.candidateId && show.sheets.at(-1)?.planRevision === show.planVersion);
  const doors = data.readiness.find(report => report.scope === "DOORS")!;
  const future = clockChoices.filter(time => compareInstants(atVenue(time, show.showDate), show.clock) > 0);
  const time = future.includes(choice) ? choice : future[0];
  return <>
    <PageHeading eyebrow="PRODUCTION / EXECUTION DESK" title="Earn the green light." description="Current evidence clears each gate. The assigned stage manager and front-of-house manager make their separate calls." actions={<Link className="button secondary" href="/recovery">Review approved decision <ArrowUpRight size={15} /></Link>} />
    <div className="execution-banner"><div><span className="eyebrow">CURRENT RECOVERY DECISION</span><h2>{candidate?.name ?? "No recovery plan approved"}</h2><p>{candidate ? `${formatMoney(candidate.cost.totalMinor)} in incremental recovery items · ${formatMoney(show.approvedPlan!.commercialCapMinor)} rental authorization limit` : "Compare the recovery alternatives and approve the exact schedule and commercial limits."}</p></div><Badge tone={captured && published ? "green" : "amber"}>{!candidate ? "DECISION REQUIRED" : captured && published ? demo ? "REPLAYED CAPTURE · PUBLISHED CALLS" : data.controlledQa ? "CONTROLLED FEE · PUBLISHED CALLS" : "CURRENT FEE & CALLS VERIFIED" : "EXECUTION IN PROGRESS"}</Badge></div>
    <CrewProtocolNotice data={data} run={run} busy={busy} />
    {data.controlledQa && <div className="crew-warning qa-fixture-notice"><strong>{demo ? "GUIDED DEMONSTRATION · REPLAYED CAPTURES" : "CONTROLLED SUPPLIER SERVICES"}</strong><p>{demo ? "Payment outcomes are replayed; no PayPal request is made. Quotes and equipment holds use the local supplier services, and each readiness gate retains its own evidence. A hold does not establish payment, delivery or physical work." : "Quotes and equipment holds use the local supplier services. Each readiness gate retains its own evidence. PayPal checkout and provider actions are disabled; a hold does not establish payment, delivery or physical work."}</p></div>}
    <SupplierExecutionDesk data={data} onChange={onData} />
    {!data.controlledQa && <PaymentDesk data={data} onChange={onData} />}
    <div className="execution-layout"><section className="readiness-panel"><div className="readiness-heading"><div><span className="eyebrow">CUE SCOPE 01</span><h2>DOORS</h2><span className="mono">{localTime(show.doorsAt)} CST</span></div><div className="readiness-count">{doors.gates.filter(gate => gate.complete).length}<span>/ {doors.gates.length}</span></div></div><div className="readiness-list">{doors.gates.map((gate, index) => <details className={gate.complete ? "complete" : ""} key={gate.id}><summary><span className="readiness-check">{gate.complete ? <Check size={15} /> : String(index + 1).padStart(2, "0")}</span><span><b>{gate.label}</b><small>{gate.value}</small></span><ChevronRight size={15} /></summary><div className="gate-explanation"><p>{gate.reason}</p>{gate.evidenceIds.length > 0 && <span className="mono">{gate.evidenceIds.length} source records linked</span>}<Link href={gate.href}>Open responsible desk <ArrowUpRight size={12} /></Link></div></details>)}</div><div className="go-control"><div><span className={`cue-lamp ${doors.ready ? "ready" : ""}`} /><span><b>{doors.ready ? "READY FOR REVIEW" : "STANDBY"}</b><small>{doors.ready ? "The assigned person must call the cue" : "Resolve every current blocker"}</small></span></div><a href="#cue-execution" className="button secondary">Open cue desks <ArrowRight size={14} /></a></div></section>
      <div className="execution-secondary"><section className="execution-sequence"><SectionHeading label="COMMERCIAL CHAIN" title="Secure, accept, capture." />
        <div className="saga-step"><span className={show.approvedPlan ? "done" : ""}>{show.approvedPlan ? <Check size={14} /> : "1"}</span><div><h3>Approve the bounded decision</h3><p>{show.approvedPlan ? `Decision ${show.approvedPlan.digest.slice(0, 12)}… · recorded` : "Current proposal, amounts, consent, and policy version."}</p></div></div>
        <div className="saga-step"><span className={authorized ? "done" : ""}>{authorized ? <Check size={14} /> : "2"}</span><div><h3>Authorize the supplier rental</h3><p>{offer ? `${formatMoney(offer.feeMinor)} rental fee + ${formatMoney(offer.depositMinor)} refundable damage hold. ${authorized ? (demo ? "Replayed authorization; no PayPal request is made." : data.controlledQa ? "Authorization is a controlled fixture input." : "The original authorization is currently verified.") : "Supplier checkout and provider verification are required."}` : "The approved supplier offer determines the fee and hold."}</p><Badge tone="blue">{demo ? "REPLAYED AUTHORIZATION" : data.controlledQa ? "CONTROLLED RENTAL INPUT" : "SEPARATE SANDBOX MERCHANT"}</Badge></div></div>
        <div className="saga-step"><span className={published ? "done" : ""}>{published ? <Check size={14} /> : "3"}</span><div><h3>Confirm equipment & publish calls</h3><p>{published ? `Run sheet v${show.sheets.at(-1)!.version} published. Personal readbacks remain separate.` : confirmed ? "Supplier confirmation is recorded. Verified authorization unlocks publication." : "Current supplier confirmation and verified authorization unlock versioned publication."}</p><Button disabled={!show.approvedPlan || !authorized || !confirmed || published || Boolean(busy)} busy={busy === "publish"} onClick={() => void run({ type: "publish" })}>{published ? "Current calls published" : "Publish approved calls"} <ArrowRight size={13} /></Button></div></div>
        <div className="saga-step"><span className={captured ? "done" : ""}>{captured ? <Check size={14} /> : "4"}</span><div><h3>Accept delivery & capture the fee</h3><p>{captured ? `${formatMoney(captured.amountMinor)} ${demo ? "replayed capture; no PayPal request is made." : data.controlledQa ? "fee capture is a controlled fixture input." : "fee capture is currently verified."} ${released ? "The return hold closure is also recorded." : "Return inspection and hold closure remain separate."}` : "The exact fee capture follows the signed delivery and condition acceptance. The damage hold closes after return inspection."}</p></div></div>
      </section><section className="fixture-clock-panel"><div><Clock3 size={19} /><h3>Advance the rehearsal clock</h3></div><p>Time advances the labeled scenario. It never creates a signoff, payment, acknowledgment, or performance cue.</p><div className="clock-controls"><select aria-label="Advance fixture to" value={time ?? ""} disabled={!time || Boolean(busy)} onChange={event => setChoice(event.target.value as typeof choice)}>{future.length ? future.map(option => <option key={option}>{option}</option>) : <option value="">Final clock reached</option>}</select><span>CST</span><Button disabled={!time || Boolean(busy)} onClick={() => { if (time) void run({ type: "advance", time }); }}>Advance <ArrowRight size={14} /></Button></div></section></div>
    </div>
    <div id="cue-execution"><CueExecutionDesk data={data} /></div><CrewDutyDesk data={data} run={run} busy={busy} />
  </>;
}
