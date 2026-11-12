import type { Candidate, RescueRun, ShowSnapshot } from '@/domain/contracts';

export function candidateTermsCurrent(show: ShowSnapshot, candidate: Candidate, now: number): boolean {
  const offer=show.offers.find(value=>value.id===candidate.patch.offerId);
  if(!offer || offer.revision!==candidate.patch.offerRevision || offer.serviceQuote?.reviewRequired || offer.status==='expired' || Date.parse(offer.expiresAt)<=Date.parse(show.clock)) return false;
  if(offer.serviceQuote && Date.parse(offer.serviceQuote.validUntil)<=now) return false;
  const source=show.supplierTermRevisions?.find(value=>value.supplierId===offer.supplierId);
  return !(source && offer.serviceQuote?.termsSource?.id!==source.id) && !(show.supplierDisruptions??[]).some(value=>Date.parse(value.recordedAt)>Date.parse(candidate.generatedAt));
}

/** Compare one real representative per family. A newly admitted supplier can lead every family. */
export function recoveryHeadlines(show: ShowSnapshot, candidates: Candidate[], now: number): Candidate[] {
  const rank=(value:Candidate)=>!candidateTermsCurrent(show,value,now)?4:value.report.engine?.status!=='passed'?3:['feasible','feasible_with_approval'].includes(value.report.status)?0:value.report.status==='unknown_pending_evidence'?1:2;
  const order=['doors','budget','artist','direct'];
  const groups=new Map<string,Candidate[]>();
  for(const candidate of candidates){const key=candidate.strategy?.kind??candidate.family;groups.set(key,[...(groups.get(key)??[]),candidate]);}
  const representatives=[...groups.entries()].map(([key,rows])=>({key,candidate:[...rows].sort((a,b)=>rank(a)-rank(b)||a.cost.totalMinor-b.cost.totalMinor||a.id.localeCompare(b.id))[0]!}));
  representatives.sort((a,b)=>rank(a.candidate)-rank(b.candidate)||((order.indexOf(a.key)+1||10)-(order.indexOf(b.key)+1||10))||a.candidate.cost.totalMinor-b.candidate.cost.totalMinor);
  const selected=representatives.slice(0,3).map(value=>value.candidate);
  // Keep an intelligible rejected family in the headline comparison when it exists.
  const diagnostic=representatives.find(value=>value.candidate.report.status==='infeasible'&&candidateTermsCurrent(show,value.candidate,now));
  if(selected.length===3 && diagnostic && !selected.some(value=>value.report.status==='infeasible')) selected[2]=diagnostic.candidate;
  return selected;
}

/* ---- Candidate funnel: a read model of one stored run. No count is ever prefilled or estimated. ---- */
export interface FunnelStage { id: 'generated' | 'schema' | 'temporal' | 'evidence' | 'approvable'; label: string; count: number }
export interface FunnelReason { code: string; label: string; count: number }
export interface FunnelProvenance { id: string; label: string; count: number }
export interface FunnelModel {
  runId: string | null; completedAt: string | null; stages: FunnelStage[];
  /** Per-rule counts overlap: one rejected candidate can fail several rules. */
  reasons: FunnelReason[];
  /** Distinct rejected candidates. Deliberately separate from the chips, which are never summed. */
  uniqueRejected: number; pendingEvidence: number; provenance: FunnelProvenance[];
}
/** Stored counts by stage and provenance. A provenance-aware store can supply these directly later. */
export interface FunnelCounts {
  runId: string | null; completedAt: string | null;
  generated: number; schemaValid: number; temporalValid: number; evidenceValid: number; approvable: number;
  rejected: number; pending: number; reasons: Record<string, number>; provenance?: FunnelProvenance[];
}
const ruleLabels: Record<string, string> = { CREW_REST: 'Crew rest', QUALIFICATION: 'Qualification', DELIVERY_WINDOW: 'Delivery window', DEPENDENCY_ORDER: 'Dependency order', DOORS_SEQUENCE: 'Doors sequence', ARTIST_ARRIVAL: 'Artist arrival', VENUE_ACCESS: 'Venue access', CONSOLE_COMPATIBILITY: 'Console compatibility' };
export const ruleLabel = (code: string, curfew?: string) => code === 'CURFEW' && curfew ? `Curfew ${curfew}` : ruleLabels[code] ?? code.toLowerCase().replaceAll('_', ' ').replace(/^./, value => value.toUpperCase());
const strategyLabels: Record<string, string> = { deterministic_enumerator: 'Deterministic enumerator', model_assisted_proposal: 'Model-assisted proposal' };

