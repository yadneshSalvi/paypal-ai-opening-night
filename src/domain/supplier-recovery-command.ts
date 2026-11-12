import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = (min: number, max: number) => z.string().min(min).max(max).refine(value => value === value.trim());
const instant = z.iso.datetime({ offset: true });
export const supplierRecoveryCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("publish_terms"), offerId: text(1, 120), previousTermId: z.uuid().nullable(), sourceReportId: z.uuid().nullable(),
    deliveryAt: instant, expiresAt: instant, validForMinutes: z.number().int().min(5).max(60),
    feeMinor: z.number().int().min(0).max(1000000), depositMinor: z.number().int().min(0).max(1000000),
    compatible: z.boolean(), qualifiedDriver: z.boolean().nullable(), conditionVerified: z.boolean().nullable(),
    capabilityEvidence: text(12, 1200), driverEvidence: text(12, 1200).nullable(), conditionEvidence: text(12, 1200).nullable(),
    reference: text(3, 180), detail: text(12, 1600), confirmed: z.literal(true),
  }).strict(),
  z.object({ type: z.literal("request_quotes"), previewDigest: hash, detail: text(12, 1600), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("open_supplier"), supplierId: z.enum(["brightline", "northside", "sister"]), confirmed: z.literal(true) }).strict(),
]);
export const supplierRecoveryEnvelopeSchema = z.object({ commandId: z.uuid(), expectedRevision: z.number().int().positive(), command: supplierRecoveryCommandSchema }).strict();
export type SupplierRecoveryCommand = z.infer<typeof supplierRecoveryCommandSchema>;
export type SupplierRecoveryEnvelope = z.infer<typeof supplierRecoveryEnvelopeSchema>;
export type SupplierTermInput = Extract<SupplierRecoveryCommand, { type: "publish_terms" }>;

