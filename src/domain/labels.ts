import type { Task } from "./contracts";
import { Temporal } from "@js-temporal/polyfill";
export function venueSpokenDate(value: string | Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(new Date(value));
}
export function taskAriaLabel(task: Pick<Task, "name" | "start" | "end" | "durationMinutes">): string {
  return `${task.name}. ${venueSpokenDate(task.start)}${task.durationMinutes ? ` until ${venueSpokenDate(task.end)}` : ". Milestone"}. Venue time, America Chicago.`;
}
/** Header boundaries must use venue midnights as well as venue-formatted text. */
export function venueDayCells(viewStart: Date, viewEnd: Date) {
  const end = viewEnd.getTime();
  let cursor = viewStart.getTime();
  const cells: { start: Date; end: Date; header: string }[] = [];
  while (cursor < end && cells.length < 370) {
    const zoned = Temporal.Instant.fromEpochMilliseconds(cursor).toZonedDateTimeISO("America/Chicago");
    const midnight = zoned.toPlainDate().add({ days: 1 }).toZonedDateTime("America/Chicago").epochMilliseconds;
    const next = Math.min(midnight, end);
    cells.push({ start: new Date(cursor), end: new Date(next), header: new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "2-digit", day: "2-digit", timeZoneName: "short" }).format(new Date(cursor)) });
    cursor = next;
  }
  return cells;
}
