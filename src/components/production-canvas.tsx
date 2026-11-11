"use client";
import dynamic from "next/dynamic";
import { Component, type ReactNode } from "react";
import type { Dependency, Resource, Task } from "@/domain/contracts";
import { LoaderCircle } from "lucide-react";
import type { NativeCalendarProps } from "./vendor-calendar";
const NativeTimeline = dynamic(() => import("./vendor-timeline"), { ssr: false, loading: () => <div className="canvas-loading"><LoaderCircle className="spin" size={22} /><span>Opening the production graph…</span><small>Bryntum Enterprise · local projection</small></div> });
const NativeCalendar = dynamic(() => import("./vendor-calendar"), { ssr: false, loading: () => <div className="canvas-loading"><LoaderCircle className="spin" size={22} /><span>Opening the production calendar…</span></div> });
class CanvasBoundary extends Component<{ children: ReactNode; calendar?: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="empty-state" role="status"><h3>The {this.props.calendar ? "calendar" : "timeline"} could not open.</h3><p>{this.props.calendar ? "Your published calls remain available in the call list. Refresh to retry the native calendar." : "The canonical calls remain available below. Refresh to retry the native view."}</p><button className="button secondary" onClick={() => location.reload()}>Reload view</button></div> : this.props.children; }
}
export interface CanvasProps { tasks: Task[]; dependencies: Dependency[]; resources: Resource[]; licenseKey: string; full?: boolean; mode?: "split" | "gantt" | "scheduler"; onSelect?: (id: string) => void; baseline?: boolean }
export function ProductionCanvas(props: CanvasProps) { return <CanvasBoundary><NativeTimeline {...props} /></CanvasBoundary>; }
export function ProductionCalendar(props: NativeCalendarProps) { return <CanvasBoundary calendar><NativeCalendar {...props} /></CanvasBoundary>; }
