"use client";
import { BryntumCalendar } from "@bryntum/calendar-react-enterprise";
import { useMemo } from "react";
import { calendarProjection } from "@/domain/adapters";
import type { Task, Resource } from "@/domain/contracts";
export default function NativeCalendar({ tasks, resources, licenseKey, personId }: { tasks: Task[]; resources: Resource[]; licenseKey: string; personId?: string }) {
  const root = globalThis as typeof globalThis & { bryntum?: { licenseKey?: string } }; root.bryntum ??= {}; root.bryntum.licenseKey = licenseKey;
  const projection = useMemo(() => calendarProjection(tasks, resources, personId), [tasks, resources, personId]);
  return <div className="native-calendar" data-calendar-adapter="independent-model"><BryntumCalendar date="2026-11-14" timeZone="America/Chicago" mode="day" modes={{ day: { dayStartTime: 9, dayEndTime: 24 }, week: { dayStartTime: 9, dayEndTime: 24 }, agenda: true, year: false, month: false }} project={{ events: projection.events, resources: projection.resources }} height={660} sidebar={false} readOnly={true} eventEditFeature={false} eventMenuFeature={false} ariaLabel="Production calendar, America Chicago" /></div>;
}
