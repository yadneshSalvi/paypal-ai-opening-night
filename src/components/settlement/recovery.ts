import { z } from "zod";
import { canonical } from "@/domain/canonical";
import { settlementEnvelopeSchema, type SettlementData, type SettlementEnvelope } from "@/domain/settlement/contracts";

export interface SettlementIdentity { scope: "personal" | "production"; actorId: string; ownerId: string }
const pendingMetadata = { scope: z.enum(["personal", "production"]), actorId: z.string().min(1), ownerId: z.string().min(1), createdAt: z.iso.datetime(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/) };
export const pendingSettlementSchema = z.object({ schemaVersion: z.literal(2), ...pendingMetadata, envelope: settlementEnvelopeSchema }).strict();
// Check the original wire object before the command schema trims review notes.
const savedSettlementSchema = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), ...pendingMetadata, envelope: z.unknown() }).strict();
export type PendingSettlement = z.infer<typeof pendingSettlementSchema>;
export function settlementStorageKey(identity: SettlementIdentity) { return `opening-night-settlement-v1:${identity.scope}:${encodeURIComponent(identity.actorId)}:${encodeURIComponent(identity.ownerId)}`; }
async function wireDigest(envelope: unknown): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(envelope))))].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
export const settlementRequestDigest = (envelope: SettlementEnvelope) => wireDigest(envelope);
export async function parsePendingSettlement(raw: string, identity: SettlementIdentity): Promise<PendingSettlement> {
  if (raw.length > 25000) throw new Error("The saved settlement request exceeds its recovery limit. Download it for review; it has not been sent.");
  const saved = savedSettlementSchema.parse(JSON.parse(raw));
  if (saved.requestDigest !== await wireDigest(saved.envelope)) throw new Error("The saved instructions changed after review. Download the recovery file and check the original server receipt.");
  const value = pendingSettlementSchema.parse({ ...saved, schemaVersion: 2 });
  if (value.scope !== identity.scope || value.actorId !== identity.actorId || value.ownerId !== identity.ownerId || (value.envelope.command.type === "report_time") !== (identity.scope === "personal")) throw new Error("The saved settlement request belongs to different access. It has not been sent.");
  const normalizedDigest = await settlementRequestDigest(value.envelope);
  if (saved.schemaVersion === 2 && saved.requestDigest !== normalizedDigest) throw new Error("The saved request is not in its reviewed canonical form. Download it and check the original server receipt.");
  // V1 hashed the raw note before the server's strict schema trimmed it. Its
  // original hash was verified above; match only the same typed instruction.
  return { ...value, requestDigest: normalizedDigest };
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
export async function newPendingSettlement(identity: SettlementIdentity, envelope: SettlementEnvelope): Promise<PendingSettlement> {
  const normalized = settlementEnvelopeSchema.parse(envelope);
  return { schemaVersion: 2, ...identity, createdAt: new Date().toISOString(), requestDigest: await settlementRequestDigest(normalized), envelope: normalized };
}
