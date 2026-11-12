"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BryntumGantt } from "@bryntum/gantt-react-enterprise";
import { BryntumScheduler } from "@bryntum/scheduler-react-enterprise";
import { StringHelper } from "@bryntum/core-enterprise";
import type { ProjectModel } from "@bryntum/gantt-enterprise";
import type { ProjectModel as SchedulerProject } from "@bryntum/scheduler-enterprise";
import { localTime } from "@/domain/time";
import { taskAriaLabel, venueDayCells } from "@/domain/labels";
import type { NativePresentationSnapshot, NativeSelectionProps } from "./native-canvas";

export function NativePresentationWidgets({ project, owned, selection, selectedTaskIds, selectedResourceIds, onSelect }: { project: ProjectModel; owned: NativePresentationSnapshot } & NativeSelectionProps) {
  const gantt = useRef<BryntumGantt>(null), scheduler = useRef<BryntumScheduler>(null), synchronizing = useRef(false);
  const [partnered, setPartnered] = useState(false), [range, setRange] = useState<{ startDate: Date; endDate: Date } | null>(null);
  const ganttLabel = useId(), schedulerLabel = useId(), { show, narrow, mode } = owned;
  const selectedOffer = selection?.kind === "supplier" ? show.offers.find(row => row.id === selection.id) : null;
  const [opening] = useState(() => {
    const selected = selectedTaskIds.map(id => show.tasks.find(row => row.id === id)).filter(row => Boolean(row));
    const start = selected.length ? Math.min(...selected.map(row => Date.parse(row!.start))) - 30 * 60000 : Date.parse(selectedOffer?.deliveryAt ?? show.clock) - 30 * 60000;
    return { start: new Date(start).toISOString(), end: new Date(start + 4 * 3600000).toISOString() };
  });
  const common = useMemo(() => ({
    timeZone: show.zone, autoAdjustTimeAxis: false, startDate: opening.start, endDate: opening.end,
    presets: [
      { id: "opening-presentation-half-hours", name: "Half-hour calls", useForSmoothZoom: false, tickWidth: 100, minTickWidth: 64, displayDateFormat: "HH:mm", shiftUnit: "hour" as const, shiftIncrement: 1, defaultSpan: 4, timeResolution: { unit: "minute" as const, increment: 15 }, headers: [{ unit: "day" as const, cellGenerator: venueDayCells }, { unit: "minute" as const, increment: 30, dateFormat: "HH:mm" }] },
      { id: "opening-presentation-hours", name: "Production hours", useForSmoothZoom: false, tickWidth: 104, minTickWidth: 64, displayDateFormat: "HH:mm", shiftUnit: "hour" as const, shiftIncrement: 1, defaultSpan: 8, timeResolution: { unit: "minute" as const, increment: 30 }, headers: [{ unit: "day" as const, cellGenerator: venueDayCells }, { unit: "hour" as const, dateFormat: "HH:mm" }] },
    ], viewPreset: "opening-presentation-hours", tickSize: 104,
    readOnly: true, detectCSSCompatibilityIssues: false, rowHeight: 56, barMargin: 13, columnLines: true,
    subGridConfigs: { locked: { width: narrow ? 150 : 310, minWidth: narrow ? 138 : 260 }, normal: { minWidth: 100 } },
    selectionMode: { row: true, multiSelect: false },
  }), [show.zone, opening, narrow]);
  const nameColumns = useMemo(() => [{ type: "name", text: "PRODUCTION CALL", htmlEncode: true, width: narrow ? 150 : 310, locked: true }], [narrow]);
  const resourceColumns = useMemo(() => [{ field: "name", text: "CREW & EQUIPMENT", htmlEncode: true, width: narrow ? 150 : 310, locked: true }], [narrow]);
  useLayoutEffect(() => {
    const first = gantt.current?.instance, second = scheduler.current?.instance;
    if (second && !second.isDestroying) {
      if (first && !first.isDestroying) { second.addPartner(first); setPartnered(first.isPartneredWith(second) && second.isPartneredWith(first)); }
      else setPartnered(true);
      const visible = (first ?? second).visibleDateRange; if (visible.startDate && visible.endDate) setRange({ startDate: visible.startDate, endDate: visible.endDate });
    }
  }, []);
  useEffect(() => {
    const first = gantt.current?.instance, second = scheduler.current?.instance;
    if (!second || second.isDestroying || project.isDestroying || first?.isDestroying) return;
    synchronizing.current = true;
    try {
      if (first) first.selectedRecords = selectedTaskIds.map(id => project.eventStore.getById(id)).filter(Boolean);
      second.selectedEvents = selectedTaskIds.map(id => second.eventStore.getById(id)).filter(Boolean) as typeof second.selectedEvents;
      second.selectedRecords = selectedResourceIds.map(id => second.resourceStore.getById(id)).filter(Boolean);
    } finally { synchronizing.current = false; }
  }, [project, selectedTaskIds, selectedResourceIds, partnered]);
  useEffect(() => {
    if (project.isDestroying) return;
    project.timeRangeStore.data = selectedOffer ? [{ id: "presentation-offer:" + selectedOffer.id, startDate: selectedOffer.deliveryAt, endDate: selectedOffer.deliveryAt, duration: 0, durationUnit: "minute", name: "PROPOSED DELIVERY · " + selectedOffer.supplier + " · r" + selectedOffer.revision, cls: "presentation-proposed-delivery" }] : [];
  }, [project, selectedOffer]);
  const timeRanges = useMemo(() => ({ showHeaderElements: true, showCurrentTimeLine: false, showMouseIndicatorLine: false, enableResizing: false, headerRenderer: ({ timeRange }: { timeRange: { name: string } }) => StringHelper.encodeHtml(timeRange.name), bodyRenderer: () => "" }), []);
  const choose = (kind: "task" | "resource", id: string) => { if (!synchronizing.current && (selection?.kind !== kind || selection.id !== id)) onSelect({ kind, id }); };
  const selectedTask = selectedTaskIds.find(id => project.eventStore.getById(id));
  async function reveal() {
    if (!selectedTask && !selectedOffer) return;
    const first = gantt.current?.instance, second = scheduler.current?.instance;
    if (selectedOffer) { const widget = first ?? second; if (widget && !widget.isDestroying) await widget.scrollToDate(new Date(selectedOffer.deliveryAt), { block: "center", animate: false }); }
    else if (first && !first.isDestroying) await first.scrollTaskIntoView(selectedTask!, { animate: false });
    else if (second && !second.isDestroying) await second.scrollEventIntoView(selectedTask!, { animate: false });
  }
  const rangeLabel = range ? localTime(range.startDate.toISOString()) + "–" + localTime(range.endDate.toISOString()) + " CST" : "America/Chicago venue time";
  return <div className="presentation-native" data-native-ready={partnered} data-shared-project={mode === "split" && partnered && gantt.current?.instance.project === scheduler.current?.instance.project} data-production={show.tenantId + ":" + show.id} data-revision={show.revision} data-bryntum="8.0.0" data-projection="read-only" data-selected-task={selectedTask ?? ""}>
    <div className="presentation-native-toolbar"><p id={ganttLabel}>Native production schedule · {rangeLabel}</p><button type="button" disabled={!selectedTask && !selectedOffer} onClick={() => void reveal()}>{selectedOffer ? "Reveal proposed delivery" : "Reveal selected call"}</button></div>
    {selectedOffer && <p className="presentation-native-divider">Ghost source line: {selectedOffer.supplier} r{selectedOffer.revision} proposes {localTime(selectedOffer.deliveryAt)} CST. No task, hold, delivery or approval is created.</p>}
    {mode === "split" && <BryntumGantt ref={gantt} {...common} project={project} height={430} columns={nameColumns} taskEditFeature={false} taskMenuFeature={false} cellEditFeature={false} taskDragFeature={false} taskResizeFeature={false} baselinesFeature dependenciesFeature timeRangesFeature={timeRanges} projectLinesFeature={false} ariaLabel="Presentation production Gantt in America Chicago, read only" onVisibleDateRangeChange={event => setRange(event.new)} onTaskClick={({ taskRecord }) => choose("task", String(taskRecord.id))} onSelectionChange={({ selected }) => { const id = selected[0]?.id; if (id) choose("task", String(id)); }} taskRenderer={({ taskRecord, renderData }) => { const task = show.tasks.find(row => row.id === String(taskRecord.id)); if (task) Object.assign(renderData, { ariaLabel: taskAriaLabel(task) }); return { tag: "span", text: taskRecord.name }; }} />}
    <p id={schedulerLabel} className="presentation-native-divider">Crew & equipment · {mode === "split" ? "same committed model and partnered time axis" : "current canonical assignments"}</p>
    <BryntumScheduler ref={scheduler} {...common} project={project as unknown as SchedulerProject} height={mode === "split" ? 260 : 540} columns={resourceColumns} eventEditFeature={false} eventDragFeature={false} eventResizeFeature={false} eventMenuFeature={false} scheduleMenuFeature={false} cellEditFeature={false} dependenciesFeature={false} timeRangesFeature={timeRanges} ariaLabel="Presentation crew and equipment scheduler, read only" onVisibleDateRangeChange={event => { if (mode === "scheduler") setRange(event.new); }} onEventClick={({ eventRecord }) => choose("task", String(eventRecord.id))} onEventSelectionChange={({ selected }) => { const id = selected[0]?.id; if (id) choose("task", String(id)); }} onSelectionChange={({ selected }) => { const id = selected[0]?.id; if (id) choose("resource", String(id)); }} eventRenderer={({ eventRecord, renderData }) => { const task = show.tasks.find(row => row.id === String(eventRecord.id)); if (task) Object.assign(renderData, { ariaLabel: taskAriaLabel(task) }); return { tag: "span", text: eventRecord.name }; }} />
  </div>;
}
