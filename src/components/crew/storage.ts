import { z } from "zod";
import { crewAcknowledgmentCommandSchema, crewCommandEnvelopeSchema, crewDataSchema, type CrewCommandEnvelope, type CrewData, type CrewReadback } from "@/domain/crew/contracts";

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const pendingSchema = z.object({
  idempotencyKey: z.uuid(), personId: z.string().min(1).max(120), createdAt: z.iso.datetime(),
  command: crewAcknowledgmentCommandSchema,
  expectedRevision: z.number().int().positive().nullable(),
  status: z.enum(["queued", "attempted", "stale_rejected"]),
  rejectedRevisions: z.array(z.number().int().positive()).max(100),
}).strict().refine(value => value.status !== "attempted" || value.expectedRevision !== null);
export type PendingReadback = z.infer<typeof pendingSchema>;
const liveSchema = z.object({ personId: z.string().min(1).max(120), createdAt: z.iso.datetime(), envelope: crewCommandEnvelopeSchema }).strict().refine(value => value.envelope.command.type !== "acknowledge");
export type PendingLiveAction = z.infer<typeof liveSchema>;
const outboxSchema = z.object({ version: z.literal(1), capabilityFingerprint: fingerprintSchema, readbacks: z.array(pendingSchema).max(30), live: liveSchema.nullable() }).strict();
export type CrewOutbox = z.infer<typeof outboxSchema>;
const cacheSchema = z.object({ version: z.literal(2), capabilityFingerprint: fingerprintSchema, cachedAt: z.iso.datetime(), data: crewDataSchema }).strict();
export type CrewCache = z.infer<typeof cacheSchema>;
const legacyDraftSchema = z.object({ version: z.literal(1), capabilityFingerprint: fingerprintSchema, preservedAt: z.iso.datetime(), rawDraft: z.string().max(1_000_000) }).strict();
export type LegacyCrewDraft = z.infer<typeof legacyDraftSchema>;
export interface CrewStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export async function capabilityFingerprint(token: string, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  const hash = await subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function storageKeys(fingerprint: string) {
  fingerprintSchema.parse(fingerprint);
  return { cache: `opening-night:crew-cache:v2:${fingerprint}`, outbox: `opening-night:crew-outbox:v1:${fingerprint}`, legacyDraft: `opening-night:crew-legacy-draft:v1:${fingerprint}` };
}
export const emptyOutbox = (fingerprint: string): CrewOutbox => ({ version: 1, capabilityFingerprint: fingerprint, readbacks: [], live: null });
function parsed<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (!raw || raw.length > 1_500_000) return null;
  try { const result = schema.safeParse(JSON.parse(raw)); return result.success ? result.data : null; } catch { return null; }
}
/** The old client cached a broad snapshot under a truncated token prefix. Never
 * read that snapshot again. Its pending draft has no durable request identity;
 * preserve it separately for explicit human review, never upgrade it to an
 * authenticated or automatically replayable readback. */
