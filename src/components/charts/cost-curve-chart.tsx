"use client";
import { useEffect, useRef, useState } from "react";
import { AgCharts, AllCommunityModule, ModuleRegistry, type AgChartInstance, type AgChartOptions } from "ag-charts-community";
import type { CostCurve } from "@/domain/cost-curve";
import { formatMoney } from "@/domain/time";
import { useThemeName } from "../theme-toggle";
import { chartPalette } from "./palette";
import { venueClock } from "./format";
ModuleRegistry.registerModules([AllCommunityModule]);

interface Row { t: number; baseline: number; current: number; preview: number | null; hold: number }
const money = (value: unknown) => formatMoney(Number(value) * 100, true);

/** AG Charts line chart of the curve. The exact same numbers are in the table beside it. */
export default function CostCurveChart({ curve }: { curve: CostCurve }) {
  const host = useRef<HTMLDivElement>(null), instance = useRef<AgChartInstance | null>(null), [failed, setFailed] = useState(false), theme = useThemeName();
  useEffect(() => {
    if (!host.current) return;
    const palette = chartPalette(), day = curve.startAt;
    const rows: Row[] = curve.points.map(point => ({ t: Date.parse(point.at), baseline: point.baselineMinor / 100, current: point.currentMinor / 100, preview: point.candidateMinor === null ? null : point.candidateMinor / 100, hold: point.holdMinor / 100 }));
    const label = (value: unknown) => venueClock(new Date(Number(value)).toISOString(), day);
    const start = Date.parse(curve.startAt), end = Date.parse(curve.endAt), hours: number[] = [];
    for (let at = Math.ceil(start / 3_600_000) * 3_600_000; at <= end; at += 3_600_000) hours.push(at);
    const commitments = [...curve.current.commitments.map(row => ({ plan: curve.current, row })), ...(curve.candidate?.commitments ?? []).map(row => ({ plan: curve.candidate!, row }))].map(({ plan, row }) => ({ t: Date.parse(row.at), value: rows.findLast(point => point.t === Date.parse(row.at))?.[plan.key === "candidate" ? "preview" : "current"] ?? 0, name: row.label, amount: row.amountMinor / 100, state: row.confirmation === "confirmed" ? "Confirmed by provider record" : row.confirmation === "partly_confirmed" ? `${money(row.confirmedMinor / 100)} confirmed by provider record` : "Modeled, not a payment" }));
    const line = (yKey: keyof Row, yName: string, stroke: string, lineDash?: number[]) => ({ type: "line" as const, data: rows, xKey: "t", yKey, yName, stroke, strokeWidth: yKey === "current" ? 2.5 : 1.75, ...(lineDash ? { lineDash } : {}), marker: { enabled: false }, tooltip: { renderer: ({ datum }: { datum: Row }) => ({ title: `${label(datum.t)} venue time`, data: [{ label: yName, value: money(datum[yKey]) }] }) } });
    const clock = Date.parse(curve.clock);
    const options: AgChartOptions = {
      container: host.current, height: 340, theme: theme === "light" ? "ag-default" : "ag-default-dark", background: { fill: palette.surface }, animation: { enabled: false }, padding: { top: 18, right: 18, bottom: 12, left: 12 },
      legend: { position: "bottom", item: { label: { color: palette.text, fontSize: 11 } } },
      series: [
        line("baseline", curve.baseline.label, palette.baseline, [6, 4]),
        line("current", curve.current.label, palette.plan),
        ...(curve.candidate ? [line("preview", curve.candidate.label, palette.preview, [2, 3])] : []),
        ...(rows.some(row => row.hold > 0) ? [line("hold", "Deposit hold (authorization, not a cost)", palette.hold, [1, 4])] : []),
        ...(commitments.length ? [{ type: "scatter" as const, data: commitments, xKey: "t", yKey: "value", yName: "Dated recovery commitment", shape: "diamond" as const, size: 10, fill: palette.surface, stroke: palette.text, strokeWidth: 1.5, tooltip: { renderer: ({ datum }: { datum: (typeof commitments)[number] }) => ({ title: `${datum.name} · ${label(datum.t)}`, data: [{ label: "Planned amount", value: money(datum.amount) }, { label: "Status", value: datum.state }] }) } }] : []),
      ],
      axes: {
        x: { type: "number", min: start, max: end, nice: false, interval: { values: hours }, label: { color: palette.axis, fontSize: 10, formatter: ({ value }) => label(value) }, line: { stroke: palette.grid }, gridLine: { enabled: false }, ...(clock >= start && clock <= end ? { crossLines: [{ type: "line" as const, value: clock, stroke: palette.axis, strokeWidth: 1, lineDash: [3, 3], label: { text: `Scenario clock ${label(clock)}`, color: palette.axis, fontSize: 10, position: "inside-top-right" as const } }] } : {}) },
        y: { type: "number", min: 0, label: { color: palette.axis, fontSize: 10, formatter: ({ value }) => formatMoney(Number(value) * 100) }, gridLine: { style: [{ stroke: palette.grid, lineDash: [3, 4] }] } },
      },
    };
    try { instance.current = AgCharts.create(options); setFailed(false); } catch { setFailed(true); }
    return () => { instance.current?.destroy(); instance.current = null; };
  }, [curve, theme]);
  return <>{failed ? <p role="status" className="cost-curve-fallback">Chart unavailable; the same values are in the tables below.</p> : null}<div ref={host} className="cost-curve-canvas" role="img" aria-label={`Cumulative planned cost over the show day in venue time. ${curve.baseline.label} ends at ${formatMoney(curve.baseline.totalMinor, true)}; ${curve.current.label} ends at ${formatMoney(curve.current.totalMinor, true)}${curve.candidate ? `; ${curve.candidate.label} ends at ${formatMoney(curve.candidate.totalMinor, true)}` : ""}. Exact values follow in the data table.`} /></>;
}
