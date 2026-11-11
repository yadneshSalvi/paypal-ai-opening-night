import { z } from "zod";
import { canonical } from "@/domain/canonical";
import { payoutEnvelopeSchema, type PayoutData, type PayoutEnvelope } from "@/domain/payouts/contracts";
export interface PayoutIdentity { scope: "production"; actorId: string; ownerId: string }
const metadata = { schemaVersion: z.literal(1), scope: z.literal("production"), actorId: z.string().min(1), ownerId: z.uuid(), createdAt: z.iso.datetime(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/) };
const savedSchema = z.object({ ...metadata, envelope: z.unknown() }).strict();
const pendingSchema = z.object({ ...metadata, envelope: payoutEnvelopeSchema }).strict();
export type PendingPayout = z.infer<typeof pendingSchema>;
export const payoutStorageKey = (identity: PayoutIdentity) => `opening-night-payout-v1:${encodeURIComponent(identity.actorId)}:${identity.ownerId}`;
async function requestDigest(value: unknown): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
export async function parsePendingPayout(raw: string, identity: PayoutIdentity): Promise<PendingPayout> {
  if (raw.length > 25000) throw new Error("The saved payout request exceeds its recovery limit. Its instructions have not been sent.");
  const saved = savedSchema.parse(JSON.parse(raw));
  if (saved.actorId !== identity.actorId || saved.ownerId !== identity.ownerId || saved.scope !== identity.scope) throw new Error("This request belongs to different production access. It has not been sent.");
  if (saved.requestDigest !== await requestDigest(saved.envelope)) throw new Error("The saved payout instructions changed after review. Check the original server receipt.");
  const normalized = pendingSchema.parse(saved);
  if (normalized.requestDigest !== await requestDigest(normalized.envelope)) throw new Error("The saved payout request is not in its reviewed canonical form. Check the original receipt.");
  return normalized;
}
export function payoutDataMatches(value: PayoutData, identity: PayoutIdentity) { return value?.schemaVersion === 1 && value.scope === "production" && value.actorId === identity.actorId && value.tenantId === identity.ownerId && Number.isInteger(value.revision) && Number.isInteger(value.settlementRevision) && Number.isInteger(value.productionRevision) && Array.isArray(value.receipts); }
export function recoveredPayout(data: PayoutData, pending: PendingPayout) {
  if (!payoutDataMatches(data, pending)) return null;
  const kinds = { approve_recipient: "recipient", revoke_recipient: "recipient_revoked", approve_payout: "grant", revoke_payout: "grant_revoked", refresh_payout: "refresh", locate_original: "locate", cancel_unclaimed: "cancel_request" };
  return data.receipts.find(receipt => receipt.commandId === pending.envelope.idempotencyKey && receipt.actorId === pending.actorId && receipt.requestDigest === pending.requestDigest && receipt.kind === kinds[pending.envelope.command.type]) ?? null;
}
export const definitePayoutRejection = (status: number, code: string) => [400, 403, 409, 413, 422].includes(status) && code !== "IDEMPOTENCY_CONFLICT";
export async function newPendingPayout(identity: PayoutIdentity, envelope: PayoutEnvelope): Promise<PendingPayout> {
  const normalized = payoutEnvelopeSchema.parse(envelope);
  return { schemaVersion: 1, ...identity, createdAt: new Date().toISOString(), requestDigest: await requestDigest(normalized), envelope: normalized };
}
