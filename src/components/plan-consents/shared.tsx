"use client";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, Clock3, FileCheck2, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import type { ConsentReview, ConsentState } from "@/domain/plan-consents";
import { consentStateText } from "@/domain/plan-consents";
import { Badge, Button } from "../ui";
import type { usePlanConsents } from "./use-plan-consents";

export const consentClock = (value: string, zone = "America/Chicago") => new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
export const consentTimestampLabel = (value: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) + " UTC";
export function ConsentShell({ title, description, reviewer = false, children }: { title: string; description: string; reviewer?: boolean; children: ReactNode }) {
  return <div className="consent-shell"><header className="consent-mast"><span className="consent-wordmark"><span aria-hidden="true">◒</span> OPENING NIGHT</span><span className="consent-mast-label"><LockKeyhole size={13} />{reviewer ? "DEDICATED ARTIST REVIEW" : "PRODUCTION / SEPARATE CONSENT"}</span>{!reviewer && <a className="consent-back" href="/recovery"><ArrowLeft size={14} />Recovery studio</a>}</header><main id="main" className="consent-main"><header className="consent-hero"><span className="eyebrow">THE PERSON WITH THE SAY</span><h1>{title}</h1><p>{description}</p></header>{children}</main><footer className="consent-footer"><ShieldCheck size={15} /><span>A saved consent records a declared decision. Identity, physical work, commercial execution and GO keep their own evidence.</span></footer></div>;
}
export function ConsentStatus({ state }: { state: ConsentState }) { return <Badge tone={state === "committed" || state === "consented" ? "green" : state === "declined" || state === "revoked" ? "red" : "amber"}>{consentStateText[state]}</Badge>; }
export function ConsentChanges({ changes, zone }: { changes: ConsentReview["changes"]; zone: string }) {
  return <div className="consent-changes" role="table" aria-label="Exact artist changes"><div className="consent-change-row consent-change-head" role="row"><span role="columnheader">Call</span><span role="columnheader">Current</span><span role="columnheader">Proposed</span></div>{changes.map(item => <div className="consent-change-row" role="row" key={item.taskId}><strong role="rowheader">{item.name}</strong>{[item.before, item.proposed].map((time, index) => <span role="cell" key={index}>{time ? <><b>{consentClock(time.start, zone)}–{consentClock(time.end, zone)}</b><small>{time.minutes} min</small></> : <em>{index ? "Removed" : "New call"}</em>}</span>)}</div>)}<p>Times in {zone}. This comparison does not establish a physical check-in or completed duty.</p></div>;
}
export function ConsentSource({ review }: { review: ConsentReview }) {
  const source = review.representative.source;
  return <details className="consent-source"><summary><FileCheck2 size={17} /><span>Source for this exact review<strong>{source.title}</strong></span><Badge>{source.source}</Badge></summary><div><p>{source.detail}</p><dl><div><dt>Source identity</dt><dd>{source.id}</dd></div><div><dt>Recorded</dt><dd>{consentTimestampLabel(source.recordedAt)}</dd></div><div><dt>Representative designation</dt><dd>{review.representative.basis}</dd></div></dl></div></details>;
}
export function ConsentReceiptNotice({ client }: { client: ReturnType<typeof usePlanConsents> }) {
  return <div className="consent-feedback" aria-live="polite">
    {client.error && <p className="consent-alert" role="alert"><ShieldCheck size={17} /><span>{client.error}</span></p>}
    {client.receipt && <section className="consent-saved"><Check size={19} /><div><strong>Original receipt confirmed</strong><p>{client.receipt.receipt.result.message}</p><details><summary>Receipt identity</summary><code>{client.receipt.receipt.commandId}</code><code>{client.receipt.receipt.receiptDigest}</code><small>{consentTimestampLabel(client.receipt.receipt.acceptedAt)}</small></details></div></section>}
    {client.pending && !client.ended && <section className="consent-pending"><div><Clock3 size={19} /><h2>Keep the original instruction.</h2></div><p>{"command" in client.pending.envelope ? client.pending.envelope.command.type.replaceAll("_", " ") : client.pending.envelope.decision} · {client.pending.envelope.commandId}</p><p>An uncertain response does not mean the action failed. Read its original receipt before doing anything else.</p><div className="consent-actions"><Button busy={client.busy} onClick={() => void client.check()}><RefreshCw size={15} />Check original result</Button>{client.missing && <Button disabled={client.busy} onClick={() => void client.retry()}>Retry exact instruction <ArrowRight size={14} /></Button>}</div></section>}
  </div>;
}
