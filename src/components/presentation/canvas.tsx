"use client";
import dynamic from "next/dynamic";
import { Component, type ReactNode } from "react";
import type { PresentationCanvasProps } from "./native-canvas";
const NativeCanvas = dynamic(() => import("./native-canvas"), { ssr: false, loading: () => <div className="presentation-native-fallback" role="status">Opening the installed native schedule… Canonical calls remain available below.</div> });
class NativeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="presentation-native-fallback" role="alert"><h3>The native view could not open.</h3><p>The canonical calls and source evidence remain available. Reopen this view to retry; no schedule state changed.</p></div> : this.props.children; }
}
export function PresentationCanvas(props: PresentationCanvasProps) { return <NativeBoundary key={JSON.stringify([props.show.tenantId, props.show.id, props.show.revision])}><NativeCanvas {...props} /></NativeBoundary>; }
