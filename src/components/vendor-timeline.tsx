"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Printer } from "lucide-react";
import { ProjectModel } from "@bryntum/gantt-enterprise";
import { BryntumGantt } from "@bryntum/gantt-react-enterprise";
import { BryntumScheduler, BryntumResourceHistogram } from "@bryntum/scheduler-react-enterprise";
import type { ProjectModel as SchedulerProject, TimelineBase } from "@bryntum/scheduler-enterprise";
import { timelineProjection } from "@/domain/adapters";
import type { CanvasProps, RunSheetPrint } from "./production-canvas";
import { atVenue } from "@/domain/time";
import { taskAriaLabel, venueDayCells } from "@/domain/labels";
import { configureVenueAria } from "./vendor-locale";
import { nativeProductionAssistant } from "./intelligence/native-assistant";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
/** Header and footer repeated on every printed page. The values are escaped: they include show and plan names. */
export function runSheetPrintTemplates(print: RunSheetPrint) {
  return {
    headerTpl: ({ currentPage, totalPages }: { currentPage: number; totalPages: number }) => `<div class="run-sheet-print-header"><strong>${escapeHtml(print.title)}</strong><span>${escapeHtml(print.plan)}</span><span>${escapeHtml(print.clock)}</span><span>Page ${currentPage + 1} of ${totalPages}</span></div>`,
    footerTpl: () => `<div class="run-sheet-print-footer">${escapeHtml(print.provenance)}</div>`,
  };
}
export default function NativeTimeline({ tasks, dependencies, resources, licenseKey, full = false, mode = "split", onSelect, baseline = false, assistant, print }: CanvasProps) {
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
  const printKey = print ? JSON.stringify(print) : "", [printing, setPrinting] = useState(false), [printNote, setPrintNote] = useState("");
  // Bryntum's Print feature (Enterprise) lays the widget out in a hidden frame and opens the browser's print dialog,
  // where "Save as PDF" produces the file. PdfExport itself needs a separate export server, which this app does not run.
  const printFeature = useMemo(() => print ? { exporterType: "multipagevertical", paperFormat: "Letter", orientation: "landscape", rowsRange: "all", repeatHeader: true, ...runSheetPrintTemplates(print) } : false, [printKey]);
  const printRunSheet = async () => {
    const instance = gantt.current?.instance; if (!instance || printing) return;
    setPrinting(true); setPrintNote("Preparing the paper run sheet…");
    try {
      // Task dates are already in the widget's venue-zone representation, so the printed range needs no conversion.
      const records = instance.taskStore.records as { startDate?: Date; endDate?: Date }[], starts = records.map(row => row.startDate?.getTime()).filter((value): value is number => Number.isFinite(value)), ends = records.map(row => row.endDate?.getTime()).filter((value): value is number => Number.isFinite(value));
      const range = starts.length && ends.length ? { scheduleRange: "daterange", rangeStart: new Date(Math.floor(Math.min(...starts) / 3_600_000) * 3_600_000), rangeEnd: new Date(Math.ceil(Math.max(...ends) / 3_600_000) * 3_600_000) } : { scheduleRange: "completeview" };
      const result = await (instance.features as unknown as { print: { print(config: object): Promise<{ error?: unknown } | undefined> } }).print.print(range);
      setPrintNote(result?.error ? "The print view could not be prepared. “Print production pack” still prints the call list." : "");
    } catch { setPrintNote("The print view could not be prepared. “Print production pack” still prints the call list."); } finally { setPrinting(false); }
  };
  const common = { timeZone: "America/Chicago", autoAdjustTimeAxis: false, startDate: atVenue("14:30"), endDate: atVenue("23:45"), viewPreset: { base: "hourAndDay", headers: [{ unit: "day" as const, cellGenerator: venueDayCells }, { unit: "hour" as const, dateFormat: "LT" }] }, tickSize: 72, readOnly: true, rowHeight: 38, barMargin: 9, columnLines: true, eventColor: "#d6ad63", eventStyle: "rounded" as const };
  if (!project) return <div className="canvas-loading">Preparing the native production model…</div>;
  return <div className={`native-canvas ${mode}`} ref={container} data-bryntum="8.0.0" data-projection="read-only" data-native-ready={ready}>
    {print && mode !== "scheduler" && <div className="canvas-actions"><button type="button" className="button secondary" onClick={() => void printRunSheet()} disabled={!ready || printing}><Printer size={14} />Print run sheet · save as PDF</button><small role="status">{printNote || "Bryntum Gantt Print: a light, paged run sheet in your browser’s print dialog."}</small></div>}
    {mode !== "scheduler" && <BryntumGantt ref={gantt} {...common} aiFeature={aiFeature} printFeature={printFeature} project={project} height={mode === "split" ? 340 : 580} columns={[{ type: "name", text: "PRODUCTION CALL", width: 270 }]} taskEditFeature={false} taskMenuFeature={false} cellEditFeature={false} taskDragFeature={false} taskResizeFeature={false} baselinesFeature={baseline} criticalPathsFeature={true} dependenciesFeature={true} projectLinesFeature={false} ariaLabel="Production Gantt, venue time America Chicago" taskRenderer={({ taskRecord, renderData }) => { const task = tasks.find(t => t.id === String(taskRecord.id)); if (task) Object.assign(renderData, { ariaLabel: taskAriaLabel(task) }); return { tag: "span", text: taskRecord.name }; }} onTaskClick={({ taskRecord }) => onSelect?.(String(taskRecord.id))} />}
    {mode === "split" && <div className="canvas-divider"><span>CREW & EQUIPMENT</span><span>Shared production model · synchronized time axis</span></div>}
    {mode !== "gantt" && <BryntumScheduler ref={scheduler} {...common} project={project as unknown as SchedulerProject} {...(partner ? { partner } : {})} height={mode === "split" ? 210 : 540} columns={[{ text: "RESOURCE", field: "name", width: 270 }]} eventEditFeature={false} eventDragFeature={false} eventResizeFeature={false} eventMenuFeature={false} scheduleMenuFeature={false} dependenciesFeature={false} ariaLabel="Crew and equipment schedule, shared with Gantt" eventRenderer={({ eventRecord, renderData }) => { const task = tasks.find(t => t.id === String(eventRecord.id)); if (task) renderData.ariaLabel = taskAriaLabel(task); return { tag: "span", text: eventRecord.name }; }} />}
    {mode === "split" && partner && <details className="native-histogram"><summary>Resource utilization <span>Native histogram</span></summary><BryntumResourceHistogram config={{ timeZone: "America/Chicago" }} project={project as unknown as SchedulerProject} partner={partner} height={220} columns={[{ field: "name", text: "RESOURCE", width: 270 }]} /></details>}
  </div>;
}
