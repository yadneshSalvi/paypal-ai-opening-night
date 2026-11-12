import { z } from "zod";
import { canonical } from "@/domain/canonical";
import { supplierAdminEnvelopeSchema, type SupplierAdminEnvelope } from "@/domain/supplier-admin/commands";
import type { AdminResult, AdminWorkspace } from "@/domain/supplier-admin/contracts";
export type AdminIdentity = Pick<AdminWorkspace, "tenantId" | "actorId" | "sessionFingerprint" | "expiresAt">;
export interface PendingAdmin extends AdminIdentity { version: 1; createdAt: string; requestDigest: string; envelope: SupplierAdminEnvelope }
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const adminRecoveryKey = (value: AdminIdentity) => `opening-night:supplier-admin:v1:${encodeURIComponent(value.tenantId)}:${encodeURIComponent(value.actorId)}:${value.sessionFingerprint}:${value.expiresAt}`;
export const sameAdminIdentity = (left: AdminIdentity, right: AdminIdentity) => left.tenantId === right.tenantId && left.actorId === right.actorId && left.sessionFingerprint === right.sessionFingerprint && left.expiresAt === right.expiresAt;
export async function adminRequestDigest(value: unknown) {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function prepareAdminPending(identity: AdminIdentity, instruction: SupplierAdminEnvelope): Promise<PendingAdmin> {
  const envelope = supplierAdminEnvelopeSchema.parse(instruction);
  if (envelope.sessionFingerprint !== identity.sessionFingerprint || envelope.expiresAt !== identity.expiresAt) throw new Error("This instruction belongs to different fixed access.");
  return { version: 1, tenantId: identity.tenantId, actorId: identity.actorId, sessionFingerprint: identity.sessionFingerprint, expiresAt: identity.expiresAt, createdAt: new Date().toISOString(), envelope, requestDigest: await adminRequestDigest(envelope) };
}
const savedSchema = z.object({ version: z.literal(1), tenantId: z.uuid(), actorId: z.string().min(1).max(180), sessionFingerprint: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string(), createdAt: z.iso.datetime(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/), envelope: supplierAdminEnvelopeSchema }).strict();
export async function parseAdminPending(raw: string, identity: AdminIdentity): Promise<PendingAdmin> {
  if (raw.length > 30000) throw new Error("The retained instruction exceeds its recovery limit. It was preserved and not sent.");
  const saved = savedSchema.parse(JSON.parse(raw));
  if (!sameAdminIdentity(saved, identity) || saved.envelope.sessionFingerprint !== identity.sessionFingerprint || saved.envelope.expiresAt !== identity.expiresAt) throw new Error("This retained instruction belongs to different exact access. It was not adopted.");
  if (await adminRequestDigest(saved.envelope) !== saved.requestDigest) throw new Error("The retained instruction changed. Read its original receipt before another action.");
  return saved;
}
export function retainAdminPending(storage: StoragePort, pending: PendingAdmin) {
  const key = adminRecoveryKey(pending), raw = JSON.stringify(pending), existing = storage.getItem(key);
  if (existing !== null && existing !== raw) throw new Error("Another original instruction is pending in this exact access. Read it before sending anything new.");
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("This browser could not retain and read back the exact instruction. Nothing was sent.");
}
export function clearAdminPending(storage: StoragePort, pending: PendingAdmin) {
  const key = adminRecoveryKey(pending), existing = storage.getItem(key);
  let matches = existing === null;
  if (existing !== null) { try { matches = canonical(JSON.parse(existing)) === canonical(pending); } catch { matches = false; } }
  if (!matches) throw new Error("Another view changed the recovery file. The original was preserved.");
  storage.removeItem(key); if (storage.getItem(key) !== null) throw new Error("The receipt is confirmed, but the recovery file could not be retired. Read the original result again.");
}
export function isAdminWorkspace(value: unknown): value is AdminWorkspace {
  if (!value || typeof value !== "object") return false; const data = value as AdminWorkspace;
  return z.uuid().safeParse(data.tenantId).success && typeof data.actorId === "string" && /^[a-f0-9]{64}$/.test(data.sessionFingerprint) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(data.expiresAt) && Number.isSafeInteger(data.revision) && data.revision > 0 && ["producer", "supplier"].includes(data.role) && Array.isArray(data.cards) && Array.isArray(data.history) && Array.isArray(data.originalServices);
}
export function matchesAdminReceipt(value: unknown, pending: PendingAdmin): value is AdminResult {
  if (!value || typeof value !== "object") return false; const result = value as AdminResult, receipt = result.receipt;
  if (!isAdminWorkspace(result.workspace) || !sameAdminIdentity(result.workspace, pending) || !receipt || receipt.commandId !== pending.envelope.commandId || receipt.action !== pending.envelope.command.type || receipt.requestDigest !== pending.requestDigest || !["completed", "refused"].includes(receipt.status) || typeof receipt.message !== "string" || !Number.isFinite(Date.parse(receipt.at)) || !Number.isSafeInteger(receipt.revision) || result.workspace.revision < receipt.revision || typeof result.replayed !== "boolean") return false;
  if (receipt.status === "completed" && receipt.revision < pending.envelope.expectedRevision) return false;
  if (pending.envelope.command.type === "invite" && receipt.status === "completed") return Boolean(result.invitation && /^\/suppliers\/manage\/owner#[A-Za-z0-9_-]{43}$/.test(result.invitation.url) && /^enrolled-[a-f0-9-]{36}$/.test(result.invitation.supplierId) && Number.isFinite(Date.parse(result.invitation.expiresAt)));
  return result.invitation === undefined;
}
export type AdminFetch = (path: string, init?: RequestInit) => Promise<Response>;
/** Unknown outcomes read the original receipt first; a retry requires a proven original 404 and fresh exact access. */
export async function resolveAdminPending(fetcher: AdminFetch, pending: PendingAdmin, retry = false): Promise<{ kind: "receipt"; result: AdminResult } | { kind: "not_received" }> {
  const response = await fetcher(`/api/supplier-admin/commands/${pending.envelope.commandId}`, { cache: "no-store" }), body = await response.json();
  if (response.ok) {
    if (!matchesAdminReceipt(body, pending)) throw new Error("The returned receipt does not match the exact saved instruction. It remains pending.");
    return { kind: "receipt", result: body };
  }
  if (response.status !== 404 || body.code !== "SUPPLIER_ADMIN_COMMAND_NOT_FOUND") throw new Error(body.error ?? "The original result could not be verified. The instruction remains saved.");
  if (!retry) return { kind: "not_received" };
  const current = await fetcher("/api/supplier-admin", { cache: "no-store" }), workspace = await current.json();
  if (!current.ok || !isAdminWorkspace(workspace) || !sameAdminIdentity(workspace, pending) || Date.parse(workspace.serverAt) >= Date.parse(pending.expiresAt)) throw new Error("The original fixed access ended or changed. The saved instruction was not resent.");
  const result = await fetcher("/api/supplier-admin/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending.envelope) }), receipt = await result.json();
  if (!result.ok || !matchesAdminReceipt(receipt, pending)) throw new Error(receipt.error ?? "The original command result is still unverified. Keep its saved identity.");
  return { kind: "receipt", result: receipt };
}
