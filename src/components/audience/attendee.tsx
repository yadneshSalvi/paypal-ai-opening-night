"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Inbox, LockKeyhole, LogOut, RefreshCw, TriangleAlert } from "lucide-react";
import type { AttendeeView } from "@/domain/audience/contracts";
import { ActualTime, AudienceFrame, Badge, Button, EventInformation, TicketReceipt } from "./shared";
import { parseAttendeeView } from "./validation";
import { DoorsBanner, ReceiptLineStates } from "./doors-banner";
import styles from "./audience.module.css";

export const ATTENDEE_STORAGE = "opening-night:attendee-reader:v1";
const tokenPattern = /^att_[A-Za-z0-9_-]{43}$/;
function savedToken() { try { const saved = JSON.parse(sessionStorage.getItem(ATTENDEE_STORAGE) ?? "null"); return saved?.version === 1 && typeof saved.token === "string" && tokenPattern.test(saved.token) ? saved.token as string : null; } catch { return null; } }
export function AttendeeAccess() {
  const [access, setAccess] = useState<{ token: string; generation: number } | null>(null), [entry, setEntry] = useState(""), [initialized, setInitialized] = useState(false), [data, setData] = useState<AttendeeView | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [stale, setStale] = useState(false), [storageWarning, setStorageWarning] = useState(false), [ended, setEnded] = useState(false);
  const live = useRef(true), generation = useRef(0), lock = useRef(false), token = useRef<string | null>(null), current = useRef<AttendeeView | null>(null), abort = useRef<AbortController | null>(null), heading = useRef<HTMLHeadingElement>(null);
  const clear = useCallback((message: string) => {
    generation.current++; abort.current?.abort(); lock.current = false; current.current = null; setData(null); setBusy(false); setStale(false); setEnded(true); setError(message); setEntry("");
    try { if (savedToken() === token.current) sessionStorage.removeItem(ATTENDEE_STORAGE); } catch { /* Access remains cleared in memory. */ }
  }, []);
  const open = useCallback((value: string) => {
    if (!tokenPattern.test(value)) { clear("This invitation is not a valid private attendee key. Ask the producer for its original attendee link."); return; }
    generation.current++; abort.current?.abort(); current.current = null; token.current = value; setData(null); setError(null); setStale(false); setEnded(false); setEntry(""); setBusy(true);
    try { const raw = JSON.stringify({ version: 1, token: value }); sessionStorage.setItem(ATTENDEE_STORAGE, raw); if (sessionStorage.getItem(ATTENDEE_STORAGE) !== raw) throw new Error("Private storage unavailable"); setStorageWarning(false); } catch { setStorageWarning(true); }
    setAccess({ token: value, generation: generation.current });
  }, [clear]);
  useEffect(() => {
    live.current = true;
    const consume = () => {
      const fragment = window.location.hash.slice(1);
      if (fragment) { history.replaceState(history.state, "", window.location.pathname + window.location.search); open(fragment); }
      else { const saved = savedToken(); if (saved) open(saved); }
      setInitialized(true);
    };
    consume(); window.addEventListener("hashchange", consume);
    return () => { live.current = false; generation.current++; abort.current?.abort(); window.removeEventListener("hashchange", consume); };
  }, [open]);
  const read = useCallback(async (more = false) => {
    if (!access || lock.current || ended) return;
    lock.current = true; const epoch = generation.current, cursor = more ? current.current?.inboxPage.cursor : null, controller = new AbortController(); abort.current = controller;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/attendee" + (cursor ? "?before=" + encodeURIComponent(cursor) : ""), { headers: { authorization: "Bearer " + access.token }, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal });
      if (!live.current || epoch !== generation.current || token.current !== access.token) return;
      if ([401, 403, 410].includes(response.status)) { clear("This private attendee access expired, was revoked, or its issuing access ended. Your ticket content has been cleared. Reopen an authorized original attendee invitation."); return; }
      let raw: unknown; try { raw = await response.json(); } catch { throw new Error("The ticket response was interrupted or unreadable. Refresh to check the original private record."); }
      if (!response.ok) throw new Error(raw && typeof raw === "object" && "error" in raw && typeof raw.error === "string" ? raw.error : "The private ticket service could not complete this read.");
      const next = await parseAttendeeView(raw);
      if (!live.current || epoch !== generation.current || token.current !== access.token) return;
      if (Date.parse(next.expiresAt) <= Date.now()) { clear("This private attendee invitation reached its fixed expiry. It was not renewed."); return; }
      if (current.current && (next.capabilityId !== current.current.capabilityId || next.receipt.ticketId !== current.current.receipt.ticketId || next.receipt.originalDigest !== current.current.receipt.originalDigest || next.expiresAt !== current.current.expiresAt)) { clear("This response no longer matches your exact original private ticket. Its content was not adopted."); return; }
      if (more && current.current) {
        const saved = new Map(current.current.inbox.map(item => [item.id, item]));
        for (const item of next.inbox) { const prior = saved.get(item.id); if (prior && prior.digest !== item.digest) throw new Error("An earlier inbox receipt changed. The new response was not accepted."); saved.set(item.id, item); }
        next.inbox = [...saved.values()].map(item => ({ ...item, sourceIsCurrent: item.sourceDigest === next.sourceDigest }));
      }
      current.current = next; setData(next); setStale(false);
    } catch (cause) { if (live.current && epoch === generation.current && !controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "Your private ticket could not be read."); setStale(Boolean(current.current)); } }
    finally { if (live.current && epoch === generation.current) { lock.current = false; setBusy(false); } }
  }, [access, clear, ended]);
  useEffect(() => { lock.current = false; if (access) void read(false); }, [access, read]);
  useEffect(() => { if (!data) return; const timer = setTimeout(() => clear("This original attendee invitation reached its fixed expiry. Private ticket content has been cleared."), Math.max(0, Date.parse(data.expiresAt) - Date.now())); return () => clearTimeout(timer); }, [data?.expiresAt, clear]);
  useEffect(() => { const visible = () => { if (document.visibilityState === "visible" && access && !ended) void read(false); }; window.addEventListener("focus", visible); window.addEventListener("online", visible); return () => { window.removeEventListener("focus", visible); window.removeEventListener("online", visible); }; }, [access, ended, read]);
  const submit = (event: FormEvent) => { event.preventDefault(); open(entry.trim()); };
  return <AudienceFrame controlled={data?.controlledQa ?? false}><main id="main" className={styles.attendeeMain}>
    <div className={styles.pageIntro}><div><span className={styles.kicker}>ONE TICKET / THE LATEST INFORMATION</span><h1 ref={heading} tabIndex={-1}>{data ? "Your night, kept in view." : "A private view of your night."}</h1><p>Current event information, your original ticket, and updates reviewed by the producer.</p></div>{data ? <div className={styles.actions}><Button disabled={busy || ended} busy={busy} onClick={() => void read(false)}><RefreshCw size={16} aria-hidden="true" />Refresh ticket</Button><Button variant="ghost" onClick={() => { clear("Your private ticket is closed on this device. Reopen your original attendee invitation to read it again."); setAccess(null); }}><LogOut size={16} aria-hidden="true" />Close private ticket</Button></div> : null}</div>
    {error ? <div className={styles.alert} role="alert"><TriangleAlert size={20} aria-hidden="true" /><div><b>{ended ? "Private access is closed." : "This read could not be verified."}</b><p>{error}</p>{stale && data ? <p>Content below is the last verified observation from <ActualTime value={data.observedAt} />. A newer response was not accepted.</p> : null}{!ended && access ? <Button disabled={busy} onClick={() => void read(false)}>Retry private read</Button> : null}</div></div> : null}
    {storageWarning ? <p className={styles.notice} role="status">This tab can read your invitation, but private browser storage is unavailable. Reopening the original link may be required after a reload.</p> : null}
    {(!initialized || busy && !data) ? <div className={styles.loading} role="status"><span className={styles.loadingBar} /><b>Checking your private invitation…</b><p>No payment, message or admission action is being performed.</p></div> : null}
    {initialized && !data && !busy ? <section className={styles.entry}><div className={styles.entryIcon}><LockKeyhole size={30} aria-hidden="true" /></div><h2>Open your attendee invitation.</h2><p>Use the private link shared by the producer, or enter its attendee key. A production or crew session cannot open this ticket.</p><form onSubmit={submit}><label htmlFor="attendee-key">Private attendee key</label><input id="attendee-key" type="password" autoComplete="off" spellCheck={false} value={entry} onChange={event => setEntry(event.target.value)} placeholder="att_…" /><Button disabled={!tokenPattern.test(entry.trim())} onClick={() => { if (tokenPattern.test(entry.trim())) open(entry.trim()); }} variant="primary">Open private ticket <ArrowRight size={17} aria-hidden="true" /></Button></form><small>The key grants access only to its original ticket. It cannot approve a production, send messages, or change money.</small></section> : null}
    {data ? <><DoorsBanner event={data.event} originalDoorsAt={data.originalDoorsAt} /><EventInformation event={data.event} /><div className={styles.attendeeColumns}><div className={styles.receiptColumn}><ReceiptLineStates receipt={data.receipt} event={data.event} /><TicketReceipt receipt={data.receipt} event={data.event} /></div><section className={styles.inbox} aria-labelledby="attendee-inbox-title"><div className={styles.sectionTitle}><div><span className={styles.kicker}>REVIEWED UPDATES / SAVED HERE</span><h2 id="attendee-inbox-title">Your inbox.</h2></div><Inbox size={24} aria-hidden="true" /></div><p className={styles.smallNote}>Each update below was approved for this exact ticket. Delivery here does not prove it was read. No external email is sent.</p>{data.inbox.length ? <div className={styles.inboxList}>{data.inbox.map(item => <article key={item.id} className={styles.inboxMessage}><div><Badge tone={item.sourceIsCurrent ? "green" : "amber"}>{item.sourceIsCurrent ? "Reviewed source" : "Historical update"}</Badge><span><ActualTime value={item.receivedAt} /></span></div><h3>{item.subject}</h3>{!item.sourceIsCurrent ? <p className={styles.historical}>The underlying event or receipt source changed after this update. Read the latest event and ticket information above; this original message is retained exactly.</p> : null}<p className={styles.messageBody}>{item.body}</p><details className={styles.proof}><summary>Exact inbox receipt</summary><p>Controlled inbox receipt <code>{item.id}</code></p><p>Saved content hash</p><code>{item.contentDigest}</code><p>Original source hash</p><code>{item.sourceDigest}</code><p>Immutable receipt hash</p><code>{item.digest}</code></details></article>)}</div> : <div className={styles.empty}><Inbox size={28} aria-hidden="true" /><h3>No reviewed updates yet.</h3><p>A draft or producer approval does not count as delivery. Only an update committed to this ticket’s controlled inbox appears here.</p></div>}{data.inboxPage.hasMore ? <Button disabled={busy || ended} onClick={() => void read(true)}>Load earlier updates</Button> : null}</section></div><div className={styles.privateFootnote}><LockKeyhole size={15} aria-hidden="true" /><p>Private observation <ActualTime value={data.observedAt} /> · this original access expires <ActualTime value={data.expiresAt} />. Refreshing does not extend it.</p></div></> : null}
  </main></AudienceFrame>;
}