export function retireLegacyCrewStorage(storage: CrewStorage, token: string, fingerprint: string): LegacyCrewDraft | null {
  const prefix = token.slice(0, 16), key = storageKeys(fingerprint).legacyDraft;
  storage.removeItem(`opening-night-sheet:${prefix}`);
  const retained = storage.getItem(key);
  let draft = parsed(retained, legacyDraftSchema);
  if (retained && (!draft || draft.capabilityFingerprint !== fingerprint)) throw new Error("The preserved older-client draft could not be verified. It remains on this device for review.");
  const oldKey = `opening-night-pending:${prefix}`, rawDraft = storage.getItem(oldKey);
  if (rawDraft !== null) {
    if (draft && draft.rawDraft !== rawDraft) throw new Error("Two different older-client drafts are retained on this device. Review them before removing either.");
    if (!draft) draft = legacyDraftSchema.parse({ version: 1, capabilityFingerprint: fingerprint, preservedAt: new Date().toISOString(), rawDraft });
    const saved = JSON.stringify(draft); storage.setItem(key, saved);
    if (storage.getItem(key) !== saved) throw new Error("The older-client draft could not be preserved. Its original copy remains on this device.");
    storage.removeItem(oldKey);
  }
  return draft;
}
export function readCache(storage: CrewStorage, fingerprint: string, now = Date.now()): CrewCache | null {
  const cache = parsed(storage.getItem(storageKeys(fingerprint).cache), cacheSchema);
  if (!cache || cache.capabilityFingerprint !== fingerprint || Date.parse(cache.data.access.expiresAt) <= now || Date.parse(cache.cachedAt) > now + 60000) return null;
  return cache;
}
export function readOutbox(storage: CrewStorage, fingerprint: string): CrewOutbox {
  const raw = storage.getItem(storageKeys(fingerprint).outbox);
  if (!raw) return emptyOutbox(fingerprint);
  const outbox = parsed(raw, outboxSchema);
  if (!outbox || outbox.capabilityFingerprint !== fingerprint) throw new Error("The saved readback queue could not be verified. Export or clear the damaged queue before creating another readback.");
  return outbox;
}
export function saveCache(storage: CrewStorage, fingerprint: string, data: CrewData, now = new Date().toISOString()): CrewCache {
  const cache = cacheSchema.parse({ version: 2, capabilityFingerprint: fingerprint, cachedAt: now, data });
  storage.setItem(storageKeys(fingerprint).cache, JSON.stringify(cache)); return cache;
}
export function saveOutbox(storage: CrewStorage, outbox: CrewOutbox) {
  const validated = outboxSchema.parse(outbox);
  storage.setItem(storageKeys(outbox.capabilityFingerprint).outbox, JSON.stringify(validated));
  // A blocked/quota-limited store must not allow a command to leave without its
  // exact recovery identity being durably retained on this device first.
  if (storage.getItem(storageKeys(outbox.capabilityFingerprint).outbox) !== JSON.stringify(validated)) throw new Error("This browser could not retain the readback identity. Enable local storage before sending.");
}
export function queueReadback(data: CrewData, seenTaskIds: string[], offline: boolean, idempotencyKey = crypto.randomUUID(), now = new Date().toISOString()): PendingReadback {
  const relevant = data.sheet.changes.map(change => change.taskId);
  if (relevant.some(id => !seenTaskIds.includes(id))) throw new Error("Review every changed personal call before acknowledging.");
  return pendingSchema.parse({ idempotencyKey, personId: data.person.id, createdAt: now, command: { type: "acknowledge", sheetVersion: data.sheet.version, sheetDigest: data.sheet.digest, seenTaskIds: relevant.slice().sort(), offline }, expectedRevision: null, status: "queued", rejectedRevisions: [] });
}
export function prepareReadbackAttempt(pending: PendingReadback, revision: number): PendingReadback {
  if (pending.status === "attempted") return pending;
  return { ...pending, expectedRevision: revision, status: "attempted" };
}
export function readbackEnvelope(pending: PendingReadback): CrewCommandEnvelope {
  if (pending.expectedRevision === null || pending.status !== "attempted") throw new Error("Persist the first attempt revision before sending this readback.");
  return { idempotencyKey: pending.idempotencyKey, expectedRevision: pending.expectedRevision, command: pending.command };
}
/** Call only after a definite STALE_REVISION response. A timeout, malformed
 * response or 5xx must keep the exact first attempted revision and payload. */
export function rejectStaleReadback(pending: PendingReadback): PendingReadback {
  if (pending.expectedRevision === null) throw new Error("This readback has no attempted revision to reject.");
  return { ...pending, status: "stale_rejected", rejectedRevisions: [...pending.rejectedRevisions, pending.expectedRevision].slice(-100) };
}
export function recoveredReadback(data: CrewData, pending: PendingReadback): CrewReadback | null {
  if (data.person.id !== pending.personId) return null;
  return data.acknowledgments.find(ack => ack.sheetVersion === pending.command.sheetVersion && ack.sheetDigest === pending.command.sheetDigest && ack.attribution === "person_capability" && (ack.commandId === pending.idempotencyKey || Boolean(ack.commandId))) ?? null;
}
export function sameReview(a: CrewData["review"], b: CrewData["review"]) {
  return Boolean(a && b && a.planVersion === b.planVersion && a.planDigest === b.planDigest && a.sheetVersion === b.sheetVersion && a.sheetDigest === b.sheetDigest && a.policyVersion === b.policyVersion);
}
