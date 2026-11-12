import type { ConsoleData, Dependency, EvidenceRef, ReadinessReport, Resource, ShowSnapshot, SupplierOffer, Task } from "@/domain/contracts";

export type SelectionKind = "task" | "resource" | "supplier" | "source" | "gate";
export interface ProductionSelection { kind: SelectionKind; id: string }
export interface SelectionDetail {
  selection: ProductionSelection; title: string; subtitle: string;
  tasks: Task[]; resources: Resource[]; suppliers: SupplierOffer[]; sources: EvidenceRef[];
  dependencies: Dependency[]; missingSourceIds: string[];
}
const kinds: SelectionKind[] = ["task", "resource", "supplier", "source", "gate"];
export const productionIdentity = (data: ConsoleData) => JSON.stringify([data.show.tenantId, data.show.id, data.currentActor.id]);
export const sameProduction = (left: ConsoleData, right: ConsoleData) => productionIdentity(left) === productionIdentity(right) && right.currentActor.tenantId === right.show.tenantId;
export function currentReadiness(data: ConsoleData, scope: ReadinessReport["scope"] = "DOORS") {
  const report = data.readiness.find(row => row.scope === scope);
  return report?.revision === data.show.revision ? report : null;
}
export function parseSelection(value: unknown): ProductionSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && kinds.includes(row.kind as SelectionKind) && typeof row.id === "string" && row.id.length > 0 && row.id.length <= 200 ? { kind: row.kind as SelectionKind, id: row.id } : null;
}
export const sameSelection = (left: ProductionSelection | null, right: ProductionSelection | null) => left?.kind === right?.kind && left?.id === right?.id;

/** Relationships come from current canonical IDs, assignments and incident edges, never a label match. */
export function selectionDetail(data: ConsoleData, selection: ProductionSelection | null): SelectionDetail | null {
  if (!selection || data.currentActor.tenantId !== data.show.tenantId) return null;
  const { show } = data;
  const task = selection.kind === "task" ? show.tasks.find(row => row.id === selection.id) : null;
  const resource = selection.kind === "resource" ? show.resources.find(row => row.id === selection.id) : null;
  const supplier = selection.kind === "supplier" ? show.offers.find(row => row.id === selection.id) : null;
  const source = selection.kind === "source" ? show.sources.find(row => row.id === selection.id) : null;
  const gate = selection.kind === "gate" ? currentReadiness(data)?.gates.find(row => row.id === selection.id) : null;
  if (!task && !resource && !supplier && !source && !gate) return null;
  const incidentTasks = new Set(resource ? show.incidents.filter(row => row.resourceIds.includes(resource.id)).flatMap(row => row.affectedTaskIds) : []);
  const tasks = task ? [task] : resource ? show.tasks.filter(row => row.resources.includes(resource.id) || incidentTasks.has(row.id)) : supplier ? show.tasks.filter(row => row.sourceId === supplier.id) : source ? show.tasks.filter(row => row.sourceId === source.id) : [];
  const ids = new Set(tasks.map(row => row.id)), resourceIds = new Set(tasks.flatMap(row => row.resources));
  if (resource) resourceIds.add(resource.id);
  const sourceIds = [...new Set(tasks.map(row => row.sourceId))];
  if (source) sourceIds.push(source.id);
  const suppliers = supplier ? [supplier] : show.offers.filter(row => sourceIds.includes(row.id));
  const knownSourceIds = new Set([...show.sources.map(row => row.id), ...show.offers.map(row => row.id)]);
  return {
    selection, title: task?.name ?? resource?.name ?? supplier?.supplier ?? source?.title ?? gate!.label,
    subtitle: task ? "Canonical production call" : resource ? resource.role : supplier ? "Exact supplier offer · revision " + supplier.revision : source ? "Source evidence · " + source.source : "Current DOORS gate",
    tasks, resources: show.resources.filter(row => resourceIds.has(row.id)), suppliers,
    sources: show.sources.filter(row => sourceIds.includes(row.id)),
    dependencies: show.dependencies.filter(row => ids.has(row.from) || ids.has(row.to)),
    missingSourceIds: sourceIds.filter(id => !knownSourceIds.has(id)),
  };
}

