"use client";
import { useState } from "react";
import { ArrowLeft, ArrowRight, Clock3, History, Plus, RefreshCw, Trash2 } from "lucide-react";
import { atZone, localTime, minutesBetween } from "@/domain/time";
import { timeReportCommandSchema, type PersonalSettlementData, type TimeReport, type TimeReportCommand } from "@/domain/settlement/contracts";
import { Badge, Button, EmptyState, Modal } from "../ui";
import { dayLabel, hours, money, PayableHistory, RateDetails, recordedAt, ReportIntervals, SettlementFeedback, Status } from "./shared";
import { useSettlement, type SettlementClient, type SettlementTransport } from "./use-settlement";

interface HoursProps { actorId: string; personId: string; request: SettlementTransport; onSaved: () => void }
export function PersonalHours({ actorId, personId, request, onSaved }: HoursProps) {
  const client = useSettlement<PersonalSettlementData>({ scope: "personal", actorId, ownerId: personId }, request, onSaved);
  const [editor, setEditor] = useState<{ report: TimeReport | null } | null>(null), [history, setHistory] = useState(false);
  const data = client.data, person = data?.personal, latestRate = person?.rates.at(-1);
  const availableDay = data?.production.allowedDays.find(day => !person?.reports.some(view => view.current && view.report.serviceDay === day));
  return <section className="settlement-personal" aria-labelledby="personal-hours-heading">
    <div className="settlement-heading"><div><span className="eyebrow">YOUR WORK / YOUR RECORD</span><h2 id="personal-hours-heading">Hours with a clear receipt.</h2></div><Button ariaLabel="Refresh your hours" disabled={Boolean(client.busy)} onClick={() => void client.refresh()}><RefreshCw size={16} /></Button></div>
    <p>Report the hours you completed in this rehearsal. The producer reviews your report and the agreed rate before creating a payable.</p>
    <SettlementFeedback client={client} />
    {!data ? <EmptyState icon={<Clock3 size={24} />} title={client.busy ? "Opening your private hours…" : "Your hours are temporarily unavailable."}>Reconnect and refresh to read your own reports and approvals.</EmptyState> : <>
      <div className="settlement-personal-total"><span><small>APPROVED LIABILITY</small><strong>{money(person!.approvedBalanceMinor)}</strong></span><Badge tone={person!.pendingReports ? "amber" : "muted"}>{person!.pendingReports} AWAITING REVIEW</Badge><p>Approved work is separate from payment. A payout needs its own exact recipient review and verified item receipt.</p></div>
      <div className="settlement-report-intro"><p>Scenario now: <strong>{localTime(data.production.clock)} Chicago time</strong>. Reports can include only time already completed on this production clock.</p><Button variant="primary" disabled={client.blocked || !availableDay || !data.production.sheet} onClick={() => setEditor({ report: null })}><Plus size={15} />Report hours</Button></div>
      {!client.fresh && <p className="settlement-feedback">Reconnect and refresh before submitting or correcting hours. Saved server records remain available.</p>}
      <div className="settlement-section-head"><h3>Your time reports</h3><Button variant="ghost" onClick={() => setHistory(!history)}><History size={15} />{history ? "Current reports" : "Include corrections"}</Button></div>
      {person!.reports.length === 0 ? <EmptyState icon={<Clock3 size={22} />} title="Your schedule is a reference.">No hours have been reported. A published call never becomes a time report automatically.</EmptyState> : <div className="settlement-reports">{person!.reports.filter(view => history || view.current).slice().reverse().map(view => <article className="settlement-report" key={view.report.id}>
        <div className="settlement-card-heading"><div><span className="eyebrow">{dayLabel(view.report.serviceDay)} · REPORT v{view.report.version}</span><h3>{hours(view.report.minutes)} reported</h3></div><Status view={view} /></div>
        <ReportIntervals report={view.report} /><p>{view.report.detail}</p>
        {view.changeRequest && <div className="settlement-recovery"><strong>Producer’s request</strong><p>{view.changeRequest.detail}</p></div>}
        {view.payable && <p className="settlement-approved-line">Reviewed day liability {money(view.payable.calculation.totalMinor)} · payment separate</p>}
        <details><summary>Report attribution and referenced calls</summary><p>Received {recordedAt(view.report.recordedAt)} through your personal capability. Sheet v{view.report.sheet.version}, plan v{view.report.sheet.planVersion}. Controlled reporting does not prove physical attendance.</p><ul>{view.report.sheet.calls.map(call => <li key={call.id}>{call.name} · {localTime(call.start)}–{localTime(call.end)}</li>)}</ul><code>{view.report.id}</code></details>
        {view.current && <Button disabled={client.blocked} onClick={() => setEditor({ report: view.report })}>Correct this report<ArrowRight size={14} /></Button>}
      </article>)}</div>}
      <div className="settlement-section-head"><h3>Approved rate agreement</h3>{latestRate && <Badge tone="blue">VERSION {latestRate.version}</Badge>}</div>
      {latestRate ? <div className="settlement-rate-card"><RateDetails rate={latestRate} /><p>{latestRate.agreement}</p><small>Recorded {recordedAt(latestRate.recordedAt)}. An earlier report retains its original approved rate.</small>{person!.rates.length > 1 && <details><summary>Earlier rate versions</summary>{person!.rates.slice(0, -1).reverse().map(rate => <div key={rate.id}><RateDetails rate={rate} /><p>{rate.agreement}</p></div>)}</details>}</div> : <p className="settlement-muted">The producer has not approved a rate agreement for you. Planning estimates do not authorize crew pay.</p>}
      <div className="settlement-section-head"><h3>Your approved liabilities</h3></div><PayableHistory payables={person!.payables} />
    </>}
    {editor && data && <Modal title={editor.report ? `Correct ${dayLabel(editor.report.serviceDay)} hours` : "Report completed rehearsal hours"} dismissible={client.busy !== "save"} onClose={() => setEditor(null)}><ReportEditor key={editor.report?.id ?? "new"} client={client} data={data} original={editor.report} initialDay={availableDay ?? data.production.showDate} onDone={() => setEditor(null)} /></Modal>}
  </section>;
}

