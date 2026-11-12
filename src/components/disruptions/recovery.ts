import { z } from "zod";
import { canonical } from "@/domain/canonical";
import type { DisruptionEnvelope, DisruptionResult, DisruptionWorkspace } from "@/server/disruptions/contracts";

export type DisruptionIdentity = Pick<DisruptionWorkspace, "tenantId" | "actorId" | "sessionFingerprint">;
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reviewedText = (min: number, max: number) => z.string().min(min).max(max).refine(value => value === value.trim());
// The browser validates its retained file without importing a server or payment implementation.
const envelopeSchema: z.ZodType<DisruptionEnvelope> = z.object({
  idempotencyKey: z.uuid(), expectedRevision: z.number().int().positive(),
  command: z.discriminatedUnion("type", [
    z.object({ type: z.literal("report"), offerId: z.string().min(1).max(120), offerRevision: z.number().int().positive(), executionId: z.uuid().nullable(), availability: z.enum(["delayed", "unavailable", "available"]), earliestAt: z.iso.datetime({ offset: true }).nullable(), observedAt: z.iso.datetime({ offset: true }), reference: reviewedText(3, 180), detail: reviewedText(12, 1200), confirmed: z.literal(true) }).strict(),
    z.object({ type: z.literal("assess") }).strict(),
    z.object({ type: z.literal("decide"), mode: z.enum(["support_only", "cancel_show"]), assessmentId: z.uuid(), previewDigest: hash, admissionRefundMinor: z.number().int().min(0).max(3500), detail: reviewedText(12, 1200), confirmed: z.literal(true) }).strict(),
    z.object({ type: z.literal("stop_remedies"), decisionId: z.uuid(), detail: reviewedText(12, 1200) }).strict(),
    z.object({ type: z.literal("reconcile_remedies"), decisionId: z.uuid() }).strict(),
    z.object({ type: z.literal("retry_remedy"), decisionId: z.uuid(), itemId: z.uuid(), confirmed: z.literal(true) }).strict(),
    z.object({ type: z.literal("cancel_rental"), executionId: z.uuid(), detail: reviewedText(12, 1200), confirmed: z.literal(true) }).strict(),
  ]),
}).strict();
const metadataSchema = z.object({ version: z.literal(1), tenantId: z.string().min(1), actorId: z.string().min(1), sessionFingerprint: hash, createdAt: z.iso.datetime(), requestDigest: hash, envelope: z.unknown() }).strict();
export type PendingDisruption = DisruptionIdentity & { version: 1; createdAt: string; requestDigest: string; envelope: DisruptionEnvelope };

export const disruptionRecoveryKey = (identity: DisruptionIdentity) => `opening-night:disruption:v1:${encodeURIComponent(identity.tenantId)}:${encodeURIComponent(identity.actorId)}:${identity.sessionFingerprint}`;
export async function disruptionRequestDigest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function sameDisruptionIdentity(left: DisruptionIdentity, right: DisruptionIdentity) {
  return left.tenantId === right.tenantId && left.actorId === right.actorId && left.sessionFingerprint === right.sessionFingerprint;
}
export async function prepareDisruption(identity: DisruptionIdentity, instruction: DisruptionEnvelope): Promise<PendingDisruption> {
  const envelope = envelopeSchema.parse(instruction);
  return { version: 1, tenantId: identity.tenantId, actorId: identity.actorId, sessionFingerprint: identity.sessionFingerprint, createdAt: new Date().toISOString(), requestDigest: await disruptionRequestDigest(envelope), envelope };
}
export async function parseDisruption(raw: string, identity: DisruptionIdentity): Promise<PendingDisruption> {
  if (raw.length > 24000) throw new Error("The retained instruction exceeds its recovery limit. Keep its file for review; it was not resent.");
  const saved = metadataSchema.parse(JSON.parse(raw));
  if (!sameDisruptionIdentity(saved, identity)) throw new Error("This retained instruction belongs to different production access. It was not adopted or sent.");
  if (await disruptionRequestDigest(saved.envelope) !== saved.requestDigest) throw new Error("The retained instruction changed after review. Check its original receipt before another action.");
  const envelope = envelopeSchema.parse(saved.envelope);
  if (await disruptionRequestDigest(envelope) !== saved.requestDigest) throw new Error("The retained instruction no longer matches its reviewed content. It was not resent.");
  return { ...saved, envelope };
}
/** Every dispatch, including a manual retry, first retains and reads back these exact bytes. */
export function retainDisruption(storage: StoragePort, pending: PendingDisruption): string {
  const key = disruptionRecoveryKey(pending), raw = JSON.stringify(pending), existing = storage.getItem(key);
  if (existing !== null && existing !== raw) throw new Error("Another retained instruction already belongs to this session. Check that original result before sending another.");
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("This browser could not retain the exact reviewed instruction. Nothing new was sent. Restore browser storage before continuing.");
  return raw;
}
export function clearDisruption(storage: StoragePort, pending: PendingDisruption) {
  const key = disruptionRecoveryKey(pending), existing = storage.getItem(key);
  if (existing !== null && existing !== JSON.stringify(pending)) throw new Error("Recovery storage changed in another view. Its retained instruction was preserved.");
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("The receipt is confirmed, but this browser could not retire its recovery file. Keep it and check the original receipt again.");
}
export function isDisruptionWorkspace(value: unknown): value is DisruptionWorkspace {
  if (!value || typeof value !== "object") return false;
  const data = value as DisruptionWorkspace;
  return typeof data.tenantId === "string" && Boolean(data.tenantId) && typeof data.actorId === "string" && Boolean(data.actorId)
    && typeof data.sessionFingerprint === "string" && /^[a-f0-9]{64}$/.test(data.sessionFingerprint)
    && Number.isSafeInteger(data.revision) && data.revision > 0 && ["producer", "operator", "supplier"].includes(data.access)
    && typeof data.providerActionsEnabled === "boolean" && typeof data.assessmentIsCurrent === "boolean" && Number.isFinite(Date.parse(data.clock)) && Number.isFinite(Date.parse(data.expiresAt))
    && [data.offers, data.reports, data.assessments, data.remedies, data.historicalDecisions, data.rentalCommitments, data.obligations].every(Array.isArray);
}
export function matchesDisruptionReceipt(value: unknown, pending: PendingDisruption): value is DisruptionResult {
  if (!value || typeof value !== "object") return false;
  const result = value as DisruptionResult, receipt = result.receipt;
  return isDisruptionWorkspace(result.workspace) && sameDisruptionIdentity(result.workspace, pending)
    && Boolean(receipt) && receipt.commandId === pending.envelope.idempotencyKey && receipt.action === pending.envelope.command.type
    && receipt.requestDigest === pending.requestDigest && Number.isSafeInteger(receipt.revision)
    && receipt.revision >= pending.envelope.expectedRevision && result.workspace.revision >= receipt.revision
    && typeof receipt.message === "string" && Number.isFinite(Date.parse(receipt.at)) && typeof result.replayed === "boolean";
}
export const definiteDisruptionRejection = (status: number, code: string) => [400, 403, 409, 413, 422].includes(status) && !["IDEMPOTENCY_CONFLICT", "DISRUPTION_COMMAND_OWNERSHIP"].includes(code);
