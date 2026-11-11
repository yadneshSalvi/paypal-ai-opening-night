/** A decimal input is parsed as cents, without floating-point multiplication. */
export function parseHourlyRate(value: string): number | null {
  const match = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
export function minutePay(minutes: number, hourlyMinor: number): number {
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 1440 || !Number.isSafeInteger(hourlyMinor) || hourlyMinor < 1 || hourlyMinor > 200000) throw new Error("Invalid bounded minute-rate calculation");
  return Number((BigInt(minutes) * BigInt(hourlyMinor) + 30n) / 60n);
}
