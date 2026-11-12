"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ProjectModel } from "@bryntum/gantt-enterprise";
import { ProjectModel as CalendarProject } from "@bryntum/calendar-enterprise";
import { BryntumGantt } from "@bryntum/gantt-react-enterprise";
import { BryntumScheduler } from "@bryntum/scheduler-react-enterprise";
import type { ProjectModel as SchedulerProject, TimelineBase } from "@bryntum/scheduler-enterprise";
import { BryntumCalendar } from "@bryntum/calendar-react-enterprise";
import type { PlannedProduction, TourResource } from "@/domain/tour/contracts";
import { laneColors } from "@/domain/adapters";
import { canonicalCallId, callResources, selectCanonical, type TourSelection } from "./selection";
import { nativeCallLabel, nativeRangeLabel } from "./native-clock";

export interface NativeTourProps { productions: PlannedProduction[]; baseline: PlannedProduction[]; resources: TourResource[]; zone: string; licenseKey: string; mode: "timeline" | "calendar"; selection: TourSelection | null; onSelect: (value: TourSelection) => void }
type Snapshot = Omit<NativeTourProps, "licenseKey" | "selection" | "onSelect">;
type LiveSelection = Pick<NativeTourProps, "selection" | "onSelect">;
type DateRange = { startDate: Date; endDate: Date };

function projectSnapshot({ productions, baseline, resources }: Snapshot) {
  const flat = productions.flatMap(production => production.calls.map(call => ({ production, call, id: canonicalCallId(production.id, call.id), name: `${production.venue.city} · ${call.label}` })));
  const dates = flat.flatMap(value => [Date.parse(value.call.start.instant), Date.parse(value.call.end.instant)]);
  const start = new Date(dates.length ? Math.min(...dates) - 3600000 : Date.now()).toISOString();
  const end = new Date(dates.length ? Math.max(...dates) + 3600000 : Date.now() + 86400000).toISOString();
  const projection = {
    tasks: flat.map(({ production, call, id, name }) => {
      const prior = baseline.find(value => value.id === production.id)?.calls.find(value => value.id === call.id);
      return { id, name, startDate: call.start.instant, endDate: call.end.instant, duration: call.durationMinutes, durationUnit: "minute" as const, manuallyScheduled: true, eventColor: laneColors[call.lane], percentDone: 0, baselines: [{ startDate: prior?.start.instant ?? call.start.instant, endDate: prior?.end.instant ?? call.end.instant }] };
    }),
    dependencies: productions.flatMap(production => production.dependencies.map(edge => ({ id: canonicalCallId(production.id, edge.id), from: canonicalCallId(production.id, edge.from), to: canonicalCallId(production.id, edge.to), type: 2, lag: edge.lagMinutes, lagUnit: "minute" as const }))),
    resources: resources.map(resource => ({ id: resource.id, name: resource.label, eventColor: resource.kind === "person" ? "#d4b27b" : "#91b9de" })),
    assignments: flat.flatMap(({ production, call, id }) => [...new Set(callResources(production, call))].map(resourceId => ({ id: `${id}:${resourceId}`, eventId: id, resourceId }))),
  };
  const calendar = {
    events: flat.map(({ call, id, name }) => ({ id, name, startDate: call.start.instant, endDate: call.end.instant, resourceId: call.lane, eventColor: laneColors[call.lane], readOnly: true })),
    resources: ["stage", "lighting", "audio", "house", "people"].map(id => ({ id, name: id, eventColor: laneColors[id as keyof typeof laneColors] })),
  };
  return { flat, start, end, projection, calendar };
}

// Each keyed owner has one immutable snapshot. Class-wrapper unmounts run before
// this passive cleanup, so widgets detach from their stores before project.destroy.
// An obsolete commit can never publish its instance into the next owner's state.
function useOwnedProject<T extends { commitAsync: () => Promise<unknown>; destroy: () => void; isDestroyed: boolean }>(create: () => T) {
  const factory = useRef(create);
  const [project, setProject] = useState<T | null>(null), [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    const instance = factory.current();
    void instance.commitAsync().then(() => { if (live && !instance.isDestroyed) setProject(instance); }, () => { if (live) setError(true); });
    return () => { live = false; if (!instance.isDestroyed) instance.destroy(); };
  }, []);
  return { project, error };
}

export default function NativeTour({ licenseKey, selection, onSelect, ...snapshot }: NativeTourProps) {
  const root = globalThis as typeof globalThis & { bryntum?: { licenseKey?: string } };
  root.bryntum ??= {}; root.bryntum.licenseKey = licenseKey;
  // Selection and callback changes keep the model. A new edition, preview, zone
  // or mode replaces the entire ownership boundary, never a live widget's store.
  const identity = JSON.stringify(snapshot);
  return <ProjectionOwner key={identity} snapshot={snapshot} selection={selection} onSelect={onSelect} />;
}

