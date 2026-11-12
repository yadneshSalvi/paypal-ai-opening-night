import { z } from "zod";
import type { Actor, ShowSnapshot } from "./contracts";
import type { RentalExecution } from "./supplier-contracts";
import { digest } from "./hash";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const detail = z.string().trim().min(12).max(1600).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/);
export const returnConditionSchema = z.enum(["undamaged", "damage_reported"]);
export const closeoutEnvelopeSchema = z.object({
  commandId: z.uuid(), expectedRevision: z.number().int().positive(),
  command: z.discriminatedUnion("type", [
    z.object({ type: z.literal("record_return"), executionId: z.uuid(), executionDigest: hash, previousInspectionId: z.uuid().nullable(), observedAt: z.iso.datetime(), condition: returnConditionSchema, detail, confirmed: z.literal(true) }).strict(),
    z.object({ type: z.literal("approve_closeout"), executionId: z.uuid(), previewDigest: hash, detail, confirmed: z.literal(true) }).strict(),
    z.object({ type: z.literal("stop_closeout"), grantId: z.uuid(), detail, confirmed: z.literal(true) }).strict(),
    z.object({ type: z.literal("reconcile_closeout"), executionId: z.uuid(), intentId: z.uuid() }).strict(),
    z.object({ type: z.literal("retry_closeout"), grantId: z.uuid(), intentId: z.uuid(), confirmed: z.literal(true) }).strict(),
  ]),
}).strict();
export type CloseoutEnvelope = z.infer<typeof closeoutEnvelopeSchema>;
export type CloseoutCommand = CloseoutEnvelope["command"];
export type ReturnCondition = z.infer<typeof returnConditionSchema>;
export interface RentalReturnRef {
  id: string; digest: string; condition: ReturnCondition; actorId: string;
  observedAt: string; recordedAt: string; originalPlanVersion: number;
}
export interface RentalReturnRecord {
  id: string; tenantId: string; executionId: string; executionDigest: string;
  previousInspectionId: string | null; originalPlanVersion: number; originalPlanDigest: string;
  supplierId: RentalExecution["supplierId"]; unitId: string; quoteId: string; quoteDigest: string;
  deliveryId: string; deliveryVersion: number; deliveryDigest: string; acceptedAt: string;
  condition: ReturnCondition; detail: string; observedAt: string; recordedAt: string; fixtureAt: string;
  actor: Actor; sessionHash: string; source: "attributed_controlled_supplier";
}
export interface RentalCloseoutGrant {
  id: string; tenantId: string; executionId: string; executionDigest: string;
  originalPlanVersion: number; originalPlanDigest: string; quoteId: string; quoteDigest: string;
  returnId: string; returnDigest: string; rootIntentId: string; orderId: string; authorizationId: string;
  captureIntentId: string; captureId: string; authorizationMinor: number; feeMinor: number; residualMinor: number;
  actor: Actor; sessionHash: string; approvedAt: string; expiresAt: string; detail: string;
}
export interface RentalCloseoutCheck {
  id: string; grantId: string; intentId: string; sequence: number; startedAt: string; finishedAt: string;
  verified: boolean; code: string | null; residualMinor: number; digest: string;
}

/** Original identity and accepted terms survive replacement plans and later return observations. */
export function rentalExecutionDigest(execution: RentalExecution) {
  const { id, planVersion, planDigest, quoteId, quoteDigest, offerId, offerRevision, supplierId, unitId, feeMinor, depositMinor, deliveryAt, windowEnd, producerId, captureConsentAt, paymentRootId, authorizationId, captureIntentId, deliveryId, deliveryVersion, acceptedAt } = execution;
  return digest({ id, planVersion, planDigest, quoteId, quoteDigest, offerId, offerRevision, supplierId, unitId, feeMinor, depositMinor, deliveryAt, windowEnd, producerId, captureConsentAt, paymentRootId, authorizationId, captureIntentId, deliveryId, deliveryVersion, acceptedAt });
}
export function rentalBelongsToCurrentPlan(show: ShowSnapshot, execution: RentalExecution) {
  return execution.planVersion === show.planVersion && execution.planDigest === show.approvedPlan?.digest;
}
export const supplierLabel = (supplier: RentalExecution["supplierId"]) => ({ brightline: "Brightline Rentals", northside: "Northside AV", sister: "Sister venue" } as Partial<Record<RentalExecution["supplierId"], string>>)[supplier] ?? `Managed supplier · ${supplier}`;
export function returnReference(record: RentalReturnRecord): RentalReturnRef {
  return { id: record.id, digest: digest(record), condition: record.condition, actorId: record.actor.id, observedAt: record.observedAt, recordedAt: record.recordedAt, originalPlanVersion: record.originalPlanVersion };
}
