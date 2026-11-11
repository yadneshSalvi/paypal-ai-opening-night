import { z } from "zod";
import { canonical } from "@/domain/canonical";
import { settlementEnvelopeSchema, type SettlementData, type SettlementEnvelope } from "@/domain/settlement/contracts";

export interface SettlementIdentity { scope: "personal" | "production"; actorId: string; ownerId: string }
export const pendingSettlementSchema = z.object({ schemaVersion: z.literal(1), scope: z.enum(["personal", "production"]), actorId: z.string().min(1), ownerId: z.string().min(1), createdAt: z.iso.datetime(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/), envelope: settlementEnvelopeSchema }).strict();
export type PendingSettlement = z.infer<typeof pendingSettlementSchema>;
export function settlementStorageKey(identity: SettlementIdentity) { return `opening-night-settlement-v1:${identity.scope}:${encodeURIComponent(identity.actorId)}:${encodeURIComponent(identity.ownerId)}`; }
export async function settlementRequestDigest(envelope: SettlementEnvelope): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(envelope))))].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
export async function parsePendingSettlement(raw: string, identity: SettlementIdentity): Promise<PendingSettlement> {
  if (raw.length > 25000) throw new Error("The saved settlement request exceeds its recovery limit. Download it for review; it has not been sent.");
  const value = pendingSettlementSchema.parse(JSON.parse(raw));
  if (value.scope !== identity.scope || value.actorId !== identity.actorId || value.ownerId !== identity.ownerId || (value.envelope.command.type === "report_time") !== (identity.scope === "personal")) throw new Error("The saved settlement request belongs to different access. It has not been sent.");
  if (value.requestDigest !== await settlementRequestDigest(value.envelope)) throw new Error("The saved instructions changed after review. Download the recovery file and check the original server receipt.");
  return value;
}
export function settlementDataMatches(value: SettlementData, identity: SettlementIdentity) {
  return value?.schemaVersion === 1 && value.actorId === identity.actorId && value.scope === identity.scope && Number.isInteger(value.revision) && Number.isInteger(value.productionRevision) && Array.isArray(value.receipts) && (value.scope === "personal" ? value.personal?.person.id === identity.ownerId : value.tenantId === identity.ownerId);
}
export function recoveredSettlement(data: SettlementData, pending: PendingSettlement) {
  if (!settlementDataMatches(data, pending)) return null;
  const kinds = { report_time: "time_report", approve_rate: "rate", approve_payable: "payable", request_time_changes: "changes_requested" };
  return data.receipts.find(receipt => receipt.commandId === pending.envelope.idempotencyKey && receipt.actorId === pending.actorId && receipt.requestDigest === pending.requestDigest && receipt.kind === kinds[pending.envelope.command.type]) ?? null;
}
export const definiteSettlementRejection = (status: number, code: string) => [400, 403, 409, 413, 422].includes(status) && code !== "IDEMPOTENCY_CONFLICT";
export async function newPendingSettlement(identity: SettlementIdentity, envelope: SettlementEnvelope): Promise<PendingSettlement> { return { schemaVersion: 1, ...identity, createdAt: new Date().toISOString(), requestDigest: await settlementRequestDigest(envelope), envelope }; }
