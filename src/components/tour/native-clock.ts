import type { PlannedProduction } from "@/domain/tour/contracts";
import { fromInstant } from "@/domain/tour/time";

export function nativeClockLabel(instant: string | Date, zone: string) {
  const value = fromInstant(instant instanceof Date ? instant.toISOString() : instant, zone);
  return `${value.local.replace("T", " ")} ${value.zone} (UTC${value.offset})`;
}
export function nativeCallLabel(item: { name: string; id: string; production: PlannedProduction; call: PlannedProduction["calls"][number] }, zone: string) {
  const { call, production } = item;
  return `${item.name}. Display start ${nativeClockLabel(call.start.instant, zone)}; end ${nativeClockLabel(call.end.instant, zone)}. Venue ${production.venue.name}: start ${nativeClockLabel(call.start.instant, production.venue.zone)}; end ${nativeClockLabel(call.end.instant, production.venue.zone)}. Canonical ${item.id}.`;
}
export function nativeRangeLabel(view: string, range: { startDate: Date; endDate: Date }, zone: string) {
  return `${view} display clock: ${nativeClockLabel(range.startDate, zone)} until ${nativeClockLabel(range.endDate, zone)}.`;
}
