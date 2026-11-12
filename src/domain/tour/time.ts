import { Temporal } from "@js-temporal/polyfill";
import { DomainError } from "../contracts";
import { timeInputSchema, type TimeInput, type ZonedTime } from "./contracts";

export function zoned(raw: TimeInput): ZonedTime {
  const value = timeInputSchema.parse({ local: raw.local, zone: raw.zone, disambiguation: raw.disambiguation });
  let earlier: Temporal.ZonedDateTime, later: Temporal.ZonedDateTime;
  try {
    const plain = Temporal.PlainDateTime.from(value.local);
    earlier = plain.toZonedDateTime(value.zone, { disambiguation: "earlier" });
    later = plain.toZonedDateTime(value.zone, { disambiguation: "later" });
  } catch { throw new DomainError("TOUR_TIME_INVALID", "Use a valid local calendar date and IANA time zone.", 400); }
  const sameLocal = (time: Temporal.ZonedDateTime) => time.toPlainDateTime().toString().slice(0, 16) === value.local;
  if (!sameLocal(earlier) || !sameLocal(later)) throw new DomainError("TOUR_DST_GAP", `${value.local} does not exist in ${value.zone}. Choose an actual local clock time.`, 400);
  if (earlier.epochMilliseconds !== later.epochMilliseconds && value.disambiguation === "reject") throw new DomainError("TOUR_DST_FOLD", `${value.local} occurs twice in ${value.zone}. Review and choose the earlier or later offset.`, 400);
  const result = value.disambiguation === "later" ? later : earlier;
  return { ...value, instant: result.toInstant().toString(), offset: result.offset };
}
export function fromInstant(instant: string, zone: string): ZonedTime {
  const result = Temporal.Instant.from(instant).toZonedDateTimeISO(zone);
  const local = result.toPlainDateTime().toString().slice(0, 16);
  const earlier = zoned({ local, zone, disambiguation: "earlier" });
  return { local, zone, disambiguation: earlier.instant === result.toInstant().toString() ? "earlier" : "later", instant: result.toInstant().toString(), offset: result.offset };
}
export function plusMinutes(time: ZonedTime, minutes: number): ZonedTime { return fromInstant(Temporal.Instant.from(time.instant).add({ minutes }).toString(), time.zone); }
export function dateAfter(date: string, days: number) { try { return Temporal.PlainDate.from(date).add({ days }).toString(); } catch { throw new DomainError("TOUR_DATE_INVALID", "Choose a valid show date.", 400); } }
export const minutesBetween = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 60000;
export const intervalOverlap = (a: string, b: string, c: string, d: string) => Date.parse(a) < Date.parse(d) && Date.parse(c) < Date.parse(b);
export function clockLabel(time: ZonedTime) { return `${time.local.replace("T", " · ")} ${time.zone} (UTC${time.offset})`; }
