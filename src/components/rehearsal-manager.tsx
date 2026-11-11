"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Clock3, FileCheck2, Layers3, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import type { ConsoleData } from "@/domain/contracts";
import type { RehearsalOverview } from "@/domain/rehearsal-contracts";
import type { RehearsalRequest } from "@/server/rehearsal-service";
import { announceRehearsal, productionFetch } from "./production-fetch";
import { Badge, Button, Modal } from "./ui";

function localDate(value: string) { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
export function RehearsalManager({ data, open, onClose, onCurrentLabel, fallbackFocus }: { data: ConsoleData; open: boolean; onClose: () => void; onCurrentLabel: (label: string) => void; fallbackFocus: () => HTMLElement | null }) {
  const tenantId = data.show.tenantId;
  const [overview, setOverview] = useState<RehearsalOverview | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [mode, setMode] = useState<"list" | "create" | "rename">("list");
  const [name, setName] = useState(""), [retry, setRetry] = useState<RehearsalRequest | null>(null);
  const pending = useRef(false), sequence = useRef(0);
  const receive = useCallback((value: RehearsalOverview, append = false) => {
    setOverview(previous => append && previous ? { ...value, items: [...new Map([...previous.items, ...value.items].map(item => [item.tenantId, item])).values()] } : value);
    const current = value.items.find(item => item.current); if (current) onCurrentLabel(current.label);
  }, [onCurrentLabel]);
  const load = useCallback(async (offset = 0, signal?: AbortSignal) => {
    const request = ++sequence.current; setLoading(true);
    try {
      const response = await productionFetch(tenantId, "/api/rehearsals?offset=" + offset, { cache: "no-store", ...(signal ? { signal } : {}) });
      const body = await response.json(); if (!response.ok || !body.rehearsals) throw new Error(body.error ?? "Saved rehearsals could not be read.");
      if (request === sequence.current && !pending.current) { receive(body.rehearsals, offset > 0); setError(null); }
    } finally { if (request === sequence.current) setLoading(false); }
  }, [tenantId, receive]);
  useEffect(() => {
    const controller = new AbortController();
    void load(0, controller.signal).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [load, open]);
  const change = async (request: RehearsalRequest) => {
    if (pending.current) return; pending.current = true; ++sequence.current;
    setBusy(true); setError(null); setRetry(request);
    try {
      const response = await productionFetch(tenantId, "/api/rehearsals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      const body = await response.json();
      if (!response.ok || !body.rehearsals) { if (response.status < 500) setRetry(null); throw new Error(body.error ?? "The saved request could not be confirmed."); }
      receive(body.rehearsals); setRetry(null);
      if (request.type === "rename") { setMode("list"); return; }
      announceRehearsal(body.selectedTenantId); location.assign("/");
    } catch (error) { setError(error instanceof Error ? error.message : "The request may already be saved. Check the list or retry this same request."); }
    finally { pending.current = false; setBusy(false); }
  };
  const begin = (next: "create" | "rename") => {
    setRetry(null); setError(null); setMode(next);
    setName(next === "rename" ? overview?.items.find(item => item.current)?.label ?? "Alder Hall rehearsal" : "Alder Hall · Rehearsal " + ((overview?.total ?? 1) + 1));
  };
  const save = () => {
    if (mode === "list" || !name.trim() || retry) return;
    void change({ type: mode, label: name.trim(), idempotencyKey: crypto.randomUUID(), expectedTenantId: tenantId });
  };
  if (!open) return null;
  return <Modal title={mode === "create" ? "Give the next rehearsal its own stage." : mode === "rename" ? "Name this rehearsal." : "Your rehearsals. Every story retained."} fallbackFocus={fallbackFocus} onClose={() => { if (!busy) { setMode("list"); onClose(); } }}>
    <div className="rehearsal-manager">
      <div className="rehearsal-manager-intro"><Layers3 size={25} /><p>Each rehearsal keeps its own plan, crew readback, approvals and receipts. Selecting another changes the view; approved work continues with its original show.</p></div>
      {mode === "list" ? <>
        <div className="rehearsal-toolbar"><span>{overview ? `${overview.total} saved rehearsal${overview.total === 1 ? "" : "s"}` : "Reading saved rehearsals…"}</span><Button variant="primary" disabled={busy || !overview} onClick={() => begin("create")}><Plus size={16} />New rehearsal</Button></div>
        {!overview && <div className="rehearsal-loading" role="status"><LoaderCircle className="spin" size={23} />Reading this producer's saved workspace.</div>}
        <div className="rehearsal-list">{overview?.items.map(item => <article className={"rehearsal-card " + (item.current ? "current" : "")} key={item.tenantId}>
          <div className="rehearsal-card-heading"><span className="rehearsal-symbol">{item.current ? <Check size={19} /> : <Layers3 size={19} />}</span><div><h3>{item.label}</h3><p>{item.title} · {item.venue}</p></div><Badge tone={item.current ? "blue" : "muted"}>{item.current ? "OPEN HERE" : item.accessExpired ? "ACCESS EXPIRED" : "SAVED"}</Badge></div>
          <div className="rehearsal-card-facts"><span>Plan v{item.planVersion} · revision {item.revision}</span><span>{item.state === "house_open" ? "House open" : item.state === "go" ? "GO recorded" : "Standby"}</span>{item.hasFinancialHistory && <span><FileCheck2 size={13} />Receipt history retained</span>}</div>
          {(item.pendingWork > 0 || item.reviewWork > 0) && <p className="rehearsal-work"><Clock3 size={14} />{item.pendingWork} saved actions in progress{item.reviewWork ? ` · ${item.reviewWork} need review` : ""}</p>}
          <div className="rehearsal-card-footer"><small>{item.accessExpired ? "Original access expired; history retained." : "Access through " + localDate(item.accessExpiresAt)}<span>Last opened {localDate(item.lastOpenedAt)}</span></small>{item.current ? <Button ariaLabel={"Rename rehearsal " + item.label} variant="ghost" disabled={busy} onClick={() => begin("rename")}>Rename</Button> : <Button ariaLabel={"Open rehearsal " + item.label} disabled={busy || item.accessExpired} onClick={() => void change({ type: "switch", targetTenantId: item.tenantId, expectedTenantId: tenantId, idempotencyKey: crypto.randomUUID() })}>Open rehearsal <ArrowRight size={15} /></Button>}</div>
        </article>)}</div>
        {overview?.nextOffset !== null && overview?.nextOffset !== undefined && <Button disabled={busy || loading} busy={loading} onClick={() => { void load(overview.nextOffset!).catch(error => setError(error.message)); }}>Load more saved rehearsals</Button>}
      </> : <form className="rehearsal-form" onSubmit={event => { event.preventDefault(); save(); }}>
        <Badge tone="blue">{mode === "create" ? "SEPARATE SAVED PRODUCTION" : "WORKSPACE NAME ONLY"}</Badge>
        <label className="field-label">Rehearsal name<input autoFocus value={name} maxLength={64} disabled={busy || Boolean(retry)} onChange={event => setName(event.target.value)} placeholder="A name you will recognise later" /></label>
        <p>{mode === "create" ? "Start the Alder Hall fixture with a fresh plan and no payment approvals, saved wallets, captures or crew acknowledgments. Existing rehearsals remain available in this list." : "This changes the name in your saved workspace. The production plan, original actor, receipts and event history keep their existing identities."}</p>
        <div className="rehearsal-preservation"><FileCheck2 size={20} /><span>{mode === "create" ? "Original commitments stay with their original rehearsal." : "The full production history stays intact."}</span></div>
        <div className="modal-actions"><Button disabled={busy} onClick={() => { setMode("list"); setRetry(null); setError(null); void load().catch(error => setError(error.message)); }}>Back to saved rehearsals</Button><Button variant="primary" busy={busy} disabled={busy || !name.trim() || Boolean(retry)} onClick={save}>{mode === "create" ? "Create separate rehearsal" : "Save rehearsal name"}<ArrowRight size={15} /></Button></div>
      </form>}
      {error && <div className="rehearsal-error" role="alert"><p>{error}</p><div className="rehearsal-error-actions">{retry && <Button disabled={busy} busy={busy} onClick={() => void change(retry)}>Retry the same saved request</Button>}<Button disabled={busy || loading} onClick={() => { setMode("list"); setRetry(null); void load().catch(error => setError(error.message)); }}><RefreshCw size={14} />Check saved rehearsals</Button></div></div>}
      <p className="rehearsal-scope-note">Only rehearsals created from this producer's workspace appear here. Switching never renews an expired approval or replays a payment.</p>
    </div>
  </Modal>;
}
