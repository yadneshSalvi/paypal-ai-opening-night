"use client";
import { useState } from "react";
import { Check, FileCheck2, RefreshCw } from "lucide-react";
import { formatMoney, localTime } from "@/domain/time";
import type { ApprovedRate, Payable, ReportView, SettlementData, TimeReport } from "@/domain/settlement/contracts";
import { Badge, Button, Modal } from "../ui";
import type { SettlementClient } from "./use-settlement";

export const hours = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
export const money = (minor: number) => formatMoney(minor, true);
export const recordedAt = (value: string) => new Date(value).toLocaleString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) + " UTC";
export function dayLabel(day: string) { return new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }); }
export function Status({ view }: { view: ReportView }) { return <Badge tone={view.status === "approved" ? "green" : view.status === "superseded" ? "muted" : "amber"}>{view.status === "changes_requested" ? "CHANGES REQUESTED" : view.status === "reported" ? "AWAITING REVIEW" : view.status.toUpperCase()}</Badge>; }
export function SettlementFeedback<T extends SettlementData>({ client }: { client: SettlementClient<T> }) {
  const [clear, setClear] = useState(false), [confirmed, setConfirmed] = useState(false);
  return <>
    {client.notice && <p className="settlement-feedback success" role="status"><Check size={16} />{client.notice}</p>}
    {client.error && <p className="settlement-feedback error" role="alert">{client.error}</p>}
    {client.pending && <div className="settlement-recovery" role="status"><strong>{client.busy === "save" ? "Saving your reviewed request…" : "A saved request needs a receipt check."}</strong><p>The exact instructions are retained in this tab. Check the original receipt before creating another request.</p><div className="settlement-actions"><Button disabled={Boolean(client.busy)} onClick={() => void client.refresh()}><RefreshCw size={14} />Check saved receipt</Button><Button disabled={!client.fresh || Boolean(client.busy)} onClick={() => void client.retry()}>Retry the same request</Button><Button variant="ghost" onClick={client.downloadRecovery}>Download recovery file</Button></div></div>}
    {client.storageError && <div className="settlement-recovery" role="alert"><strong>The local recovery record needs attention.</strong><p>{client.storageError}</p><div className="settlement-actions"><Button onClick={client.downloadRecovery}>Download recovery file</Button>{client.damaged ? <Button disabled={!client.fresh || Boolean(client.busy)} onClick={() => { setConfirmed(false); setClear(true); }}>Review local draft</Button> : <Button disabled={Boolean(client.busy)} onClick={() => void client.refresh()}>Check saved receipt</Button>}</div></div>}
    {clear && <Modal title="Review the unreadable local draft" onClose={() => setClear(false)}><div className="settlement-form"><p>Download the recovery file and review the retained history below. The original request may already have a receipt. Clearing this local draft never changes a server record.</p><label className="settlement-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I checked the retained history and want to clear this local draft.</label><Button variant="primary" disabled={!confirmed || !client.fresh || Boolean(client.busy)} onClick={() => void client.clearDamaged().then(() => setClear(false))}>Check history and clear local draft</Button></div></Modal>}
  </>;
}
export function ReportIntervals({ report }: { report: TimeReport }) {
  return <div className="settlement-intervals">{report.intervals.map((interval, index) => <div key={index}><span>{localTime(interval.start)}–{localTime(interval.end)} <small>{new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", day: "numeric", month: "short" }).format(new Date(interval.end))} · Chicago</small></span><span>{interval.unpaidMinutes ? `${interval.unpaidMinutes} min unpaid` : "No unpaid break reported"}</span></div>)}</div>;
}
export function RateDetails({ rate }: { rate: Pick<ApprovedRate, "hourlyMinor" | "overtimeHourlyMinor" | "regularMinutes" | "version" | "effectiveFrom"> }) {
  return <div className="settlement-rate-details"><div><span>Regular hourly</span><strong>{money(rate.hourlyMinor)}</strong></div><div><span>Overtime hourly</span><strong>{money(rate.overtimeHourlyMinor)}</strong></div><div><span>Regular per service day</span><strong>{hours(rate.regularMinutes)}</strong></div><p>Version {rate.version} · effective {dayLabel(rate.effectiveFrom)} · USD</p></div>;
}
export function PayableHistory({ payables }: { payables: Payable[] }) {
  return <div className="settlement-payables">{payables.length === 0 ? <p className="settlement-muted">No approved liability yet.</p> : [...payables].reverse().map(payable => <article key={payable.id}><div><FileCheck2 size={18} /><span><strong>{payable.previousPayableId ? payable.deltaMinor < 0 ? "Credit adjustment" : payable.deltaMinor === 0 ? "Reviewed correction · no amount change" : "Additional liability" : "Approved work liability"}</strong><small>{recordedAt(payable.recordedAt)}</small></span><b className={payable.deltaMinor < 0 ? "settlement-credit" : ""}>{payable.deltaMinor > 0 && payable.previousPayableId ? "+" : ""}{money(payable.deltaMinor)}</b></div><p>{hours(payable.calculation.workedMinutes)} reviewed · resulting day liability {money(payable.calculation.totalMinor)}</p><details><summary>Original receipt and calculation</summary><dl><dt>Regular</dt><dd>{hours(payable.calculation.regularMinutes)} · {money(payable.calculation.regularMinor)}</dd><dt>Overtime</dt><dd>{hours(payable.calculation.overtimeMinutes)} · {money(payable.calculation.overtimeMinor)}</dd><dt>Previous liability</dt><dd>{money(payable.previousLiabilityMinor)}</dd></dl><p>{payable.detail}</p><small>Half-up rounding per regular and overtime component. Payment is separate.</small><code>{payable.id}</code><code>{payable.reviewDigest}</code></details></article>)}</div>;
}
