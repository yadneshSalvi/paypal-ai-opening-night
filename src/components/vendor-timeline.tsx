"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ProjectModel } from "@bryntum/gantt-enterprise";
import { BryntumGantt } from "@bryntum/gantt-react-enterprise";
import { BryntumScheduler, BryntumResourceHistogram } from "@bryntum/scheduler-react-enterprise";
import type { ProjectModel as SchedulerProject, TimelineBase } from "@bryntum/scheduler-enterprise";
import { timelineProjection } from "@/domain/adapters";
import type { CanvasProps } from "./production-canvas";
import { atVenue } from "@/domain/time";
import { taskAriaLabel, venueDayCells } from "@/domain/labels";
import { configureVenueAria } from "./vendor-locale";
import { nativeProductionAssistant } from "./intelligence/native-assistant";

export default function NativeTimeline({ tasks, dependencies, resources, licenseKey, full = false, mode = "split", onSelect, baseline = false, assistant }: CanvasProps) {
  const root = globalThis as typeof globalThis & { bryntum?: { licenseKey?: string } }; root.bryntum ??= {}; root.bryntum.licenseKey = licenseKey;
  const [project, setProject] = useState<ProjectModel | null>(null);
  const gantt = useRef<BryntumGantt>(null);
  const scheduler = useRef<BryntumScheduler>(null);
  const [partner, setPartner] = useState<TimelineBase | null>(null);
  const [ready, setReady] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const assistantRef = useRef(assistant); assistantRef.current = assistant;
  const aiFeature = useMemo(() => assistant ? nativeProductionAssistant({ ...assistant, onRun: run => assistantRef.current?.onRun(run), onTool: result => assistantRef.current?.onTool(result), onVoiceSaved: () => assistantRef.current?.onVoiceSaved?.() }) : false, [assistant?.tenantId, assistant?.initial?.id]);
  useEffect(() => {
    let live = true;
    configureVenueAria(() => gantt.current?.instance?.visibleDateRange ?? scheduler.current?.instance?.visibleDateRange);
    const instance = new ProjectModel({ timeZone: "America/Chicago", startDate: atVenue("10:00"), hoursPerDay: 24, daysPerWeek: 7, calendar: "all-hours", calendars: [{ id: "all-hours", name: "Explicit calls", unspecifiedTimeIsWorking: true }], ...timelineProjection(tasks, dependencies, resources, full) });
    setProject(instance); setReady(false);
    void instance.commitAsync().then(() => { if (live) setReady(true); });
    return () => { live = false; instance.destroy(); };
  }, [tasks, dependencies, resources, full]);
  useEffect(() => {
    if (!ready || mode !== "split") return;
    const instance = gantt.current?.instance;
    if (instance) setPartner(instance);
  }, [ready, mode]);
  useEffect(() => { if (container.current && gantt.current && scheduler.current) container.current.dataset.sharedProject = String(Object.is(gantt.current.instance.project, scheduler.current.instance.project)); }, [partner]);
  const common = { timeZone: "America/Chicago", autoAdjustTimeAxis: false, startDate: atVenue("14:30"), endDate: atVenue("23:45"), viewPreset: { base: "hourAndDay", headers: [{ unit: "day" as const, cellGenerator: venueDayCells }, { unit: "hour" as const, dateFormat: "LT" }] }, tickSize: 72, readOnly: true, rowHeight: 38, barMargin: 9, columnLines: true, eventColor: "#d6ad63", eventStyle: "rounded" as const };
  if (!project) return <div className="canvas-loading">Preparing the native production model…</div>;
  return <div className={`native-canvas ${mode}`} ref={container} data-bryntum="8.0.0" data-projection="read-only" data-native-ready={ready}>
    {mode !== "scheduler" && <BryntumGantt ref={gantt} {...common} aiFeature={aiFeature} project={project} height={mode === "split" ? 340 : 580} columns={[{ type: "name", text: "PRODUCTION CALL", width: 270 }]} taskEditFeature={false} taskMenuFeature={false} cellEditFeature={false} taskDragFeature={false} taskResizeFeature={false} baselinesFeature={baseline} criticalPathsFeature={true} dependenciesFeature={true} projectLinesFeature={false} ariaLabel="Production Gantt, venue time America Chicago" taskRenderer={({ taskRecord, renderData }) => { const task = tasks.find(t => t.id === String(taskRecord.id)); if (task) Object.assign(renderData, { ariaLabel: taskAriaLabel(task) }); return { tag: "span", text: taskRecord.name }; }} onTaskClick={({ taskRecord }) => onSelect?.(String(taskRecord.id))} />}
    {mode === "split" && <div className="canvas-divider"><span>CREW & EQUIPMENT</span><span>Shared production model · synchronized time axis</span></div>}
    {mode !== "gantt" && <BryntumScheduler ref={scheduler} {...common} project={project as unknown as SchedulerProject} {...(partner ? { partner } : {})} height={mode === "split" ? 210 : 540} columns={[{ text: "RESOURCE", field: "name", width: 270 }]} eventEditFeature={false} eventDragFeature={false} eventResizeFeature={false} eventMenuFeature={false} scheduleMenuFeature={false} dependenciesFeature={false} ariaLabel="Crew and equipment schedule, shared with Gantt" eventRenderer={({ eventRecord, renderData }) => { const task = tasks.find(t => t.id === String(eventRecord.id)); if (task) renderData.ariaLabel = taskAriaLabel(task); return { tag: "span", text: eventRecord.name }; }} />}
    {mode === "split" && partner && <details className="native-histogram"><summary>Resource utilization <span>Native histogram</span></summary><BryntumResourceHistogram config={{ timeZone: "America/Chicago" }} project={project as unknown as SchedulerProject} partner={partner} height={220} columns={[{ field: "name", text: "RESOURCE", width: 270 }]} /></details>}
  </div>;
}
