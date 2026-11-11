import { categoryLabels, wrapCategories, type LedgerLine, type WrapCategory } from "./contracts";

export const wrapMoney = (minor: number | null) => minor === null ? "Unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);
export const wrapTime = (value: string, zone = "America/Chicago") => new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
export function parseWrapAmount(value: string, signed = false): number | null {
  if (!(signed ? /^-?(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/ : /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/).test(value.trim())) return null;
  const sign = value.trim().startsWith("-") ? -1 : 1, [whole, decimal = ""] = value.trim().replace(/^-/, "").split("."), minor = sign * (Number(whole) * 100 + Number(decimal.padEnd(2, "0")));
  return Number.isSafeInteger(minor) && Math.abs(minor) <= 1_000_000_000 ? minor : null;
}
export interface WrapFilter { query: string; category: "all" | WrapCategory; direction: "all" | LedgerLine["direction"]; unresolved: boolean }
export const emptyWrapFilter: WrapFilter = { query: "", category: "all", direction: "all", unresolved: false };
export function filterWrapLines(lines: LedgerLine[], filter: WrapFilter) {
  const query = filter.query.trim().toLocaleLowerCase("en-US");
  return lines.filter(line => (filter.category === "all" || line.category === filter.category) && (filter.direction === "all" || line.direction === filter.direction) && (!filter.unresolved || line.issues.length > 0) && (!query || `${line.label} ${line.source} ${categoryLabels[line.category]}`.toLocaleLowerCase("en-US").includes(query)));
}
export function wrapComparisons(lines: LedgerLine[]) {
  return wrapCategories.map(category => {
    const selected = lines.filter(line => line.category === category && line.direction === "expense"), sum = (field: "baselineMinor" | "approvedMinor" | "currentCashMinor" | "reportedCashMinor" | "currentFeeMinor" | "outstandingMinor") => selected.reduce((total, line) => total + (line[field] ?? 0), 0);
    return { category, label: categoryLabels[category], baseline: sum("baselineMinor"), approved: sum("approvedMinor"), observed: sum("currentCashMinor"), reported: sum("reportedCashMinor"), fees: sum("currentFeeMinor"), outstanding: sum("outstandingMinor"), lineIds: selected.map(line => line.id) };
  }).filter(value => value.lineIds.length);
}
/** A bridge of known costs, never a revenue/profit calculation. Every cent reconciles. */
export function wrapCostBridge(lines: LedgerLine[]) {
  const expense = lines.filter(line => line.direction === "expense"), baseline = expense.reduce((n, line) => n + (line.baselineMinor ?? 0), 0), approved = expense.reduce((n, line) => n + (line.approvedMinor ?? 0), 0), fees = lines.reduce((n, line) => n + (line.currentFeeMinor ?? 0), 0), final = approved + fees;
  const datum = (label: string, from: number, to: number, lineIds: string[], total = false) => {
    const origin = total ? 0 : from, low = Math.min(origin, to), high = Math.max(origin, to);
    // AG stacks positive and negative values separately. Split a crossing bar at zero.
    return { label, positiveOffset: Math.max(0, low), positiveValue: Math.max(0, high) - Math.max(0, low), negativeOffset: Math.min(0, high), negativeValue: Math.min(0, low) - Math.min(0, high), amount: total ? to : to - from, from: origin, to, lineIds, tone: total ? "total" : to >= from ? "increase" : "decrease" };
  };
  return [datum("Baseline", 0, baseline, expense.filter(line => line.baselineMinor !== null).map(line => line.id), true), datum("Approval change", baseline, approved, expense.filter(line => line.approvedMinor !== null || line.baselineMinor !== null).map(line => line.id)), datum("Approved cost", 0, approved, expense.filter(line => line.approvedMinor !== null).map(line => line.id), true), datum("Known fees", approved, final, lines.filter(line => line.currentFeeMinor !== null && line.currentFeeMinor !== 0).map(line => line.id)), datum("Cost + known fees", 0, final, lines.filter(line => line.direction === "expense" || line.currentFeeMinor).map(line => line.id), true)];
}
