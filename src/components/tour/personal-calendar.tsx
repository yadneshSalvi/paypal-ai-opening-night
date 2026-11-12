"use client";
import { useMemo } from "react";
import { BryntumCalendar } from "@bryntum/calendar-react-enterprise";
import type { PersonalTour } from "@/domain/tour/contracts";
export default function PersonalTourCalendar({ data, zone, date, licenseKey, onSelect }: { data: PersonalTour; zone: string; date: string; licenseKey: string; onSelect: (id: string) => void }) {
  const root = globalThis as typeof globalThis & { bryntum?: { licenseKey?: string } }; root.bryntum ??= {}; root.bryntum.licenseKey = licenseKey;
  const project = useMemo(() => ({ resources: [{ id: data.person.id, name: data.person.name, eventColor: "#d3ac74" }], events: data.calls.map(value => ({ id: `${value.productionId}:${value.call.id}`, name: value.call.label, resourceId: data.person.id, startDate: value.call.start.instant, endDate: value.call.end.instant, readOnly: true })) }), [data]);
  return <div className="tour-native" data-personal-tour-calendar="canonical-own-calls"><BryntumCalendar date={date} timeZone={zone} mode="day" modes={{ day: { dayStartTime: 0, dayEndTime: 24 }, week: { dayStartTime: 0, dayEndTime: 24 }, agenda: true, month: false, year: false }} project={project} height={620} sidebar={false} readOnly eventEditFeature={false} eventMenuFeature={false} dragFeature={false} ariaLabel={`Your personal tour calls in ${zone}`} onEventClick={({ eventRecord }) => onSelect(String(eventRecord.id))} /></div>;
}
