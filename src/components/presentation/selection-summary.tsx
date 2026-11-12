"use client";
import Link from "next/link";
import { useLinkedSelection } from "./selection";
export function LinkedSelectionSummary() {
  const linked = useLinkedSelection();
  if (!linked?.active || !linked.detail) return null;
  return <div className="presentation-linked-summary"><span>Linked selection: <strong>{linked.detail.title}</strong></span><span>{linked.detail.tasks.length} calls · {linked.detail.resources.length} resources</span><Link href="/presentation">Follow in presentation</Link><button type="button" onClick={() => linked.clear(true)}>Clear selection</button></div>;
}
