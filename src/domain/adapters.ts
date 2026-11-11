import type { Dependency, Resource, Task } from "./contracts";
export const laneColors = { lighting: "#d6ad63", audio: "#ac93c5", stage: "#81a597", people: "#a7b7c1", commercial: "#91b9de", house: "#c4ae86" };
export function timelineProjection(tasks: Task[], dependencies: Dependency[], resources: Resource[], full = false) {
  const visible = full ? tasks : tasks.filter(t => t.critical);
  const ids = new Set(visible.map(t => t.id));
  return {
    tasks: visible.map(t => ({ id: t.id, name: t.name, startDate: t.start, endDate: t.end, duration: t.durationMinutes, durationUnit: "minute" as const, manuallyScheduled: true, eventColor: laneColors[t.lane], cls: `${t.affected ? "on-affected" : ""} ${t.lane === "commercial" ? "on-money" : ""}`, percentDone: t.state === "complete" ? 100 : 0, baselines: [{ startDate: t.baselineStart, endDate: t.baselineEnd }] })),
    resources: resources.map(r => ({ id: r.id, name: r.name, role: r.role, eventColor: r.color })),
    assignments: visible.flatMap(t => t.resources.map(r => ({ id: `${t.id}:${r}`, eventId: t.id, resourceId: r }))),
    dependencies: dependencies.filter(d => ids.has(d.from) && ids.has(d.to)).map(d => { const confirmed = d.financial && tasks.find(t => t.id === d.from)?.state === "complete"; return { id: d.id, from: d.from, to: d.to, type: 2, lag: d.lagMinutes, lagUnit: "minute" as const, strokeColor: d.financial ? confirmed ? "#81b79d" : "#e6aa57" : "#ffb000", lineStyle: d.financial && !confirmed ? "dashed" as const : "solid" as const, cls: d.financial ? confirmed ? "on-money-confirmed" : "on-money-pending" : "" }; }),
  };
}
/** Calendar owns an independent model. IDs and UTC instants are projections of canonical tasks. */
export function calendarProjection(tasks: Task[], resources: Resource[], personId?: string) {
  const visible = tasks.filter(t => t.critical && (!personId || t.resources.includes(personId)));
  return {
    resources: (personId ? resources.filter(r => r.id === personId) : Object.entries(laneColors).map(([id, color]) => ({ id, name: id[0].toUpperCase() + id.slice(1), color }))).map(r => ({ id: r.id, name: r.name, eventColor: "color" in r ? r.color : "#e6aa57" })),
    events: visible.map(t => ({ id: t.id, name: t.name, startDate: t.start, endDate: t.durationMinutes ? t.end : new Date(Date.parse(t.start) + 5 * 60000).toISOString(), resourceId: personId ?? t.lane, eventColor: laneColors[t.lane], readOnly: true })),
  };
}