/** Same stage rules as the domain funnel in `domain/scheduling.ts`, kept browser-safe; a test holds them equal. */
export function funnelCounts(run: RescueRun | null | undefined): FunnelCounts {
  const candidates = run?.candidates ?? [], rejected = candidates.filter(row => row.report.status === 'infeasible'), reasons: Record<string, number> = {};
  for (const row of rejected) for (const code of new Set(row.report.issues.filter(issue => issue.severity === 'hard').map(issue => issue.code))) reasons[code] = (reasons[code] ?? 0) + 1;
  const passed = (row: Candidate, stages: string[]) => !row.report.issues.some(issue => issue.severity !== 'approval' && stages.includes(issue.stage));
  return {
    runId: run?.id ?? null, completedAt: run?.completedAt ?? null, generated: candidates.length,
    schemaValid: candidates.filter(row => passed(row, ['schema', 'graph'])).length,
    temporalValid: candidates.filter(row => passed(row, ['schema', 'graph', 'temporal'])).length,
    evidenceValid: candidates.filter(row => passed(row, ['schema', 'graph', 'temporal', 'semantic', 'evidence', 'authority'])).length,
    approvable: candidates.filter(row => row.report.status === 'feasible' || row.report.status === 'feasible_with_approval').length,
    rejected: rejected.length, pending: candidates.filter(row => row.report.status === 'unknown_pending_evidence').length, reasons,
    provenance: run ? [{ id: run.strategySource, label: strategyLabels[run.strategySource] ?? String(run.strategySource), count: candidates.length }] : [],
  };
}
/** The single adapter between stored counts and the funnel strip. */
export function funnelModel(counts: FunnelCounts, curfew?: string): FunnelModel {
  return {
    runId: counts.runId, completedAt: counts.completedAt,
    stages: [{ id: 'generated', label: 'Generated', count: counts.generated }, { id: 'schema', label: 'Schema-valid', count: counts.schemaValid }, { id: 'temporal', label: 'Temporally valid', count: counts.temporalValid }, { id: 'evidence', label: 'Semantic and evidence valid', count: counts.evidenceValid }, { id: 'approvable', label: 'Approvable', count: counts.approvable }],
    reasons: Object.entries(counts.reasons).map(([code, count]) => ({ code, label: ruleLabel(code, curfew), count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    uniqueRejected: counts.rejected, pendingEvidence: counts.pending, provenance: counts.provenance ?? [],
  };
}

/* ---- Plan tabs: exactly three primary chips, then approval requirements or one diagnostic rule. ---- */
export interface PlanTabChips {
  primary: [doors: string, cost: string, people: string];
  approvals: { id: string; label: string }[];
  /** Present only for a plan that cannot be selected: its first failing or unresolved rule. */
  diagnostic: { tone: 'red' | 'amber'; label: string; code: string } | null;
  selectable: boolean;
}
const hm = (minutes: number) => `${Math.floor(minutes / 60)}h${minutes % 60 ? String(minutes % 60).padStart(2, '0') : ''}`;
const clock = (instant: string, zone: string) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
export function planTabChips(show: ShowSnapshot, candidate: Candidate): PlanTabChips {
  const baseline = candidate.patch.tasks.find(row => row.id === 'doors')?.baselineStart ?? show.tasks.find(row => row.id === 'doors')?.baselineStart ?? null;
  const delta = baseline ? Math.round((Date.parse(candidate.patch.doorsAt) - Date.parse(baseline)) / 60000) : null;
  const doors = `Doors ${clock(candidate.patch.doorsAt, show.zone)}${delta === null ? '' : delta === 0 ? ' ±0' : ` ${delta > 0 ? '+' : '−'}${Math.abs(delta)} min`}`;
  const cost = `+$${(candidate.cost.totalMinor / 100).toLocaleString('en-US', { minimumFractionDigits: candidate.cost.totalMinor % 100 ? 2 : 0 })}`;
  const people = `${candidate.patch.changedPeople.length} ${candidate.patch.changedPeople.length === 1 ? 'call' : 'calls'} changed`;
  const hard = candidate.report.issues.find(issue => issue.severity === 'hard'), unknown = candidate.report.issues.find(issue => issue.severity === 'unknown');
  const rest = Math.round((Date.parse(show.nextCallAt) - Date.parse(candidate.patch.crewFinishAt)) / 60000);
  const explain = (code: string, message: string) => code === 'CREW_REST' && Number.isFinite(rest) ? `Crew rest ${hm(Math.max(0, rest))} < ${hm(show.policy.minimumRestMinutes)}` : `${ruleLabel(code, clock(show.curfewAt, show.zone))} · ${message}`;
  const diagnostic = candidate.report.status === 'infeasible' ? hard ? { tone: 'red' as const, label: explain(hard.code, hard.message), code: hard.code } : { tone: 'red' as const, label: 'Rejected by validation', code: 'REJECTED' }
    : candidate.report.status === 'unknown_pending_evidence' ? { tone: 'amber' as const, label: unknown ? `Evidence missing · ${unknown.message}` : 'Evidence missing', code: unknown?.code ?? 'UNKNOWN' } : null;
  return { primary: [doors, cost, people], approvals: diagnostic ? [] : candidate.approvals.map(row => ({ id: row.id, label: `${row.label} · ${row.role.replaceAll('_', ' ')} approval` })), diagnostic, selectable: !diagnostic };
}

/** A family is diagnostic when every stored candidate in it is rejected by a hard rule. */
export interface RejectedFamily { key: string; name: string; representative: Candidate; evidence: { code: string; label: string; stage: string; message: string; subject: string | null }[]; size: number }
export function rejectedFamilies(show: ShowSnapshot, candidates: Candidate[]): RejectedFamily[] {
  const groups = new Map<string, Candidate[]>(), order = ['doors', 'budget', 'artist', 'direct'];
  for (const candidate of candidates) { const key = candidate.strategy?.kind ?? candidate.family; groups.set(key, [...(groups.get(key) ?? []), candidate]); }
  const rules = (row: Candidate) => new Set(row.report.issues.filter(issue => issue.severity === 'hard').map(issue => issue.code)).size;
  return [...groups.entries()].filter(([, rows]) => rows.every(row => row.report.status === 'infeasible')).sort(([a], [b]) => ((order.indexOf(a) + 1 || 10) - (order.indexOf(b) + 1 || 10)) || a.localeCompare(b)).map(([key, rows]) => {
    const representative = [...rows].sort((a, b) => rules(a) - rules(b) || a.cost.totalMinor - b.cost.totalMinor || a.id.localeCompare(b.id))[0]!;
    const seen = new Set<string>(), evidence = representative.report.issues.filter(issue => issue.severity === 'hard' && !seen.has(issue.code) && Boolean(seen.add(issue.code))).map(issue => ({ code: issue.code, label: ruleLabel(issue.code, clock(show.curfewAt, show.zone)), stage: issue.stage, message: issue.message, subject: issue.taskId ?? issue.resourceId }));
    return { key, name: representative.name, representative, evidence, size: rows.length };
  });
}