function localInput(instant: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const get = (key: string) => parts.find(part => part.type === key)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
interface IntervalInput { start: string; end: string; unpaid: string }
function ReportEditor({ client, data, original, initialDay, onDone }: { client: SettlementClient<PersonalSettlementData>; data: PersonalSettlementData; original: TimeReport | null; initialDay: string; onDone: () => void }) {
  const [day, setDay] = useState(original?.serviceDay ?? initialDay), [intervals, setIntervals] = useState<IntervalInput[]>(original ? original.intervals.map(item => ({ start: localInput(item.start), end: localInput(item.end), unpaid: String(item.unpaidMinutes) })) : [{ start: "", end: "", unpaid: "0" }]);
  const [detail, setDetail] = useState(""), [confirmed, setConfirmed] = useState(false), [validation, setValidation] = useState<string | null>(null);
  const [review, setReview] = useState<{ command: TimeReportCommand; revision: number; productionRevision: number; minutes: number; unpaid: number } | null>(null);
  const update = (index: number, field: keyof IntervalInput, value: string) => setIntervals(items => items.map((item, ordinal) => ordinal === index ? { ...item, [field]: value } : item));
  const stale = Boolean(review && (review.revision !== data.revision || review.productionRevision !== data.productionRevision));
  function prepare() {
    try {
      setValidation(null);
      const latest = data.personal.reports.find(view => view.current && view.report.serviceDay === day)?.report.id ?? null;
      if (latest !== (original?.id ?? null)) throw new Error("This service day has a newer report. Close this form and open the current report to correct it.");
      if (!data.production.sheet) throw new Error("A published run sheet is required before reporting hours.");
      const work = intervals.map(item => {
        if (!/^\d+$/.test(item.unpaid)) throw new Error("Enter unpaid break minutes as a whole number.");
        const parse = (input: string) => { const [date, time] = input.split("T"); if (!date || !time) throw new Error("Choose a start and finish for every interval."); return atZone(date, time, data.production.zone); };
        return { start: parse(item.start), end: parse(item.end), unpaidMinutes: Number(item.unpaid) };
      });
      const command = timeReportCommandSchema.safeParse({ type: "report_time", serviceDay: day, replacesId: original?.id ?? null, sheetVersion: data.production.sheet.version, sheetDigest: data.production.sheet.digest, intervals: work, detail, confirmed: true });
      if (!command.success) throw new Error("Complete the intervals and add an explanation of at least 12 characters.");
      let previousEnd = -Infinity, minutes = 0;
      for (const interval of work) { const gross = minutesBetween(interval.start, interval.end); if (gross <= interval.unpaidMinutes || Date.parse(interval.start) < previousEnd) throw new Error("Use ordered intervals with positive work after unpaid breaks."); if (Date.parse(interval.end) > Date.parse(data.production.clock)) throw new Error("Report only time completed by the current production scenario clock."); minutes += gross - interval.unpaidMinutes; previousEnd = Date.parse(interval.end); }
      setReview({ command: command.data, revision: data.revision, productionRevision: data.productionRevision, minutes, unpaid: work.reduce((sum, item) => sum + item.unpaidMinutes, 0) }); setConfirmed(false);
    } catch (cause) { setValidation(cause instanceof Error ? cause.message : "Check each local date and time."); }
  }
  return <div className="settlement-form">
    <p>Reporting as <strong>{data.personal.person.name}</strong>. Times use America/Chicago. Scenario now {localTime(data.production.clock)}; the server also records when it receives your submission.</p>
    {!review ? <>
      <label>Service day<select autoFocus value={day} disabled={Boolean(original)} onChange={event => setDay(event.target.value)}>{data.production.allowedDays.map(value => <option key={value} value={value}>{dayLabel(value)} · {value}</option>)}</select></label>
      {intervals.map((interval, index) => <fieldset className="settlement-interval-input" key={index}><legend>Work interval {index + 1}</legend><div className="settlement-form-grid"><label>Start · Chicago<input type="datetime-local" step="60" value={interval.start} onChange={event => update(index, "start", event.target.value)} /></label><label>Finish · Chicago<input type="datetime-local" step="60" value={interval.end} onChange={event => update(index, "end", event.target.value)} /></label><label>Unpaid break minutes<input inputMode="numeric" type="number" min="0" max="1439" step="1" value={interval.unpaid} onChange={event => update(index, "unpaid", event.target.value)} /></label>{intervals.length > 1 && <Button variant="ghost" ariaLabel={`Remove work interval ${index + 1}`} onClick={() => setIntervals(items => items.filter((_, ordinal) => ordinal !== index))}><Trash2 size={15} />Remove interval</Button>}</div></fieldset>)}
      <Button disabled={intervals.length >= 8} onClick={() => setIntervals(items => [...items, { start: "", end: "", unpaid: "0" }])}><Plus size={15} />Add another interval</Button>
      <label>{original ? "Why are you correcting these hours?" : "What work are you reporting?"}<textarea rows={4} maxLength={1200} value={detail} onChange={event => setDetail(event.target.value)} placeholder="Describe the work and any difference from your published calls." /></label>
      {validation && <p className="settlement-feedback error" role="alert">{validation}</p>}
      <Button variant="primary" disabled={client.blocked} onClick={prepare}>Review reported hours<ArrowRight size={15} /></Button>
    </> : <>
      <div className="settlement-review-total"><span>{dayLabel(day)} · {original ? `CORRECTION TO REPORT v${original.version}` : "NEW REPORT"}</span><strong>{hours(review.minutes)}</strong><small>{review.unpaid} unpaid minutes excluded · sheet v{review.command.sheetVersion}</small></div>
      <div className="settlement-intervals">{review.command.intervals.map((interval, index) => <div key={index}><span>{localInput(interval.start).replace("T", " ")} → {localInput(interval.end).replace("T", " ")}</span><span>{interval.unpaidMinutes} min unpaid</span></div>)}</div><p>{review.command.detail}</p>
      {original && <p className="settlement-muted">The previous report and every approved payable remain in the history. A producer must separately review the correction and any amount difference.</p>}
      <label className="settlement-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I reviewed these reported hours through my assigned fictional identity. This is a controlled rehearsal record.</label>
      {stale && <p className="settlement-feedback error" role="alert">The production or hours history changed during review. Return to the form and review the current record again.</p>}
      {client.error && <p className="settlement-feedback error" role="alert">{client.error}</p>}
      {client.pending && <p className="settlement-feedback">This exact request is saved. Close this dialog to check or recover its original receipt.</p>}
      <div className="settlement-actions"><Button disabled={Boolean(client.busy || client.pending)} onClick={() => { setReview(null); setConfirmed(false); }}><ArrowLeft size={15} />Edit hours</Button><Button variant="primary" disabled={client.blocked || stale || !confirmed} busy={client.busy === "save"} onClick={() => void client.submit(review.command, review).then(saved => { if (saved) onDone(); })}>Submit {original ? "correction" : "time report"}</Button></div>
    </>}
  </div>;
}
