import { z } from "zod";
import type { Candidate, CueScope, ShowSnapshot, SupplierOffer } from "./contracts";
import { currentActual, uniqueActual } from "./finance";
import { digest } from "./hash";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const detail = z.string().trim().min(12).max(1200);
export const disruptionModeSchema = z.enum(["support_only", "cancel_show"]);
export type DisruptionMode = z.infer<typeof disruptionModeSchema>;
export const disruptionCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("report"), offerId: z.string().min(1).max(120), offerRevision: z.number().int().positive(), executionId: z.uuid().nullable(), availability: z.enum(["delayed", "unavailable", "available"]), earliestAt: z.iso.datetime({ offset: true }).nullable(), observedAt: z.iso.datetime({ offset: true }), reference: z.string().trim().min(3).max(180), detail, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("assess") }).strict(),
  z.object({ type: z.literal("cancel_rental"), executionId: z.uuid(), detail, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("decide"), mode: disruptionModeSchema, assessmentId: z.uuid(), previewDigest: hash, admissionRefundMinor: z.number().int().min(0).max(3500), detail, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("stop_remedies"), decisionId: z.uuid(), detail }).strict(),
  z.object({ type: z.literal("reconcile_remedies"), decisionId: z.uuid() }).strict(),
  z.object({ type: z.literal("retry_remedy"), decisionId: z.uuid(), itemId: z.uuid(), confirmed: z.literal(true) }).strict(),
]);
export type DisruptionCommand = z.infer<typeof disruptionCommandSchema>;
export const disruptionEnvelopeSchema = z.object({ idempotencyKey: z.uuid(), expectedRevision: z.number().int().positive(), command: disruptionCommandSchema }).strict();
export type DisruptionEnvelope = z.infer<typeof disruptionEnvelopeSchema>;

export interface SupplierDisruption {
  id: string; offerId: string; offerRevision: number; supplierId: string; unitId: string; executionId: string | null;
  availability: "delayed" | "unavailable" | "available"; earliestAt: string | null;
  observedAt: string; recordedAt: string; reference: string; detail: string; actorId: string;
  attribution: "supplier_client" | "production_operator"; source: "controlled_client"; revision: number;
}
export interface DisruptionAssessment {
  id: string; createdAt: string; sourceDigest: string; disruptionDigest: string; baseRevision: number;
  runId: string; candidateIds: string[]; generated: number; feasible: number; pending: number; infeasible: number;
  conclusion: "alternatives_available" | "evidence_pending" | "no_feasible_candidate";
  reasons: { code: string; count: number }[]; enginePassed: number; engineUnavailable: number;
  scope: string; source: "deterministic_enumerator";
}
export interface CancellationTarget { ticketId: string; admissionMinor: number; perkMinor: number }
export interface CancellationDecision {
  id: string; digest: string; mode: DisruptionMode; detail: string; actorId: string; approvedAt: string; expiresAt: string;
  assessmentId: string; disruptionDigest: string; admissionRefundMinor: number; targets: CancellationTarget[];
  newRefundMinor: number; newRefundCount: number; cancelledTaskIds: string[]; noticeSheetVersion: number;
  remediesStoppedAt: string | null;
}

