import { z } from "zod";
import { audienceEnvelopeSchema, type AudienceEnvelope, type AudienceIdentity, type AudienceResult } from "@/domain/audience/contracts";
import { audienceBrowserDigest, parseAudienceResult } from "./validation";
export const sameAudienceIdentity = (left: AudienceIdentity, right: AudienceIdentity) => left.tenantId === right.tenantId && left.actorId === right.actorId && left.sessionFingerprint === right.sessionFingerprint;
export const audienceRecoveryKey = (value: AudienceIdentity) => `opening-night:audience:v1:${encodeURIComponent(value.tenantId)}:${encodeURIComponent(value.actorId)}:${value.sessionFingerprint}`;
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type FixedAccess = AudienceIdentity & { expiresAt: string };
const base = { version: z.literal(1), tenantId: z.uuid(), actorId: z.string().min(1).max(240), sessionFingerprint: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.iso.datetime({ offset: true }), createdAt: z.iso.datetime(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/) };
const metadata = z.discriminatedUnion("kind", [z.object({ ...base, kind: z.literal("command"), envelope: audienceEnvelopeSchema }).strict(), z.object({ ...base, kind: z.literal("work"), commandId: z.uuid(), originalRequestDigest: z.string().regex(/^[a-f0-9]{64}$/), proof: z.string().regex(/^[a-f0-9]{64}$/) }).strict()]);
export type AudienceJournal = z.infer<typeof metadata>;
export async function prepareAudienceCommand(identity: FixedAccess, envelope: AudienceEnvelope): Promise<AudienceJournal> {
  const parsed = audienceEnvelopeSchema.parse(envelope);
  if (parsed.sessionFingerprint !== identity.sessionFingerprint || parsed.sessionExpiresAt !== identity.expiresAt) throw new Error("The reviewed instruction belongs to different exact producer access or its fixed access expiry. Nothing was sent.");
  return metadata.parse({ version: 1, kind: "command", tenantId: identity.tenantId, actorId: identity.actorId, sessionFingerprint: identity.sessionFingerprint, expiresAt: identity.expiresAt, createdAt: new Date().toISOString(), envelope: parsed, requestDigest: await audienceBrowserDigest(parsed) });
}
export async function prepareAudienceWork(identity: FixedAccess, commandId: string, originalRequestDigest: string, proof: string): Promise<AudienceJournal> {
  return metadata.parse({ version: 1, kind: "work", tenantId: identity.tenantId, actorId: identity.actorId, sessionFingerprint: identity.sessionFingerprint, expiresAt: identity.expiresAt, createdAt: new Date().toISOString(), commandId, originalRequestDigest, proof, requestDigest: await audienceBrowserDigest({ commandId, originalRequestDigest, proof, expiresAt: identity.expiresAt }) });
}
export async function parseAudienceJournal(raw: string, identity: FixedAccess): Promise<AudienceJournal> {
  if (raw.length > 48000) throw new Error("The retained audience instruction exceeds its recovery bound. Keep its file; nothing was resent.");
  let value: AudienceJournal;
  try { value = metadata.parse(JSON.parse(raw)); }
  catch { throw new Error("The retained audience file does not match its exact command contract. Keep the original file; nothing was resent."); }
  if (!sameAudienceIdentity(value, identity) || value.expiresAt !== identity.expiresAt) throw new Error("This retained instruction belongs to different exact producer access or its fixed expiry. It was not adopted or sent.");
  if (value.kind === "command" && (value.envelope.sessionFingerprint !== value.sessionFingerprint || value.envelope.sessionExpiresAt !== value.expiresAt)) throw new Error("The retained instruction does not match its original exact producer access and fixed access expiry. Nothing was resent.");
  const expected = value.kind === "command" ? await audienceBrowserDigest(value.envelope) : await audienceBrowserDigest({ commandId: value.commandId, originalRequestDigest: value.originalRequestDigest, proof: value.proof, expiresAt: value.expiresAt });
  if (expected !== value.requestDigest) throw new Error("The retained instruction changed after review. Its original result must be checked before another action.");
  return value;
}
export function retainAudienceJournal(storage: Store, value: AudienceJournal) {
  const key = audienceRecoveryKey(value), raw = JSON.stringify(value), prior = storage.getItem(key);
  if (prior !== null && prior !== raw) throw new Error("Another original instruction is retained for this access. Read that exact result before changing the audience workflow.");
  storage.setItem(key, raw); if (storage.getItem(key) !== raw) throw new Error("The browser could not retain the exact reviewed instruction. Nothing new was sent.");
  return raw;
}
export function clearAudienceJournal(storage: Store, value: AudienceJournal) {
  const key = audienceRecoveryKey(value), raw = storage.getItem(key);
  if (raw !== null && raw !== JSON.stringify(value)) throw new Error("Recovery storage changed in another view. Its original instruction was preserved.");
  storage.removeItem(key); if (storage.getItem(key) !== null) throw new Error("The receipt is verified, but its recovery file could not be retired. Keep it and check the original result again.");
}
export function matchAudienceResult(raw: unknown, pending: AudienceJournal): AudienceResult {
  const value = parseAudienceResult(raw), receipt = value.receipt;
  const commandId = pending.kind === "command" ? pending.envelope.commandId : pending.commandId, requestDigest = pending.kind === "command" ? pending.requestDigest : pending.originalRequestDigest;
  if (!sameAudienceIdentity(value.workspace, pending) || value.workspace.expiresAt !== pending.expiresAt || receipt.commandId !== commandId || receipt.requestDigest !== requestDigest || value.workspace.revision < receipt.revision || pending.kind === "command" && (receipt.action !== pending.envelope.command.type || receipt.revision <= pending.envelope.expectedRevision) || pending.kind === "work" && (receipt.action !== "deliver_message" || receipt.recordId !== pending.commandId)) throw new Error("The response does not match this exact original instruction, content and producer access. Nothing was resent.");
  if (value.invitation && (receipt.action !== "create_invite" || value.invitation.capabilityId !== receipt.recordId)) throw new Error("The invitation belongs to a different original instruction. It was not accepted.");
  return value;
}
export const definiteAudienceRejection = (status: number, code: string) => [400, 403, 409, 413, 415, 422].includes(status) && !["IDEMPOTENCY_CONFLICT", "AUDIENCE_COMMAND_OWNER"].includes(code);