function ProjectionOwner({ snapshot, ...selection }: { snapshot: Snapshot } & LiveSelection) {
  const [owned] = useState(() => ({ ...snapshot, ...projectSnapshot(snapshot) }));
  return owned.mode === "calendar" ? <CalendarProjection owned={owned} {...selection} /> : <TimelineProjection owned={owned} {...selection} />;
}
type OwnedSnapshot = Snapshot & ReturnType<typeof projectSnapshot>;
function selectedIds(owned: OwnedSnapshot, selection: TourSelection | null) {
  return selection ? owned.flat.filter(({ production, call }) => production.id === selection.productionId && (selection.callId ? call.id === selection.callId : selection.resourceId ? callResources(production, call).includes(selection.resourceId) : false)).map(value => value.id) : [];
}
function NativeLoading({ error }: { error: boolean }) {
  return error ? <p className="tour-inline-warning" role="alert">The native timeline could not load. The canonical call list remains available below.</p> : <div className="tour-native-loading" role="status">Preparing the native production model…</div>;
}

function TimelineProjection({ owned, selection, onSelect }: { owned: OwnedSnapshot } & LiveSelection) {
  const { zone, start, projection } = owned;
  const { project, error } = useOwnedProject(() => new ProjectModel({ timeZone: zone, startDate: start, hoursPerDay: 24, daysPerWeek: 7, calendar: "all-hours", calendars: [{ id: "all-hours", name: "Exact canonical calls", unspecifiedTimeIsWorking: true }], ...projection }));
  if (!project || error) return <NativeLoading error={error} />;
  return <TimelineWidgets project={project} owned={owned} selection={selection} onSelect={onSelect} />;
}

