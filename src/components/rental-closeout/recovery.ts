import { z } from "zod";
import { canonical } from "@/domain/canonical";
import type { CloseoutEnvelope, CloseoutResult, CloseoutWorkspace } from "@/server/rental-closeout/contracts";

export type CloseoutIdentity = Pick<CloseoutWorkspace, "tenantId" | "actorId" | "sessionFingerprint">;
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reviewedText = (min: number, max: number) => z.string().min(min).max(max).refine(value => value === value.trim());
// The browser validates its retained file without importing a server or payment implementation.
const envelopeSchema: z.ZodType<CloseoutEnvelope> = z.object({
  commandId: z.uuid(), expectedRevision: z.number().int().positive(),
  command: z.discriminatedUnion("type", [
    z.object({ type: z.literal("record_return"), executionId: z.uuid(), executionDigest: hash, previousInspectionId: z.uuid().nullable(), observedAt: z.iso.datetime(), condition: z.enum(["undamaged", "damage_reported"]), detail: reviewedText(12, 1600), confirmed: z.literal(true) }).strict(),
    z.object({ type: z.literal("approve_closeout"), executionId: z.uuid(), previewDigest: hash, detail: reviewedText(12, 1600), confirmed: z.literal(true) }).strict(),
    z.object({ type: z.literal("stop_closeout"), grantId: z.uuid(), detail: reviewedText(12, 1600), confirmed: z.literal(true) }).strict(),
    z.object({ type: z.literal("reconcile_closeout"), executionId: z.uuid(), intentId: z.uuid() }).strict(),
    z.object({ type: z.literal("retry_closeout"), grantId: z.uuid(), intentId: z.uuid(), confirmed: z.literal(true) }).strict(),
  ]),
}).strict();
const metadataSchema = z.object({ version: z.literal(1), tenantId: z.string().min(1), actorId: z.string().min(1), sessionFingerprint: hash, createdAt: z.iso.datetime(), requestDigest: hash, envelope: z.unknown() }).strict();
export type PendingCloseout = CloseoutIdentity & { version: 1; createdAt: string; requestDigest: string; envelope: CloseoutEnvelope };

export const closeoutRecoveryKey = (identity: CloseoutIdentity) => `opening-night:rental-closeout:v1:${encodeURIComponent(identity.tenantId)}:${encodeURIComponent(identity.actorId)}:${identity.sessionFingerprint}`;
export async function closeoutRequestDigest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function sameCloseoutIdentity(left: CloseoutIdentity, right: CloseoutIdentity) {
  return left.tenantId === right.tenantId && left.actorId === right.actorId && left.sessionFingerprint === right.sessionFingerprint;
}
export async function prepareCloseout(identity: CloseoutIdentity, instruction: CloseoutEnvelope): Promise<PendingCloseout> {
  const envelope = envelopeSchema.parse(instruction);
  return { version: 1, tenantId: identity.tenantId, actorId: identity.actorId, sessionFingerprint: identity.sessionFingerprint, createdAt: new Date().toISOString(), requestDigest: await closeoutRequestDigest(envelope), envelope };
}
export async function parseCloseout(raw: string, identity: CloseoutIdentity): Promise<PendingCloseout> {
  if (raw.length > 24000) throw new Error("The retained instruction exceeds its recovery limit. Keep its file for review; it was not resent.");
  const saved = metadataSchema.parse(JSON.parse(raw));
  if (!sameCloseoutIdentity(saved, identity)) throw new Error("This retained instruction belongs to different production access. It was not adopted or sent.");
  if (await closeoutRequestDigest(saved.envelope) !== saved.requestDigest) throw new Error("The retained instruction changed after review. Check its original receipt before another action.");
  const envelope = envelopeSchema.parse(saved.envelope);
  if (await closeoutRequestDigest(envelope) !== saved.requestDigest) throw new Error("The retained instruction no longer matches its reviewed content. It was not resent.");
  return { ...saved, envelope };
}
/** Every dispatch, including a manual retry, first retains and reads back these exact bytes. */
export function retainCloseout(storage: StoragePort, pending: PendingCloseout): string {
  const key = closeoutRecoveryKey(pending), raw = JSON.stringify(pending), existing = storage.getItem(key);
  if (existing !== null && existing !== raw) throw new Error("Another retained instruction already belongs to this session. Check that original result before sending another.");
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("This browser could not retain the exact reviewed instruction. Nothing new was sent. Restore browser storage before continuing.");
  return raw;
}
export function clearCloseout(storage: StoragePort, pending: PendingCloseout) {
  const key = closeoutRecoveryKey(pending), existing = storage.getItem(key);
  if (existing !== null && existing !== JSON.stringify(pending)) throw new Error("Recovery storage changed in another view. Its retained instruction was preserved.");
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("The receipt is confirmed, but this browser could not retire its recovery file. Keep it and check the original receipt again.");
}
export function isCloseoutWorkspace(value: unknown): value is CloseoutWorkspace {
  if (!value || typeof value !== "object") return false;
  const data = value as CloseoutWorkspace;
  return typeof data.tenantId === "string" && Boolean(data.tenantId) && typeof data.actorId === "string" && Boolean(data.actorId)
    && typeof data.sessionFingerprint === "string" && /^[a-f0-9]{64}$/.test(data.sessionFingerprint)
    && Number.isSafeInteger(data.revision) && data.revision > 0 && ["producer", "operator", "supplier"].includes(data.access)
    && typeof data.providerActionsEnabled === "boolean" && Number.isFinite(Date.parse(data.clock)) && Number.isFinite(Date.parse(data.expiresAt))
    && [data.rentals, data.history].every(Array.isArray);
}
export function matchesCloseoutReceipt(value: unknown, pending: PendingCloseout): value is CloseoutResult {
  if (!value || typeof value !== "object") return false;
  const result = value as CloseoutResult, receipt = result.receipt;
  return isCloseoutWorkspace(result.workspace) && sameCloseoutIdentity(result.workspace, pending)
    && Boolean(receipt) && receipt.commandId === pending.envelope.commandId && receipt.action === pending.envelope.command.type
    && receipt.requestDigest === pending.requestDigest && Number.isSafeInteger(receipt.revision)
    && receipt.revision >= pending.envelope.expectedRevision && result.workspace.revision >= receipt.revision
    && typeof receipt.message === "string" && Number.isFinite(Date.parse(receipt.at)) && typeof result.replayed === "boolean";
}
export const definiteCloseoutRejection = (status: number, code: string) => [400, 403, 409, 413, 422].includes(status) && !["IDEMPOTENCY_CONFLICT", "RENTAL_CLOSEOUT_COMMAND_OWNER"].includes(code);
