import { z } from "zod";
import { canonical } from "@/domain/canonical";
import { inputEnvelopeSchema, inputScopeSchema, type InputCommandResult, type InputEnvelope, type InputScope, type InputWorkspace } from "@/domain/production-inputs/contracts";
export interface PendingInput { version: 1; scope: InputScope; envelope: InputEnvelope; requestDigest: string; createdAt: string }
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const inputRecoveryKey = (scope: InputScope) => `opening-night:production-input:v1:${scope.sessionFingerprint}`;
export const sameInputScope = (left: InputScope, right: InputScope) => canonical(left) === canonical(right);
export async function inputDigest(value: unknown) { const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))); return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
export async function prepareInput(scope: InputScope, raw: InputEnvelope): Promise<PendingInput> {
  inputScopeSchema.parse(scope); const envelope = inputEnvelopeSchema.parse(raw);
  if (!sameInputScope(scope, envelope.scope)) throw new Error("This instruction belongs to different original producer access.");
  return { version: 1, scope, envelope, requestDigest: await inputDigest(envelope), createdAt: new Date().toISOString() };
}
export async function parsePendingInput(raw: string, scope: InputScope): Promise<PendingInput> {
  if (raw.length > 270000) throw new Error("The original recovery record exceeds its bound. It was not resent.");
  const value = z.strictObject({ version: z.literal(1), scope: inputScopeSchema, envelope: inputEnvelopeSchema, requestDigest: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime() }).parse(JSON.parse(raw));
  if (!sameInputScope(value.scope, scope) || !sameInputScope(value.envelope.scope, scope) || await inputDigest(value.envelope) !== value.requestDigest) throw new Error("The retained instruction belongs to different access or changed content. Nothing was resent.");
  return value;
}
export function retainInput(storage: StoragePort, pending: PendingInput) {
  const key = inputRecoveryKey(pending.scope), raw = JSON.stringify(pending), old = storage.getItem(key);
  if (old !== null && old !== raw) throw new Error("An earlier instruction is unresolved. Check its original result first.");
  storage.setItem(key, raw); if (storage.getItem(key) !== raw) throw new Error("The browser could not preserve this instruction. Nothing was sent.");
}
export function clearInput(storage: StoragePort, pending: PendingInput) {
  const key = inputRecoveryKey(pending.scope), old = storage.getItem(key);
  if (old !== null && old !== JSON.stringify(pending)) throw new Error("Another view changed the recovery record. The original is preserved.");
  storage.removeItem(key); if (storage.getItem(key) !== null) throw new Error("The saved receipt is confirmed, but its browser recovery record remains. Check the same result again.");
}
export async function matchesInputReceipt(value: unknown, pending: PendingInput): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const result = value as InputCommandResult, receipt = result.receipt;
  if (!receipt || typeof result.replayed !== "boolean" || receipt.version !== 1 || receipt.commandId !== pending.envelope.commandId || receipt.scopeId !== pending.scope.sessionFingerprint || receipt.expiresAt !== pending.scope.sessionExpiresAt || receipt.requestDigest !== pending.requestDigest || receipt.action !== pending.envelope.command.type || !Number.isFinite(Date.parse(receipt.acceptedAt)) || !Number.isSafeInteger(receipt.result?.revision) || !Number.isSafeInteger(receipt.result?.inputRevision) || typeof receipt.result.message !== "string") return false;
  const { receiptDigest, ...content } = receipt; if (await inputDigest(content) !== receiptDigest) return false;
  const command = pending.envelope.command;
  if (command.type === "approve") return z.uuid().safeParse(receipt.result.editionId).success && receipt.result.previewId === command.previewId && receipt.result.revision === pending.envelope.expectedRevision + 1 && receipt.result.inputRevision === pending.envelope.inputRevision + 1;
  if (receipt.result.revision !== pending.envelope.expectedRevision || receipt.result.inputRevision !== pending.envelope.inputRevision) return false;
  if (command.type === "retain_source" || command.type === "admit_document") return z.uuid().safeParse(receipt.result.sourceId).success;
  if (command.type === "propose") return z.uuid().safeParse(receipt.result.proposalId).success;
  if (command.type === "preview") return receipt.result.proposalId === command.proposalId && z.uuid().safeParse(receipt.result.previewId).success;
  return receipt.result.proposalId === command.proposalId;
}
export function isInputWorkspace(value: unknown): value is InputWorkspace {
  if (!value || typeof value !== "object") return false;
  const data = value as InputWorkspace;
  return data.version === 1 && inputScopeSchema.safeParse(data.scope).success && Number.isSafeInteger(data.revision) && data.revision > 0 && Number.isSafeInteger(data.inputRevision) && data.inputRevision >= 0 && Number.isFinite(Date.parse(data.serverAt)) && typeof data.production?.title === "string" && Array.isArray(data.sources) && Array.isArray(data.proposals) && Array.isArray(data.editions) && Array.isArray(data.resources) && Array.isArray(data.documents) && Array.isArray(data.tasks);
}