function TimelineWidgets({ project, owned, selection, onSelect }: { project: ProjectModel; owned: OwnedSnapshot } & LiveSelection) {
  const { zone, start, end, flat } = owned;
  const gantt = useRef<BryntumGantt>(null), scheduler = useRef<BryntumScheduler>(null), synchronizing = useRef(false);
  const [partner, setPartner] = useState<TimelineBase | null>(null);
  const [ganttRange, setGanttRange] = useState<DateRange>({ startDate: new Date(start), endDate: new Date(end) });
  const [schedulerRange, setSchedulerRange] = useState<DateRange>(ganttRange);
  const ganttLabel = useId(), schedulerLabel = useId();
  const names = useMemo(() => new Map(flat.map(item => [item.id, nativeCallLabel(item, zone)])), [flat, zone]);
  const common = useMemo(() => ({
    timeZone: zone, autoAdjustTimeAxis: false, startDate: start, endDate: end,
    // Each scale appears once in this view's zoom chain. The inherited preset
    // collection contains two equivalent six-hour scales that collide in v8.
    presets: [
      { id: "opening-night-tour-days", base: "dayAndWeek" },
      { id: "opening-night-tour-six-hours", base: "hourAndDay", headers: [{ unit: "day" as const, dateFormat: "ddd D MMM" }, { unit: "hour" as const, increment: 6, dateFormat: "HH:mm" }] },
      { id: "opening-night-tour-hours", base: "hourAndDay" },
    ],
    viewPreset: "opening-night-tour-six-hours",
    tickSize: 72, readOnly: true, rowHeight: 40, barMargin: 10, columnLines: true,
  }), [zone, start, end]);
  const ganttColumns = useMemo(() => [{ type: "name", text: "CANONICAL CALL", width: 265 }, { type: "timeAxis", headerRenderer: ({ headerElement }: { headerElement: HTMLElement }) => { headerElement.setAttribute("aria-labelledby", ganttLabel); } }], [ganttLabel]);
  const schedulerColumns = useMemo(() => [{ text: "RESOURCE", field: "name", width: 265 }, { type: "timeAxis", headerRenderer: ({ headerElement }: { headerElement: HTMLElement }) => { headerElement.setAttribute("aria-labelledby", schedulerLabel); } }], [schedulerLabel]);
  useLayoutEffect(() => {
    const first = gantt.current?.instance, second = scheduler.current?.instance;
    if (first && second && !first.isDestroying && !second.isDestroying) {
      setPartner(first);
      const firstRange = first.visibleDateRange, secondRange = second.visibleDateRange;
      if (firstRange.startDate && firstRange.endDate) setGanttRange({ startDate: firstRange.startDate, endDate: firstRange.endDate });
      if (secondRange.startDate && secondRange.endDate) setSchedulerRange({ startDate: secondRange.startDate, endDate: secondRange.endDate });
    }
  }, []);
  useEffect(() => {
    const first = gantt.current?.instance, second = scheduler.current?.instance;
    if (!first || !second || first.isDestroying || second.isDestroying || project.isDestroying || !Object.is(first.project, project) || !Object.is(second.project, project)) return;
    const ids = selectedIds(owned, selection);
    synchronizing.current = true;
    try {
      first.selectedRecords = ids.map(id => project.eventStore.getById(id)).filter(Boolean);
      second.selectedEvents = ids.map(id => second.eventStore.getById(id)).filter(Boolean) as typeof second.selectedEvents;
    } finally { synchronizing.current = false; }
  }, [owned, selection, project, partner]);
  const choose = (id: string, resourceId: string | null = null) => { if (!synchronizing.current) { const selected = selectCanonical(owned.productions, id, resourceId); if (selected) onSelect(selected); } };
  return <div className="tour-native" data-native-ready={Boolean(partner)} data-shared-project={Boolean(partner && gantt.current?.instance.project === scheduler.current?.instance.project)} data-bryntum="8.0.0" data-projection="read-only" data-selected-canonical={selection?.callId ? canonicalCallId(selection.productionId, selection.callId) : ""} data-display-zone={zone}>
    <p id={ganttLabel} className="tour-native-clock">{nativeRangeLabel("Gantt", ganttRange, zone)}</p>
    <BryntumGantt ref={gantt} {...common} project={project} height={430} columns={ganttColumns} taskEditFeature={false} taskMenuFeature={false} cellEditFeature={false} taskDragFeature={false} taskResizeFeature={false} baselinesFeature dependenciesFeature projectLinesFeature={false} ariaLabel={`Cross-production Gantt in ${zone}`} onVisibleDateRangeChange={event => setGanttRange(event.new)} onTaskClick={({ taskRecord }) => choose(String(taskRecord.id))} onSelectionChange={({ selected }) => { const id = selected[0]?.id; if (id && id !== (selection?.callId ? canonicalCallId(selection.productionId, selection.callId) : "")) choose(String(id)); }} taskRenderer={({ taskRecord, renderData }) => { Object.assign(renderData, { ariaLabel: names.get(String(taskRecord.id)) }); return { tag: "span", text: taskRecord.name }; }} />
    <div className="tour-native-divider"><span>SHARED CREW & EQUIPMENT</span><span>Same project model · synchronized time axis</span></div>
    <p id={schedulerLabel} className="tour-native-clock">{nativeRangeLabel("Resource scheduler", schedulerRange, zone)}</p>
    <BryntumScheduler ref={scheduler} {...common} project={project as unknown as SchedulerProject} {...(partner ? { partner } : {})} height={250} columns={schedulerColumns} eventEditFeature={false} eventDragFeature={false} eventResizeFeature={false} eventMenuFeature={false} scheduleMenuFeature={false} dependenciesFeature={false} ariaLabel={`Tour resource scheduler in ${zone}`} onVisibleDateRangeChange={event => setSchedulerRange(event.new)} onEventClick={({ eventRecord, resourceRecord }) => choose(String(eventRecord.id), String(resourceRecord.id))} eventRenderer={({ eventRecord, renderData }) => { Object.assign(renderData, { ariaLabel: names.get(String(eventRecord.id)) }); return { tag: "span", text: eventRecord.name }; }} />
  </div>;
}

function CalendarProjection({ owned, selection, onSelect }: { owned: OwnedSnapshot } & LiveSelection) {
  const { zone, start, calendar: projection } = owned;
  const calendar = useRef<BryntumCalendar>(null);
  const { project, error } = useOwnedProject(() => new CalendarProject({ timeZone: zone, ...projection }));
  useEffect(() => {
    const widget = calendar.current?.instance;
    if (!project || project.isDestroying || !widget || widget.isDestroying || widget.project !== project) return;
    widget.selectedEvents = selectedIds(owned, selection).map(id => widget.eventStore.getById(id)).filter(Boolean) as typeof widget.selectedEvents;
  }, [owned, selection, project]);
  if (!project || error) return <NativeLoading error={error} />;
  return <div className="tour-native" data-native-ready="true" data-bryntum="8.0.0" data-projection="read-only" data-selected-canonical={selection?.callId ? canonicalCallId(selection.productionId, selection.callId) : ""} data-display-zone={zone}>
    <BryntumCalendar ref={calendar} date={start} timeZone={zone} project={project} destroyStores={false} mode="week" modes={{ day: { dayStartTime: 0, dayEndTime: 24 }, week: { dayStartTime: 0, dayEndTime: 24 }, agenda: true, year: false, month: false }} height={650} sidebar={false} readOnly eventEditFeature={false} eventMenuFeature={false} dragFeature={false} ariaLabel={`Tour calendar in ${zone}; canonical calls`} onEventClick={({ eventRecord }) => { const selected = selectCanonical(owned.productions, String(eventRecord.id)); if (selected) onSelect(selected); }} />
  </div>;
}
