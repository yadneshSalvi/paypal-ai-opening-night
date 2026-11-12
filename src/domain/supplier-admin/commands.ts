import { z } from "zod";
export const managedSupplierIdSchema = z.templateLiteral(["enrolled-", z.uuid()]);
const text = (min = 12, max = 1200) => z.string().min(min).max(max).refine(value => value === value.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const money = z.number().int().min(0).max(1_000_000);
const time = z.iso.datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const boundsSchema = z.object({ feeMinMinor: money, feeMaxMinor: money, depositMinMinor: money, depositMaxMinor: money,
  earliestDelivery: time, latestDelivery: time, maxRounds: z.number().int().min(1).max(3),
}).strict().refine(value => value.feeMinMinor <= value.feeMaxMinor && value.depositMinMinor <= value.depositMaxMinor && Date.parse(value.earliestDelivery) <= Date.parse(value.latestDelivery));
const scope = { supplierId: managedSupplierIdSchema };
export const supplierAdminCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("invite"), name: text(3, 100), reference: text(5, 180), detail: text(), reviewDigest: hash, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("admit"), ...scope, enrollmentId: z.uuid(), detail: text(), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("rotate_key"), ...scope, previousKeyId: z.uuid().nullable(), detail: text(), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("inventory"), ...scope, previousId: z.uuid().nullable(), unitId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/), label: text(3, 120), model: text(3, 180), owned: z.literal(true), available: z.boolean(), availableFrom: time, availableUntil: time,
    compatible: z.boolean(), qualifiedDriver: z.boolean().nullable(), conditionVerified: z.boolean().nullable(), capabilityEvidence: text(), driverEvidence: text().nullable(), conditionEvidence: text().nullable(), reference: text(5, 180), detail: text(), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("terms"), ...scope, previousId: z.uuid().nullable(), inventoryId: z.uuid(), feeMinor: money, depositMinor: money,
    earliestDelivery: time, latestDelivery: time, scenarioDeadline: time, validForMinutes: z.number().int().min(1).max(60), cancellation: text(), reference: text(5, 180), detail: text(), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("supplier_mandate"), ...scope, inventoryId: z.uuid(), termsId: z.uuid(), keyId: z.uuid(), bounds: boundsSchema,
    validForMinutes: z.number().int().min(1).max(15), detail: text(), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("request_quotes"), ...scope, supplierMandateId: z.uuid(), reviewDigest: hash, bounds: boundsSchema,
    validForMinutes: z.number().int().min(1).max(15), detail: text(), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("negotiate"), ...scope, rfqId: z.uuid(), previousRoundId: z.uuid().nullable(), feeMinor: money, depositMinor: money, deliveryAt: time, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("accept_quote"), ...scope, rfqId: z.uuid(), roundId: z.uuid(), quoteDigest: hash, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("reserve"), ...scope, quoteId: z.uuid(), planDigest: hash, acceptCaptureTerms: z.literal(true), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("release"), ...scope, executionId: z.uuid(), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("revoke"), ...scope, targetId: z.uuid(), targetKind: z.enum(["enrollment", "key", "supplier_mandate", "rfq"]), reason: text(), confirmed: z.literal(true) }).strict(),
]);
export const supplierAdminEnvelopeSchema = z.object({ commandId: z.uuid(), expectedRevision: z.number().int().positive(),
  sessionFingerprint: hash, expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), command: supplierAdminCommandSchema,
}).strict();
export type SupplierAdminCommand = z.infer<typeof supplierAdminCommandSchema>;
export type SupplierAdminEnvelope = z.infer<typeof supplierAdminEnvelopeSchema>;
