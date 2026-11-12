import { z } from "zod";
import { supplierRecoveryEnvelopeSchema } from "@/domain/supplier-recovery-command";
import { canonical } from "@/domain/canonical";
import type { SupplierRecoveryEnvelope, SupplierRecoveryResult, SupplierRecoveryWorkspace } from "@/server/supplier-recovery/contracts";

export type SupplierRecoveryIdentity = Pick<SupplierRecoveryWorkspace, "tenantId" | "actorId" | "sessionFingerprint">;
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
// Shared browser-safe schema preserves the exact reviewed supplier instruction.
const envelopeSchema = supplierRecoveryEnvelopeSchema;
const metadataSchema = z.object({ version: z.literal(1), tenantId: z.string().min(1), actorId: z.string().min(1), sessionFingerprint: hash, createdAt: z.iso.datetime(), requestDigest: hash, envelope: z.unknown() }).strict();
export type PendingSupplierRecovery = SupplierRecoveryIdentity & { version: 1; createdAt: string; requestDigest: string; envelope: SupplierRecoveryEnvelope };

export const supplierRecoveryRecoveryKey = (identity: SupplierRecoveryIdentity) => `opening-night:supplier-recovery:v1:${encodeURIComponent(identity.tenantId)}:${encodeURIComponent(identity.actorId)}:${identity.sessionFingerprint}`;
export async function supplierRecoveryRequestDigest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function sameSupplierRecoveryIdentity(left: SupplierRecoveryIdentity, right: SupplierRecoveryIdentity) {
  return left.tenantId === right.tenantId && left.actorId === right.actorId && left.sessionFingerprint === right.sessionFingerprint;
}
export async function prepareSupplierRecovery(identity: SupplierRecoveryIdentity, instruction: SupplierRecoveryEnvelope): Promise<PendingSupplierRecovery> {
  const envelope = envelopeSchema.parse(instruction);
  return { version: 1, tenantId: identity.tenantId, actorId: identity.actorId, sessionFingerprint: identity.sessionFingerprint, createdAt: new Date().toISOString(), requestDigest: await supplierRecoveryRequestDigest(envelope), envelope };
}
export async function parseSupplierRecovery(raw: string, identity: SupplierRecoveryIdentity): Promise<PendingSupplierRecovery> {
  if (raw.length > 24000) throw new Error("The retained instruction exceeds its recovery limit. Keep its file for review; it was not resent.");
  const saved = metadataSchema.parse(JSON.parse(raw));
  if (!sameSupplierRecoveryIdentity(saved, identity)) throw new Error("This retained instruction belongs to different production access. It was not adopted or sent.");
  if (await supplierRecoveryRequestDigest(saved.envelope) !== saved.requestDigest) throw new Error("The retained instruction changed after review. Check its original receipt before another action.");
  const envelope = envelopeSchema.parse(saved.envelope);
  if (await supplierRecoveryRequestDigest(envelope) !== saved.requestDigest) throw new Error("The retained instruction no longer matches its reviewed content. It was not resent.");
  return { ...saved, envelope };
}
/** Every dispatch, including a manual retry, first retains and reads back these exact bytes. */
export function retainSupplierRecovery(storage: StoragePort, pending: PendingSupplierRecovery): string {
  const key = supplierRecoveryRecoveryKey(pending), raw = JSON.stringify(pending), existing = storage.getItem(key);
  if (existing !== null && existing !== raw) throw new Error("Another retained instruction already belongs to this session. Check that original result before sending another.");
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("This browser could not retain the exact reviewed instruction. Nothing new was sent. Restore browser storage before continuing.");
  return raw;
}
export function clearSupplierRecovery(storage: StoragePort, pending: PendingSupplierRecovery) {
  const key = supplierRecoveryRecoveryKey(pending), existing = storage.getItem(key);
  if (existing !== null && existing !== JSON.stringify(pending)) throw new Error("Recovery storage changed in another view. Its retained instruction was preserved.");
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("The receipt is confirmed, but this browser could not retire its recovery file. Keep it and check the original receipt again.");
}
export function isSupplierRecoveryWorkspace(value: unknown): value is SupplierRecoveryWorkspace {
  if (!value || typeof value !== "object") return false;
  const data = value as SupplierRecoveryWorkspace;
  return typeof data.tenantId === "string" && Boolean(data.tenantId) && typeof data.actorId === "string" && Boolean(data.actorId)
    && typeof data.sessionFingerprint === "string" && /^[a-f0-9]{64}$/.test(data.sessionFingerprint)
    && Number.isSafeInteger(data.revision) && data.revision > 0 && ["producer", "operator", "supplier"].includes(data.access)
    && Number.isFinite(Date.parse(data.clock)) && Number.isFinite(Date.parse(data.expiresAt))
    && [data.cards, data.history, data.requests].every(Array.isArray);
}
export function matchesSupplierRecoveryReceipt(value: unknown, pending: PendingSupplierRecovery): value is SupplierRecoveryResult {
  if (!value || typeof value !== "object") return false;
  const result = value as SupplierRecoveryResult, receipt = result.receipt;
  const invitation = result.invitation;
  if (pending.envelope.command.type === "open_supplier" && (!invitation || invitation.supplierId !== pending.envelope.command.supplierId || !/^\/supplier\/access#[A-Za-z0-9_-]{43}$/.test(invitation.url) || !Number.isFinite(Date.parse(invitation.expiresAt)))) return false;
  if (pending.envelope.command.type !== "open_supplier" && invitation !== undefined) return false;
  return isSupplierRecoveryWorkspace(result.workspace) && sameSupplierRecoveryIdentity(result.workspace, pending)
    && Boolean(receipt) && receipt.commandId === pending.envelope.commandId && receipt.action === pending.envelope.command.type
    && receipt.requestDigest === pending.requestDigest && Number.isSafeInteger(receipt.revision)
    && receipt.revision >= pending.envelope.expectedRevision && result.workspace.revision >= receipt.revision
    && typeof receipt.message === "string" && Number.isFinite(Date.parse(receipt.at)) && typeof result.replayed === "boolean";
}
export const definiteSupplierRecoveryRejection = (status: number, code: string) => [400, 403, 409, 413, 422].includes(status) && !["IDEMPOTENCY_CONFLICT", "SUPPLIER_RECOVERY_COMMAND_OWNER"].includes(code);