export function disruptionDigest(show: Pick<ShowSnapshot, "supplierDisruptions">) {
  return digest(show.supplierDisruptions ?? []);
}
export function operatingDigest(show: Pick<ShowSnapshot, "supplierDisruptions" | "cancellationDecision" | "productionInputs">) {
  return digest({ disruptions: disruptionDigest(show), decision: show.cancellationDecision?.id ?? null, ...(show.productionInputs ? { productionInputs: show.productionInputs.digest } : {}) });
}
export function latestSupplierDisruption(show: Pick<ShowSnapshot, "supplierDisruptions">, offer: Pick<SupplierOffer, "supplierId" | "unitId">) {
  return (show.supplierDisruptions ?? []).filter(report => report.supplierId === offer.supplierId && report.unitId === offer.unitId).at(-1) ?? null;
}
export function supplierInterruption(show: Pick<ShowSnapshot, "supplierDisruptions">, offer: SupplierOffer) {
  const report = latestSupplierDisruption(show, offer);
  return report && (report.availability === "unavailable" || offer.revision <= report.offerRevision || report.earliestAt && Date.parse(offer.deliveryAt) < Date.parse(report.earliestAt)) ? report : null;
}
export function effectiveDelivery(show: Pick<ShowSnapshot, "supplierDisruptions">, offer: SupplierOffer) {
  const report = latestSupplierDisruption(show, offer);
  return report?.earliestAt && Date.parse(report.earliestAt) > Date.parse(offer.deliveryAt) ? report.earliestAt : offer.deliveryAt;
}
export function selectedInterruption(show: ShowSnapshot) {
  const candidate = show.runs.flatMap(run => run.candidates).find(item => item.id === show.approvedPlan?.candidateId && item.digest === show.approvedPlan?.digest);
  const offer = show.offers.find(item => item.id === candidate?.patch.offerId);
  return offer ? supplierInterruption(show, offer) : null;
}
export function hasCurrentSupportOnlyPlan(show: ShowSnapshot) {
  return show.cancellationDecision?.mode === "support_only" && show.runs.some(run => run.candidates.some(candidate => candidate.id === show.approvedPlan?.candidateId && candidate.digest === show.approvedPlan?.digest && candidate.patch.programMode === "support_only" && !candidate.patch.tasks.some(task => show.cancellationDecision!.cancelledTaskIds.includes(task.id))));
}
export function cancellationBlocksCue(show: ShowSnapshot, scope: CueScope) {
  return show.cancellationDecision?.mode === "cancel_show" || show.cancellationDecision?.mode === "support_only" && scope === "HEADLINER_START";
}
export function refundAllocation(show: ShowSnapshot, ticketId: string, current = false) {
  const ticket = show.tickets.find(item => item.id === ticketId);
  const entries = (current ? currentActual(show) : uniqueActual(show)).filter(item => item.kind === "refund" && item.ticketId === ticketId && item.parentId === ticket?.captureId);
  let admissionMinor = 0, perkMinor = 0, unallocatedMinor = 0;
  for (const entry of entries) {
    if (entry.purpose === "vip_remedy" && entry.amountMinor === 1500) perkMinor += entry.amountMinor;
    else if (entry.purpose === "event_remedy" && entry.allocation && entry.amountMinor === entry.allocation.admissionMinor + entry.allocation.perkMinor) { admissionMinor += entry.allocation.admissionMinor; perkMinor += entry.allocation.perkMinor; }
    else unallocatedMinor += entry.amountMinor;
  }
  return { admissionMinor, perkMinor, unallocatedMinor, totalMinor: entries.reduce((total, entry) => total + entry.amountMinor, 0), entries };
}
export function cancellationRemedies(show: ShowSnapshot) {
  const decision = show.cancellationDecision;
  if (!decision) return null;
  const targets = decision.targets.map(target => {
    const allocation = refundAllocation(show, target.ticketId, true);
    return { ...target, complete: allocation.unallocatedMinor === 0 && allocation.admissionMinor >= target.admissionMinor && allocation.perkMinor >= target.perkMinor };
  });
  return { complete: targets.every(target => target.complete), completed: targets.filter(target => target.complete).length, total: targets.length };
}
export function summarizeAssessment(candidates: Candidate[]) {
  const feasible = candidates.filter(candidate => ["feasible", "feasible_with_approval"].includes(candidate.report.status) && candidate.report.engine?.status === "passed").length;
  const pending = candidates.filter(candidate => candidate.report.status === "unknown_pending_evidence" || candidate.report.engine?.status === "unavailable").length;
  const counts = new Map<string, number>();
  for (const candidate of candidates) for (const code of new Set(candidate.report.issues.filter(issue => issue.severity === "hard" || issue.severity === "unknown").map(issue => issue.code))) counts.set(code, (counts.get(code) ?? 0) + 1);
  return { generated: candidates.length, feasible, pending, infeasible: candidates.filter(candidate => candidate.report.status === "infeasible").length,
    conclusion: feasible ? "alternatives_available" as const : pending ? "evidence_pending" as const : "no_feasible_candidate" as const,
    reasons: [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    enginePassed: candidates.filter(candidate => candidate.report.engine?.status === "passed").length,
    engineUnavailable: candidates.filter(candidate => candidate.report.engine?.status === "unavailable").length };
}
