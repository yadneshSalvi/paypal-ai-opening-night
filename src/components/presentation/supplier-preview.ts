import type { Candidate, ShowSnapshot, SupplierOffer } from "@/domain/contracts";
import { localTime } from "@/domain/time";

/** One source for every supplier ghost preview: the native presentation line and the recovery studio lane. */
export interface GhostRange { id: string; startDate: string; endDate: string; duration?: 0; durationUnit?: "minute"; name: string; cls: string }
export interface SupplierGhostPreview {
  offer: SupplierOffer; deliveryAt: string;
  /** The stored candidate that carries this exact offer revision; null when no saved run evaluated it. */
  candidate: Candidate | null; candidateStatus: Candidate["report"]["status"] | null;
  focus: { start: string; end: string } | null; cues: { start: string; end: string } | null;
  doorsAt: string | null; doorsDeltaMinutes: number | null; baselineDoorsAt: string | null;
  headline: string; consequence: string; ranges: GhostRange[];
}
const viable = (row: Candidate) => row.report.status === "feasible" || row.report.status === "feasible_with_approval";
const signed = (minutes: number) => minutes === 0 ? "±0" : `${minutes > 0 ? "+" : "−"}${Math.abs(minutes)} min`;
export const doorsChip = (doorsAt: string, baselineDoorsAt: string | null) => { const delta = baselineDoorsAt ? Math.round((Date.parse(doorsAt) - Date.parse(baselineDoorsAt)) / 60000) : null; return { delta, label: `Doors ${localTime(doorsAt)}${delta === null ? "" : " " + signed(delta)}` }; };
/** The doors time the approved baseline promised, kept on the canonical doors call. */
export const baselineDoors = (show: ShowSnapshot) => show.tasks.find(row => row.id === "doors")?.baselineStart ?? null;

/**
 * Reads only stored offers and saved candidates. With several candidates for one offer it prefers a
 * validated one with the earliest doors, so the preview never promises a time the engine rejected
 * while a validated alternative exists.
 */
export function supplierGhostPreview(show: ShowSnapshot, offerId: string, candidates: Candidate[] = show.runs.at(-1)?.candidates ?? []): SupplierGhostPreview | null {
  const offer = show.offers.find(row => row.id === offerId);
  if (!offer) return null;
  const rank = (row: Candidate) => viable(row) ? 0 : row.report.status === "unknown_pending_evidence" ? 1 : 2, families = ["doors", "budget", "artist", "direct"], family = (row: Candidate) => families.indexOf(row.family);
  const candidate = candidates.filter(row => row.patch.offerId === offer.id && row.patch.offerRevision === offer.revision).sort((a, b) => rank(a) - rank(b) || Date.parse(a.patch.doorsAt) - Date.parse(b.patch.doorsAt) || a.cost.totalMinor - b.cost.totalMinor || family(a) - family(b) || a.id.localeCompare(b.id))[0] ?? null;
  const call = (id: string) => { const task = candidate?.patch.tasks.find(row => row.id === id); return task ? { start: task.start, end: task.end } : null; };
  const focus = call("lx-focus"), cues = call("lx-program"), baselineDoorsAt = baselineDoors(show), doorsAt = candidate?.patch.doorsAt ?? null;
  const doors = doorsAt ? doorsChip(doorsAt, baselineDoorsAt) : null, deliveryAt = offer.deliveryAt;
  const status = candidate ? viable(candidate) ? "validated candidate" : candidate.report.status === "unknown_pending_evidence" ? "evidence missing" : "rejected candidate" : null;
  const ranges: GhostRange[] = [{ id: "presentation-offer:" + offer.id, startDate: deliveryAt, endDate: deliveryAt, duration: 0, durationUnit: "minute", name: "PROPOSED DELIVERY · " + offer.supplier + " · r" + offer.revision, cls: "presentation-proposed-delivery" }];
  if (focus) ranges.push({ id: "presentation-offer-focus:" + offer.id, startDate: focus.start, endDate: focus.end, name: `GHOST FOCUS · ${localTime(focus.start)}–${localTime(focus.end)}`, cls: "presentation-ghost-focus" });
  if (doorsAt && doors) ranges.push({ id: "presentation-offer-doors:" + offer.id, startDate: doorsAt, endDate: doorsAt, duration: 0, durationUnit: "minute", name: `${doors.label.toUpperCase()} · ${status!.toUpperCase()}`, cls: "presentation-ghost-doors" });
  return {
    offer, deliveryAt, candidate, candidateStatus: candidate?.report.status ?? null, focus, cues, doorsAt, doorsDeltaMinutes: doors?.delta ?? null, baselineDoorsAt,
    headline: `${offer.supplier}: delivery ${localTime(deliveryAt)}`,
    consequence: candidate && doors ? `${doors.label} · ${candidate.name} (${status})` : "No saved candidate evaluated this offer revision. No doors consequence is inferred.",
    ranges,
  };
}