export interface CurrentCue {
  id: string; reportId: string; recordedAt: string; fixtureAt: string; person: string; revision: number;
  attribution: "signed_controlled_crew" | "application_command";
}
/** Consumes the server's verified current projection. A readiness conjunction alone is never a GO. */
export function currentGo(data: ConsoleData): CurrentCue | null {
  const { show } = data, report = currentReadiness(data);
  if (!report?.ready || !report.gates.length || report.gates.some(row => !row.complete) || !["go", "house_open"].includes(show.state) || !show.goReportId || !/^[a-f0-9]{64}$/.test(show.goReportId) || data.currentActor.tenantId !== show.tenantId) return null;
  if (show.crewProtocol === 1) {
    const option = data.crew?.cues.find(row => row.kind === "DOORS_GO"), record = option?.record, sheet = show.sheets.at(-1);
    if (!record || record.type !== "cue" || record.kind !== "DOORS_GO" || record.status !== "current" || !sheet || record.planVersion !== show.planVersion || record.sheetVersion !== sheet.version || record.sheetDigest !== sheet.digest || !option!.personIds.includes(record.personId)) return null;
    const exact = show.crewCues?.find(row => row.id === record.id && row.kind === "DOORS_GO" && row.reportId === show.goReportId && row.commandId === record.commandId && row.tenantId === show.tenantId && row.showId === show.id);
    if (!exact || !record.commandId || exact.personId !== record.personId || exact.planVersion !== record.planVersion || exact.sheetDigest !== record.sheetDigest || exact.sheetVersion !== record.sheetVersion || exact.fixtureAt !== record.fixtureAt || exact.recordedAt !== record.recordedAt || !Number.isFinite(Date.parse(record.fixtureAt)) || Date.parse(record.fixtureAt) > Date.parse(show.clock) || !Number.isFinite(Date.parse(record.recordedAt))) return null;
    if (!Number.isInteger(exact.revision) || exact.revision > show.revision || exact.revision < 1 || exact.actorId !== record.actorId) return null;
    return { id: record.id, reportId: show.goReportId, recordedAt: record.recordedAt, fixtureAt: record.fixtureAt, person: record.personName, revision: exact.revision, attribution: "signed_controlled_crew" };
  }
  const event = show.events.findLast(row => row.type === "cue.go_issued" && row.revision <= show.revision);
  return event ? { id: event.id, reportId: show.goReportId, recordedAt: event.at, fixtureAt: event.fixtureAt, person: "Authorized application operator", revision: event.revision, attribution: "application_command" } : null;
}
export function currentHouseOpen(data: ConsoleData) {
  const go = currentGo(data);
  if (!go || data.show.state !== "house_open") return false;
  if (data.show.crewProtocol !== 1) return data.show.events.some(row => row.type === "cue.house_open" && row.revision <= data.show.revision);
  const option = data.crew?.cues.find(row => row.kind === "HOUSE_OPEN"), record = option?.record;
  const sheet = data.show.sheets.at(-1);
  if (!sheet) return false;
  return Boolean(record?.status === "current" && record.type === "cue" && record.kind === "HOUSE_OPEN" && option!.personIds.includes(record.personId) && record.planVersion === data.show.planVersion && record.sheetVersion === sheet?.version && record.sheetDigest === sheet.digest && data.show.crewCues?.some(row => row.id === record.id && row.kind === "HOUSE_OPEN" && row.commandId === record.commandId && row.personId === record.personId && row.sheetDigest === record.sheetDigest && row.precedingCueId === go.id && row.tenantId === data.show.tenantId && row.showId === data.show.id && row.recordedAt === record.recordedAt && row.fixtureAt === record.fixtureAt && Number.isFinite(Date.parse(row.fixtureAt)) && Date.parse(row.fixtureAt) <= Date.parse(data.show.clock)));
}

export interface ClockTransition { id: string; from: string; to: string; elapsedMinutes: number; recordedAt: string }
export function confirmedClockTransition(before: ConsoleData, after: ConsoleData): ClockTransition | null {
  if (!sameProduction(before, after) || after.show.revision <= before.show.revision || after.show.clock === before.show.clock) return null;
  const minutes = (Date.parse(after.show.clock) - Date.parse(before.show.clock)) / 60000;
  const known = new Set(before.show.events.map(row => row.id));
  const event = after.show.events.findLast(row => row.type === "fixture.clock_advanced" && !known.has(row.id) && row.fixtureAt === after.show.clock && row.revision > before.show.revision && row.revision <= after.show.revision);
  return Number.isFinite(minutes) && minutes > 0 && event ? { id: event.id, from: before.show.clock, to: after.show.clock, elapsedMinutes: minutes, recordedAt: event.at } : null;
}
export function pendingObservations(show: ShowSnapshot) {
  return [...show.financialEvidence.filter(row => row.status === "pending").map(row => ({ id: row.id, label: row.kind + " result pending" })), ...(show.financialChecks ?? []).filter(row => row.status === "pending").map(row => ({ id: row.id, label: "Unresolved " + row.eventType + " observation" }))];
}
export function acceptedRead(current: ConsoleData, value: unknown): value is ConsoleData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const next = value as ConsoleData;
  return Boolean(next.show && next.currentActor && typeof next.currentActor.id === "string" && Array.isArray(next.currentActor.roles) && typeof next.show.id === "string" && typeof next.show.tenantId === "string" && next.show.zone === "America/Chicago" && Number.isFinite(Date.parse(next.show.clock)) && Array.isArray(next.readiness) && ["tasks", "dependencies", "resources", "offers", "incidents", "runs", "sheets", "acknowledgments", "financialEvidence", "tickets", "facts", "sources", "events"].every(key => Array.isArray(next.show[key as keyof ShowSnapshot])) && sameProduction(current, next) && Number.isInteger(next.show.revision) && next.show.revision >= current.show.revision && Number.isInteger(next.show.planVersion) && next.show.planVersion > 0 && Number.isFinite(Date.parse(next.serverAt)) && Date.parse(next.serverAt) >= Date.parse(current.serverAt));
}

export const QUIET_GO_MS = 14_000;
export interface CueWatch { production: string; baselineCue: string | null; revision: number }
export function watchCanPresent(watch: CueWatch, data: ConsoleData, fresh: boolean) {
  const cue = currentGo(data);
  return fresh && productionIdentity(data) === watch.production && data.show.revision > watch.revision && cue && cue.revision > watch.revision && cue.id !== watch.baselineCue && pendingObservations(data.show).length === 0 ? cue : null;
}
