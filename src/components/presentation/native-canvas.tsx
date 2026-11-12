"use client";
import { useEffect, useState } from "react";
import { ProjectModel } from "@bryntum/gantt-enterprise";
import type { ShowSnapshot } from "@/domain/contracts";
import { timelineProjection } from "@/domain/adapters";
import type { ProductionSelection } from "./model";
import { NativePresentationWidgets } from "./native-widgets";

export interface PresentationCanvasProps {
  show: ShowSnapshot; licenseKey: string; selection: ProductionSelection | null;
  selectedTaskIds: string[]; selectedResourceIds: string[];
  onSelect: (selection: ProductionSelection) => void;
  full?: boolean; narrow?: boolean; mode?: "split" | "scheduler";
}
export interface NativePresentationSnapshot { show: ShowSnapshot; full: boolean; narrow: boolean; mode: "split" | "scheduler" }
export type NativeSelectionProps = Pick<PresentationCanvasProps, "selection" | "selectedTaskIds" | "selectedResourceIds" | "onSelect">;
export default function PresentationNativeCanvas({ licenseKey, full = false, narrow = false, mode = "split", ...props }: PresentationCanvasProps) {
  const global = globalThis as typeof globalThis & { bryntum?: { licenseKey?: string } }; global.bryntum ??= {}; global.bryntum.licenseKey = licenseKey;
  // Selection preserves the widget. A new scope/edition/layout owns a new immutable model.
  const identity = JSON.stringify([props.show.tenantId, props.show.id, props.show.revision, full, narrow, mode]);
  return <NativeOwner key={identity} snapshot={{ show: props.show, full, narrow, mode }} selection={props.selection} selectedTaskIds={props.selectedTaskIds} selectedResourceIds={props.selectedResourceIds} onSelect={props.onSelect} />;
}
function NativeOwner({ snapshot, ...selection }: { snapshot: NativePresentationSnapshot } & NativeSelectionProps) {
  const [owned] = useState(() => ({ ...snapshot, show: structuredClone(snapshot.show) }));
  const [project, setProject] = useState<ProjectModel | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let instance: ProjectModel;
    try { instance = new ProjectModel({ timeZone: owned.show.zone, startDate: owned.show.tasks[0]?.start ?? owned.show.clock, hoursPerDay: 24, daysPerWeek: 7, calendar: "presentation-all-hours", calendars: [{ id: "presentation-all-hours", name: "Canonical explicit calls", unspecifiedTimeIsWorking: true }], ...timelineProjection(owned.show.tasks, owned.show.dependencies, owned.show.resources, owned.full) }); }
    catch { setFailed(true); return; }
    void instance.commitAsync().then(() => { if (active && !instance.isDestroyed) setProject(instance); }, () => { if (active) setFailed(true); });
    return () => { active = false; if (!instance.isDestroyed) instance.destroy(); };
  }, [owned]);
  if (failed) return <div className="presentation-native-fallback" role="alert"><h3>The native schedule could not open.</h3><p>The canonical call list and evidence remain available. Reopen this view to retry the installed widget.</p></div>;
  return project ? <NativePresentationWidgets project={project} owned={owned} {...selection} /> : <div className="presentation-native-fallback" role="status">Preparing the current native schedule…</div>;
}
