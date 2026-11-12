import { z } from "zod";
import { canonical } from "@/domain/canonical";
import { producerConsentEnvelopeSchema, reviewerConsentEnvelopeSchema, type ConsentCommandResult, type ConsentEnvelope, type ProducerConsentWorkspace, type ReviewerConsentView } from "@/domain/plan-consents";

export interface ConsentClientScope { kind: "producer" | "reviewer"; id: string; fingerprint: string; expiresAt: string; tenantId: string | null }
export interface PendingConsent { version: 1; scope: ConsentClientScope; createdAt: string; requestDigest: string; envelope: ConsentEnvelope }
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.strictObject({ kind: z.enum(["producer", "reviewer"]), id: z.string().min(1).max(300), fingerprint: hash, expiresAt: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/), tenantId: z.uuid().nullable() });
const pendingSchema = z.strictObject({ version: z.literal(1), scope: scopeSchema, createdAt: z.iso.datetime(), requestDigest: hash, envelope: z.unknown() });
export const consentRecoveryKey = (scope: ConsentClientScope) => `opening-night:plan-consent:v1:${scope.kind}:${scope.fingerprint}`;
export const sameConsentScope = (left: ConsentClientScope, right: ConsentClientScope) => canonical(left) === canonical(right);
export const producerClientScope = (view: ProducerConsentWorkspace): ConsentClientScope => ({ kind: "producer", id: view.scope.actorId, fingerprint: view.scope.sessionFingerprint, expiresAt: view.scope.sessionExpiresAt, tenantId: view.scope.tenantId });
export const reviewerClientScope = (view: ReviewerConsentView): ConsentClientScope => ({ kind: "reviewer", id: view.review.requestId, fingerprint: view.capabilityFingerprint, expiresAt: view.review.expiresAt, tenantId: null });
export async function consentDigest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function parseEnvelope(value: unknown, scope: ConsentClientScope): ConsentEnvelope {
  const envelope = scope.kind === "producer" ? producerConsentEnvelopeSchema.parse(value) : reviewerConsentEnvelopeSchema.parse(value);
  const bound = "scope" in envelope
    ? { kind: "producer" as const, id: envelope.scope.actorId, fingerprint: envelope.scope.sessionFingerprint, expiresAt: envelope.scope.sessionExpiresAt, tenantId: envelope.scope.tenantId }
    : { kind: "reviewer" as const, id: envelope.requestId, fingerprint: envelope.capabilityFingerprint, expiresAt: envelope.expiresAt, tenantId: null };
  if (!sameConsentScope(scope, bound)) throw new Error("This instruction belongs to different original review access. Nothing was sent.");
  return envelope;
}
export async function prepareConsent(scope: ConsentClientScope, input: ConsentEnvelope): Promise<PendingConsent> {
  scopeSchema.parse(scope); const envelope = parseEnvelope(input, scope);
  return { version: 1, scope, envelope, createdAt: new Date().toISOString(), requestDigest: await consentDigest(envelope) };
}
export async function parsePendingConsent(raw: string, scope: ConsentClientScope): Promise<PendingConsent> {
  if (raw.length > 26000) throw new Error("The retained instruction exceeds its recovery limit. It was not resent.");
  const pending = pendingSchema.parse(JSON.parse(raw));
  if (!sameConsentScope(pending.scope, scope)) throw new Error("This pending instruction belongs to different original access or expiry.");
  if (await consentDigest(pending.envelope) !== pending.requestDigest) throw new Error("The retained instruction changed after review. Nothing was resent.");
  const envelope = parseEnvelope(pending.envelope, scope);
  if (await consentDigest(envelope) !== pending.requestDigest) throw new Error("The retained bytes no longer match their reviewed instructions.");
  return { ...pending, envelope };
}
export function retainConsent(storage: StoragePort, pending: PendingConsent) {
  const key = consentRecoveryKey(pending.scope), raw = JSON.stringify(pending), existing = storage.getItem(key);
  if (existing !== null && existing !== raw) throw new Error("An earlier instruction is still unresolved. Check its original result first.");
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("This browser could not retain the instruction. Nothing new was sent.");
}
export function clearConsent(storage: StoragePort, pending: PendingConsent) {
  const key = consentRecoveryKey(pending.scope), old = storage.getItem(key);
  if (old !== null && old !== JSON.stringify(pending)) throw new Error("Another view changed the recovery record. Its original instruction was preserved.");
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("The receipt is saved, but this browser could not retire its pending record. Check the original result again.");
}
export async function matchesConsentReceipt(value: unknown, pending: PendingConsent): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const result = value as ConsentCommandResult, receipt = result.receipt;
  if (!receipt || receipt.version !== 1 || typeof result.replayed !== "boolean" || receipt.commandId !== pending.envelope.commandId || receipt.scopeId !== pending.scope.fingerprint || receipt.expiresAt !== pending.scope.expiresAt || receipt.requestDigest !== pending.requestDigest || !Number.isFinite(Date.parse(receipt.acceptedAt)) || typeof receipt.result?.message !== "string") return false;
  const action = "command" in pending.envelope ? pending.envelope.command.type : pending.envelope.decision;
  if (receipt.action !== action) return false;
  const { receiptDigest, ...content } = receipt;
  if (receiptDigest !== await consentDigest(content)) return false;
  if ("command" in pending.envelope) {
    const command = pending.envelope.command;
    if (command.type === "invite" && (!z.uuid().safeParse(receipt.result.requestId).success || !hash.safeParse(receipt.result.reviewDigest).success || !/^\/approvals\/review#[A-Za-z0-9_-]{43}$/.test(receipt.result.reviewPath ?? ""))) return false;
    if (command.type === "revoke" && (receipt.result.requestId !== command.requestId || receipt.result.reviewDigest !== command.reviewDigest)) return false;
    if (command.type === "approve_plan" && (receipt.result.candidateDigest !== command.candidateDigest || !Number.isSafeInteger(receipt.result.revision) || receipt.result.revision !== pending.envelope.expectedRevision + 1 || !Number.isSafeInteger(receipt.result.planVersion) || !Array.isArray(receipt.result.externalApprovals))) return false;
  } else {
    const decision = receipt.result.decision;
    if (!decision || receipt.result.requestId !== pending.envelope.requestId || receipt.result.reviewDigest !== pending.envelope.reviewDigest || decision.requestId !== pending.envelope.requestId || decision.reviewDigest !== pending.envelope.reviewDigest || decision.decision !== pending.envelope.decision || decision.declaredName !== pending.envelope.declaredName || decision.statement !== pending.envelope.statement) return false;
    const { receiptDigest: decisionDigest, ...body } = decision;
    if (decisionDigest !== await consentDigest(body)) return false;
  }
  return true;
}
export function isProducerConsentWorkspace(value: unknown): value is ProducerConsentWorkspace {
  if (!value || typeof value !== "object") return false;
  const data = value as ProducerConsentWorkspace;
  return Boolean(data.scope && producerConsentEnvelopeSchema.shape.scope.safeParse(data.scope).success && Number.isSafeInteger(data.revision) && data.revision > 0 && Number.isSafeInteger(data.approvalRevision) && data.approvalRevision >= 0 && Number.isFinite(Date.parse(data.serverAt)) && data.production?.title && Array.isArray(data.actorRoles) && Array.isArray(data.sources) && Array.isArray(data.candidates) && Array.isArray(data.requests));
}
export function isReviewerConsentView(value: unknown): value is ReviewerConsentView {
  if (!value || typeof value !== "object") return false;
  const data = value as ReviewerConsentView;
  return Boolean(data.review?.version === 1 && z.uuid().safeParse(data.review.requestId).success && hash.safeParse(data.reviewDigest).success && hash.safeParse(data.capabilityFingerprint).success && Number.isFinite(Date.parse(data.review.expiresAt)) && Number.isFinite(Date.parse(data.serverAt)) && Array.isArray(data.review.changes) && data.review.requirement?.role === "artist_representative" && data.review.representative?.invitedName && typeof data.state === "string");
}
