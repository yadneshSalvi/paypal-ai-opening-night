"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, AudioLines, CalendarDays, Check, ChevronDown, CircleDot, Clock3, Clapperboard, FileCheck2, LayoutGrid, Layers3, ListTree, Menu, Radio, Search, ShieldAlert, ShieldCheck, Sparkles, Ticket, Users, WalletCards, X } from "lucide-react";
import type { ConsoleData } from "@/domain/contracts";
import type { Command } from "@/domain/commands";
import { countdown, formatMoney, localTime } from "@/domain/time";
import { financialSummary } from "@/domain/finance";
import { Badge, Button, Modal } from "./ui";
import { RehearsalManager } from "./rehearsal-manager";
import { ACTIVE_REHEARSAL_STORAGE, PRODUCTION_CHANGED_EVENT, productionFetch } from "./production-fetch";
import { StageMap } from "./stage-map";
import { ShowControl } from "./show-control";
import { RecoveryView } from "./recovery-view";
import { PlanView, ResourcesView, CalendarView } from "./planning-views";
import { ExecutionView, CrewView, BoxOfficeView, WrapView, EvidenceView } from "./operations-views";
import { SourceDesk } from "./sources/source-desk";
import { DisruptionDesk } from "./disruptions/disruption-desk";

export type RunCommand = (command: Command) => Promise<ConsoleData | null>;
export interface ViewProps { data: ConsoleData; onData: (data: ConsoleData) => void; run: RunCommand; busy: string | null; licenseKey: string }
const navigation = [
  { id: "show", label: "Show control", icon: Radio, href: "/" },
  { id: "plan", label: "Production plan", icon: ListTree, href: "/plan" },
  { id: "tour", label: "Library & tour", icon: Layers3, href: "/tour" },
  { id: "sources", label: "Production sources", icon: FileCheck2, href: "/sources" },
  { id: "resources", label: "Crew & equipment", icon: Users, href: "/resources" },
  { id: "calendar", label: "Calendar", icon: CalendarDays, href: "/calendar" },
  { id: "recovery", label: "Recovery studio", icon: Sparkles, href: "/recovery" },
  { id: "disruptions", label: "Disruption desk", icon: ShieldAlert, href: "/disruptions" },
  { id: "execution", label: "Execution", icon: Clapperboard, href: "/execution" },
  { id: "crew", label: "Crew readback", icon: AudioLines, href: "/crew" },
  { id: "box-office", label: "Box office", icon: Ticket, href: "/box-office" },
  { id: "wrap", label: "Wrap desk", icon: WalletCards, href: "/wrap" },
  { id: "evidence", label: "Evidence room", icon: FileCheck2, href: "/evidence" },
];
function Brand() { return <Link className="brand" href="/" aria-label="Opening Night home"><span className="brand-mark"><i /><i /><i /><i /></span><span>OPENING<br />NIGHT<span className="brand-period">.</span></span></Link>; }
export function ProductionConsole({ initial, view, licenseKey }: { initial: ConsoleData | null; view: string; licenseKey: string }) {
  const [data, setData] = useState(initial); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState(false); const [compactNavigation, setCompactNavigation] = useState(false); const [search, setSearch] = useState(false); const [query, setQuery] = useState("");
  const [rehearsals, setRehearsals] = useState(false), [rehearsalLabel, setRehearsalLabel] = useState("Alder Hall rehearsal"), [sessionChanged, setSessionChanged] = useState(false);
  const sidebar = useRef<HTMLElement>(null); const closeNavigation = useRef<HTMLButtonElement>(null); const navigationTrigger = useRef<HTMLButtonElement>(null); const rehearsalTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { const media = matchMedia("(max-width: 760px)"); const update = () => setCompactNavigation(media.matches); update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  useEffect(() => {
    if (!menu) return;
    const previous = document.activeElement; const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; closeNavigation.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setMenu(false); return; }
      if (event.key !== "Tab") return;
      const items = [...(sidebar.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,[tabindex="0"]') ?? [])].filter(node => node.getClientRects().length > 0);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const media = matchMedia("(max-width: 760px)"); const resize = () => { if (!media.matches) setMenu(false); };
    document.addEventListener("keydown", keydown); media.addEventListener("change", resize);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keydown); media.removeEventListener("change", resize); if (navigationTrigger.current) navigationTrigger.current.focus(); else if (previous instanceof HTMLElement) previous.focus(); };
  }, [menu]);
  useEffect(() => setData(initial), [initial]);
  useEffect(() => { const tenantId = data?.show.tenantId; const refresh = () => { if (tenantId && !busy && !sessionChanged && document.visibilityState === "visible") void productionFetch(tenantId, "/api/show", { cache: "no-store" }).then(async response => { if (response.ok) setData(await response.json()); }).catch(() => undefined); }; window.addEventListener("focus", refresh); return () => window.removeEventListener("focus", refresh); }, [busy, data?.show.tenantId, sessionChanged]);
  useEffect(() => {
    const changed = () => { if (data) { setSessionChanged(true); setMenu(false); setSearch(false); setRehearsals(false); } };
    const storage = (event: StorageEvent) => { if (event.key !== ACTIVE_REHEARSAL_STORAGE || !event.newValue) return; try { const next = JSON.parse(event.newValue); if (data && typeof next.tenantId === "string" && next.tenantId !== data.show.tenantId) changed(); } catch { /* Invalid browser metadata never changes authority. */ } };
    window.addEventListener(PRODUCTION_CHANGED_EVENT, changed); window.addEventListener("storage", storage);
    return () => { window.removeEventListener(PRODUCTION_CHANGED_EVENT, changed); window.removeEventListener("storage", storage); };
  }, [data?.show.tenantId]);
  useEffect(() => { const handler = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setSearch(v => !v); } }; document.addEventListener("keydown", handler); return () => document.removeEventListener("keydown", handler); }, []);
  const start = async () => { setBusy("session"); setError(null); try { const response = await fetch("/api/session", { method: "POST" }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error); setData(payload); } catch (e) { setError(e instanceof Error ? e.message : "The rehearsal could not open."); } finally { setBusy(null); } };
  const run: RunCommand = useCallback(async command => {
    if (!data || busy || sessionChanged) return null; setBusy(command.type); setError(null); setNotice(null);
    try {
      const response = await productionFetch(data.show.tenantId, "/api/show", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), expectedRevision: data.show.revision, command }) });
      const payload = await response.json();
      if (!response.ok) { if (payload.code === "STALE_REVISION") { const current = await productionFetch(data.show.tenantId, "/api/show", { cache: "no-store" }); if (current.ok) setData(await current.json()); } throw new Error(payload.error); }
      setData(payload); setNotice(command.type === "generate" ? "Alternatives computed and saved. Every result includes its constraint and engine evidence." : payload.show.events.at(-1)?.message ?? "The production was updated."); return payload;
    } catch (e) { setError(e instanceof Error ? e.message : "The action could not complete."); return null; } finally { setBusy(null); }
  }, [data, busy, sessionChanged]);
  if (!data) return <div className="landing"><div className="landing-nav"><Brand /><Badge tone="amber">CONTROLLED SANDBOX REHEARSAL</Badge><span className="mono faint">CHICAGO / 2026</span></div><main id="main" className="landing-main"><div className="landing-copy"><span className="eyebrow">THE PRODUCTION OPERATING SYSTEM</span><h1>MAKE<br />TONIGHT<br /><em>HAPPEN.</em></h1><p>When a show changes, everything moves.<br />Bring the people, the plan, and the promises<br />back into sync. Then call GO.</p><Button variant="primary" busy={busy === "session"} onClick={start}>Open the Alder Hall rehearsal <ArrowRight size={18} /></Button><span className="landing-detail">Your own saved session · 82 production tasks · 11 critical crew</span>{error && <p className="error-note" role="alert">{error}</p>}</div><div className="landing-art"><div className="landing-showcard"><div><span className="eyebrow">ONE NIGHT AT ALDER HALL</span><h2>THE NIGHT FERRIES</h2><span>with Juniper Lane</span></div><span className="poster-date">14<span>NOV</span></span></div><StageMap /><div className="landing-art-footer"><span><CircleDot size={14} /> Every green light needs evidence.</span><span className="mono">DOORS 19:00 CST</span></div></div></main><footer className="landing-footer"><span>Built for the moments before the moment.</span><div><span>BRYNTUM ENTERPRISE</span><span>PAYPAL SANDBOX</span><span>APIMATIC</span></div><span>Fictional show. Real system behavior.</span></footer></div>;
  const { show } = data; const doors = data.readiness.find(r => r.scope === "DOORS")!; const finance = financialSummary(show);
  const props = { data, onData: setData, run, busy, licenseKey };
  return <div className="app-shell">
    <aside ref={sidebar} inert={sessionChanged || compactNavigation && !menu} aria-hidden={compactNavigation && !menu ? true : undefined} className={`sidebar ${menu ? "open" : ""}`} role={menu ? "dialog" : undefined} aria-modal={menu ? true : undefined} aria-label={menu ? "Production navigation" : undefined}><button ref={closeNavigation} className="icon-button drawer-close" aria-label="Close navigation" onClick={() => setMenu(false)}><X size={20} /></button><Brand /><button ref={rehearsalTrigger} className="production-picker" aria-label={"Saved rehearsals. Current: " + rehearsalLabel} aria-haspopup="dialog" aria-expanded={rehearsals} disabled={Boolean(busy)} onClick={() => { setMenu(false); requestAnimationFrame(() => setRehearsals(true)); }}><span className="venue-icon"><LayoutGrid size={19} /></span><span className="production-picker-copy"><b>{rehearsalLabel}</b><small>YOUR SAVED REHEARSALS</small></span><ChevronDown size={15} /></button><div className="nav-caption">PRODUCTION DESK</div><nav aria-label="Production views">{navigation.map(({ id, label, icon: Icon, href }, index) => <div key={id}>{id === "recovery" && <div className="nav-divider" />}<Link className={`nav-item ${view === id ? "active" : ""}`} aria-current={view === id ? "page" : undefined} href={href} onClick={() => setMenu(false)}><Icon size={17} /><span>{label}</span>{id === "recovery" && show.incidents.length > 0 && <span className="nav-count">{show.incidents.length}</span>}</Link></div>)}</nav><div className="sidebar-bottom"><div className="connection"><span className="tiny-dot green" /><span>Rehearsal saved<small>Private session · revision {show.revision}</small></span><ShieldCheck size={17} /></div><div className="operator"><span className="avatar">SR</span><span>Production operator<small>Controlled fixture roles</small></span><Badge>DEMO</Badge></div></div></aside>
    {menu && <button className="sidebar-backdrop" tabIndex={-1} aria-hidden="true" aria-label="Close navigation" onClick={() => setMenu(false)} />}
    <div className="workspace" inert={menu || sessionChanged}><header className="production-header"><div className="header-start"><button ref={navigationTrigger} className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMenu(!menu)}><Menu size={21} /></button><span className="header-show">THE NIGHT FERRIES</span><span className="header-separator" /><span className="header-version">PLAN v{show.planVersion}</span><Badge tone="amber">SANDBOX REHEARSAL</Badge></div><div className="header-live"><span className="clock-chip"><Clock3 size={14} /> DOORS IN <b>{countdown(show.clock, show.doorsAt)}</b><small>CST</small></span><Link className={`cue-badge ${doors.ready ? "green" : "amber"}`} href="/execution"><span className="tiny-dot" />{show.state === "house_open" ? "HOUSE OPEN" : show.state === "go" ? "GO" : "STANDBY"}<span>{doors.gates.filter(g => g.complete).length}/{doors.gates.length}</span></Link><button className="search-button" aria-label="Search calls and views" onClick={() => setSearch(true)}><Search size={16} /><kbd>⌘ K</kbd></button></div></header>
    <div className="context-bar"><span><span className="tiny-dot amber" /> SCENARIO CLOCK <b className="mono">{localTime(show.clock)} CST</b><span className="context-date">SATURDAY, NOVEMBER 14</span></span><Link href="/box-office">{data.controlledQa ? "Controlled gross captures" : "Verified gross captured"} <b>{formatMoney(finance.grossCapturedMinor)}</b><ArrowUpRight size={12} /></Link></div>
    <main id="main" className={`main-content view-${view}`}>
      {data.controlledQa && <div className="crew-warning qa-fixture-notice"><strong>{data.controlledPlanningQa ? "ISOLATED PLANNING QA · CONTROLLED AI INPUTS" : "ISOLATED CREW QA · CONTROLLED READINESS INPUTS"}</strong><p>{data.controlledPlanningQa ? "Fictional production sources and controlled response fixtures exercise the real planning services. Model and payment providers are disabled. No financial or crew completion is established by this rehearsal." : "Supplier confirmation, accepted delivery, rental authorization and fee capture, and 38 refund outcomes are controlled test inputs. Provider actions are disabled. Actual provider qualification remains separate."}</p></div>}
      {error && <div className="notification error" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError(null)}><X size={16} /></button></div>}
      {notice && <div className="notification" role="status"><Check size={16} /><span>{notice}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={16} /></button></div>}
      {view === "show" && <ShowControl {...props} />}{view === "recovery" && <RecoveryView {...props} />}{view === "disruptions" && <DisruptionDesk {...props} />}{view === "plan" && <PlanView {...props} />}{view === "sources" && <SourceDesk {...props} />}{view === "resources" && <ResourcesView {...props} />}{view === "calendar" && <CalendarView {...props} />}{view === "execution" && <ExecutionView {...props} />}{view === "crew" && <CrewView {...props} />}{view === "box-office" && <BoxOfficeView {...props} />}{view === "wrap" && <WrapView {...props} />}{view === "evidence" && <EvidenceView {...props} />}
    </main><footer className="workspace-footer"><span>OPENING NIGHT<span className="amber-text">.</span> <span className="footer-dash">/</span> All the way to the last cue.</span><Link href="/evidence">Fictional production · evidence-led rehearsal <ArrowUpRight size={12} /></Link></footer></div>
    <RehearsalManager data={data} open={rehearsals && !sessionChanged} onClose={() => setRehearsals(false)} onCurrentLabel={setRehearsalLabel} fallbackFocus={() => matchMedia("(max-width: 760px)").matches ? navigationTrigger.current : rehearsalTrigger.current} />
    {sessionChanged && <Modal title="Another rehearsal is selected." dismissible={false} onClose={() => undefined}><div className="rehearsal-session-change"><Layers3 size={32} /><p>This tab still shows the previous production. Its actions are paused so they cannot change the rehearsal now selected in this browser.</p><p>All plans, receipts and approved work stay with their original shows.</p><button autoFocus type="button" className="button primary" onClick={() => location.reload()}>Open the selected rehearsal <ArrowRight size={16} /></button></div></Modal>}
    {search && !sessionChanged && <Modal title="Find your next cue." onClose={() => setSearch(false)}><label className="search-field"><Search size={19} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search calls, people, or views" /></label><div className="search-results">{navigation.filter(n => n.label.toLowerCase().includes(query.toLowerCase())).map(n => <Link key={n.id} href={n.href} onClick={() => setSearch(false)}><n.icon size={17} /><span>{n.label}</span><ArrowUpRight size={15} /></Link>)}{show.tasks.filter(t => query.length > 1 && t.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8).map(t => <Link key={t.id} href={`/plan#task-${t.id}`} onClick={() => setSearch(false)}><span className="mono">{localTime(t.start)}</span><span>{t.name}</span><ArrowUpRight size={15} /></Link>)}{query && !navigation.some(n => n.label.toLowerCase().includes(query.toLowerCase())) && !show.tasks.some(t => t.name.toLowerCase().includes(query.toLowerCase())) && <p className="muted">No matching calls. Try a department, artist, or view.</p>}</div></Modal>}
  </div>;
}
