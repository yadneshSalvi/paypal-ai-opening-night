import { Temporal } from "@js-temporal/polyfill";

export const VENUE_ZONE = "America/Chicago";
export function atVenue(time: string, day = "2026-11-14"): string {
  return Temporal.ZonedDateTime.from(`${day}T${time}:00[${VENUE_ZONE}]`, { disambiguation: "reject" }).toInstant().toString();
}
export function atZone(day: string, time: string, zone: string): string {
  return Temporal.ZonedDateTime.from(`${day}T${time}:00[${zone}]`, { disambiguation: "reject" }).toInstant().toString();
}
export function plusMinutes(instant: string, minutes: number): string { return Temporal.Instant.from(instant).add({ minutes }).toString(); }
export function minutesBetween(start: string, end: string): number { return (Temporal.Instant.from(end).epochMilliseconds - Temporal.Instant.from(start).epochMilliseconds) / 60000; }
export function compareInstants(a: string, b: string): number { return Temporal.Instant.compare(a, b); }
export function localTime(instant: string, zone = VENUE_ZONE): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant));
}
export function restLabel(minutes: number): string { return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`; }
export function formatMoney(minor: number, decimals = false): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: decimals ? 2 : 0, maximumFractionDigits: decimals ? 2 : 0 }).format(minor / 100);
}
export function countdown(now: string, target: string): string {
  const minutes = Math.max(0, Math.ceil(minutesBetween(now, target)));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}
