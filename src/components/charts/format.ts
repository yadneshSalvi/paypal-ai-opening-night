import { localTime } from "@/domain/time";
const venueDay = (instant: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
/** Venue wall-clock time. Instants after the show day's midnight are marked so 00:30 is never read as the morning. */
export function venueClock(instant: string, showDayInstant: string): string {
  return `${localTime(instant)}${venueDay(instant) > venueDay(showDayInstant) ? " +1d" : ""}`;
}
