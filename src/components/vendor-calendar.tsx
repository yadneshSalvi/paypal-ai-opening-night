"use client";
import { BryntumCalendar } from "@bryntum/calendar-react-enterprise";
import { memo, useMemo } from "react";
import { calendarProjection, type CalendarTask, type CalendarResource } from "@/domain/adapters";
import { atVenue, localTime } from "@/domain/time";
export interface NativeCalendarProps { tasks: CalendarTask[]; resources: CalendarResource[]; licenseKey: string; personId?: string; date?: string; personal?: boolean }
function NativeCalendar({ tasks, resources, licenseKey, personId, date = "2026-11-14", personal = false }: NativeCalendarProps) {
  const root = globalThis as typeof globalThis & { bryntum?: { licenseKey?: string } }; root.bryntum ??= {}; root.bryntum.licenseKey = licenseKey;
  const projection = useMemo(() => calendarProjection(tasks, resources, personId), [tasks, resources, personId]);
  const project = useMemo(() => ({ events: projection.events, resources: projection.resources }), [projection]);
  const modes = useMemo(() => {
    const start = Date.parse(atVenue("00:00", date));
    const tomorrow = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const end = Date.parse(atVenue("00:00", tomorrow));
    const first = projection.events.filter(event => Date.parse(event.startDate) < end && Date.parse(event.endDate) >= start).sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
    const firstHour = first ? Date.parse(first.startDate) < start ? 0 : Number(localTime(first.startDate).split(":")[0]) : 10;
    return { day: { dayStartTime: personal ? 0 : 9, dayEndTime: 24, visibleStartTime: Math.max(0, firstHour - 1) }, week: personal ? false as const : { dayStartTime: 9, dayEndTime: 24 }, agenda: !personal, year: false as const, month: false as const };
  }, [date, personal, projection]);
  return <div className={`native-calendar${personal ? " personal-native-calendar" : ""}`} data-calendar-adapter="independent-model"><BryntumCalendar date={date} timeZone="America/Chicago" mode="day" modes={modes} project={project} height={personal ? 580 : 660} sidebar={false} {...(personal ? { tbar: null } : {})} readOnly={true} eventEditFeature={false} eventMenuFeature={false} dragFeature={false} ariaLabel={personId ? "Personal calls in America Chicago venue time" : "Production calendar, America Chicago"} /></div>;
}
export default memo(NativeCalendar);
