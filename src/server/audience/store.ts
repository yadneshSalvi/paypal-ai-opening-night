import { createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { PaymentIntent } from "@/domain/payment-authority";
import type { AudienceApproval, AudienceDelivery, AudienceDraft, AudienceInvitation, AudienceReceipt, AudienceRefundInstruction, AudienceTicketReceipt } from "@/domain/audience/contracts";
import { audienceSourceDigest, audienceTicketReceipt, originalTicketCapture } from "@/domain/audience/policy";
import { currentActual } from "@/domain/finance";
import { env } from "../env";
import { migrate, pool } from "../store";
import { openAudience, sealAudience } from "./private";

export interface AudienceAuthority { actor: Actor; sessionHash: string }
export interface AudienceIssuer extends AudienceAuthority { expiresAt: string }
export interface AudienceContext { db: PoolClient; show: ShowSnapshot; authority: AudienceAuthority; expiresAt: string; revision: number }
export interface CapabilityRecord {
  id: string; tenantId: string; ticketId: string; captureId: string; receiptDigest: string;
  issuer: AudienceIssuer; createdAt: string; expiresAt: string; invitation: AudienceInvitation;
}
export interface DraftRecord { tenantId: string; issuer: AudienceIssuer; draft: AudienceDraft;
  /** Present only when the note came from a communications-writer run and passed the deterministic fact check at save time. */
  writer?: { runId: string; provenance: "model" | "recorded_model"; model: string | null; generatedAt: string | null; recordedAt: string | null; edited: boolean; factsDigest: string; checkedAt: string; checks: import("@/domain/audience/writer").WriterCheck[] } }
export interface ApprovalRecord { tenantId: string; issuer: AudienceIssuer; approval: AudienceApproval }
export interface StopRecord { tenantId: string; approvalId: string; issuer: AudienceIssuer; at: string; detail: string }
export interface PassRecord { tenantId: string; id: string; approvalId: string; issuer: AudienceIssuer; limit: number; createdAt: string }
export interface DeliveryRecord { tenantId: string; delivery: AudienceDelivery; captureId: string; passId: string }
export interface Progress { state: "pending" | "complete" | "interrupted"; processed: number; errorCode: string | null; updatedAt: string }
export type AudienceReader = Pick<PoolClient, "query">;

export const audienceTokenHash = (token: string) => createHmac("sha256", env.sessionSecret).update("attendee-reader/v1\0" + token).digest("hex");
export const audienceFingerprint = (sessionHash: string) => digest({ purpose: "audience-producer-v1", sessionHash });
export const audienceIssuer = (context: AudienceContext): AudienceIssuer => ({ ...context.authority, expiresAt: context.expiresAt });
export const sameAudienceIssuer = (left: AudienceIssuer, right: AudienceIssuer) => left.sessionHash === right.sessionHash && left.expiresAt === right.expiresAt && digest(left.actor) === digest(right.actor);

export async function requireAudienceAuthority(db: AudienceReader, authority: AudienceAuthority, fixedExpiry?: string) {
  const { actor, sessionHash } = authority;
  if (!actor.roles.includes("producer") || actor.personId || actor.supplierId || actor.executionId || actor.roles.includes("crew")) throw new DomainError("AUDIENCE_PRODUCER_REQUIRED", "Only the current producer can review audience access and messages.", 403);
  const row = (await db.query<{ expires_at: string }>(`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at FROM on_sessions WHERE token_hash=$1 AND tenant_id=$2 AND actor=$3::jsonb AND expires_at>clock_timestamp() ${fixedExpiry ? "AND expires_at=$4::timestamptz" : ""} FOR SHARE`, [sessionHash, actor.tenantId, JSON.stringify(actor), ...(fixedExpiry ? [fixedExpiry] : [])])).rows[0];
  if (!row) throw new DomainError("AUDIENCE_SESSION_ENDED", "This exact producer access ended or changed. Another session cannot adopt its saved invitations or delivery approval.", 401);
  return row.expires_at;
}
export async function audienceTransaction<T>(authority: AudienceAuthority, mutate: boolean, work: (context: AudienceContext) => Promise<T>) {
  await migrate(); const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Wait for the real source lock before checking current authority/expiry.
    const row = (await db.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR SHARE", [authority.actor.tenantId])).rows[0];
    if (!row) throw new DomainError("SHOW_NOT_FOUND", "This production is not available.", 404);
    await db.query("INSERT INTO on_audience_workspaces(tenant_id) VALUES($1) ON CONFLICT DO NOTHING", [authority.actor.tenantId]);
    const revision = (await db.query<{ revision: number }>("SELECT revision FROM on_audience_workspaces WHERE tenant_id=$1 " + (mutate ? "FOR UPDATE" : "FOR SHARE"), [authority.actor.tenantId])).rows[0]!.revision;
    const expiresAt = await requireAudienceAuthority(db, authority);
    const value = await work({ db, show: row.snapshot, authority, expiresAt, revision });
    await requireAudienceAuthority(db, authority, expiresAt); await db.query("COMMIT"); return value;
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
export async function advanceAudience(context: AudienceContext) {
  context.revision++;
  await context.db.query("UPDATE on_audience_workspaces SET revision=$2 WHERE tenant_id=$1", [context.show.tenantId, context.revision]);
}
export async function audienceNow(db: AudienceReader) { return (await db.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0]!.at; }

const records = {
  capability: ["on_audience_capabilities", "id"], draft: ["on_audience_drafts", "id"], approval: ["on_audience_approvals", "id"],
  stop: ["on_audience_stops", "approval_id"], pass: ["on_audience_delivery_passes", "id"], delivery: ["on_audience_deliveries", "id"], revocation: ["on_audience_revocations", "capability_id"],
} as const;
export function audienceSeal(tenantId: string, kind: keyof typeof records, id: string, value: unknown) { return sealAudience(tenantId, `audience:${kind}:${id}`, value); }
export async function readAudienceRecord<T>(db: AudienceReader, tenantId: string, kind: keyof typeof records, id: string): Promise<T | null> {
  const [table, column] = records[kind];
  const row = (await db.query<{ digest: string; document_cipher: string }>(`SELECT digest,document_cipher FROM ${table} WHERE tenant_id=$1 AND ${column}=$2`, [tenantId, id])).rows[0];
  if (!row) return null;
  const record = openAudience<T>(tenantId, `audience:${kind}:${id}`, row.document_cipher);
  if (digest(record) !== row.digest) throw new DomainError("AUDIENCE_RECORD_INTEGRITY", "The exact original audience record could not be verified.", 503);
  return record;
}
export async function audienceCommandReceipt(context: AudienceContext, commandId: string, payloadHash?: string) {
  const row = (await context.db.query<{ actor_id: string; session_hash: string; session_expires_at: string; payload_hash: string; receipt_cipher: string }>(`SELECT actor_id,session_hash,to_char(session_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS session_expires_at,payload_hash,receipt_cipher FROM on_audience_commands WHERE tenant_id=$1 AND command_id=$2`, [context.show.tenantId, commandId])).rows[0];
  if (!row || row.actor_id !== context.authority.actor.id || row.session_hash !== context.authority.sessionHash) {
    if (row && payloadHash) throw new DomainError("AUDIENCE_COMMAND_OWNER", "This original instruction belongs to a different exact producer session.", 403);
    return null;
  }
  if (row.session_expires_at !== context.expiresAt) throw new DomainError("AUDIENCE_ORIGINAL_SESSION_REQUIRED", "The original instruction belongs to a different fixed access expiry. It was not adopted or renewed.", 403);
  if (payloadHash && payloadHash !== row.payload_hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This command identity already contains different reviewed instructions.");
  const receipt = openAudience<AudienceReceipt>(context.show.tenantId, `audience-command:${commandId}`, row.receipt_cipher);
  if (receipt.commandId !== commandId || receipt.requestDigest !== row.payload_hash) throw new DomainError("AUDIENCE_RECEIPT_INTEGRITY", "The original command receipt could not be verified.", 503);
  return receipt;
}
export async function saveAudienceReceipt(context: AudienceContext, receipt: AudienceReceipt) {
  await context.db.query("INSERT INTO on_audience_commands(tenant_id,command_id,actor_id,session_hash,session_expires_at,payload_hash,receipt_cipher) VALUES($1,$2,$3,$4,$5,$6,$7)", [context.show.tenantId, receipt.commandId, context.authority.actor.id, context.authority.sessionHash, context.expiresAt, receipt.requestDigest, sealAudience(context.show.tenantId, `audience-command:${receipt.commandId}`, receipt)]);
}

/** Reads existing ledger attribution only. It never initializes or invokes a payment provider. */
export async function audienceReceipts(db: AudienceReader, show: ShowSnapshot): Promise<Map<string, AudienceTicketReceipt>> {
  const exists = (await db.query<{ ready: boolean }>("SELECT to_regclass('on_payment_bindings') IS NOT NULL AND to_regclass('on_payment_intents') IS NOT NULL AND to_regclass('paycore_operations') IS NOT NULL AND to_regclass('on_payment_imports') IS NOT NULL AS ready")).rows[0]!.ready;
  const bindings = exists ? (await db.query<{ kind: string; provider_id: string; root_intent_id: string; document: PaymentIntent }>("SELECT b.kind,b.provider_id,b.root_intent_id,i.document FROM on_payment_bindings b JOIN on_payment_intents i ON i.id=b.root_intent_id AND i.tenant_id=b.tenant_id WHERE b.tenant_id=$1 AND b.seller='venue'", [show.tenantId])).rows : [];
  const intents = exists ? (await db.query<{ document: PaymentIntent }>("SELECT document FROM on_payment_intents WHERE tenant_id=$1 AND seller='venue'", [show.tenantId])).rows.map(row => row.document) : [];
  // Current operation states are retained even before a completed receipt is imported.
  // Share locks keep this read stable while a recipient's local inbox transaction commits.
  const operations = exists ? (await db.query<{ id: string; status: string }>("SELECT id,status FROM paycore_operations WHERE tenant_id=$1 AND project_id='opening-night:venue' FOR SHARE", [show.tenantId])).rows : [];
  const imported = new Set(exists ? (await db.query<{ operation_id: string }>("SELECT DISTINCT operation_id FROM on_payment_imports WHERE tenant_id=$1", [show.tenantId])).rows.map(row => row.operation_id) : []);
  const currentIds = new Set(currentActual(show).map(entry => entry.id));
  const result = new Map<string, AudienceTicketReceipt>();
  for (const ticket of show.tickets) {
    const capture = originalTicketCapture(show, ticket), binding = bindings.find(item => item.kind === "capture" && item.provider_id === capture?.providerResourceId);
    const root = binding?.document;
    const items = root?.command.action.kind === "create_order" ? root.command.action.items ?? [] : [];
    const itemsMatch = items.length === (ticket.perkMinor ? 2 : 1) && items[0]?.quantity === 1 && items[0].unitAmount.currency === "USD" && items[0].unitAmount.minor === ticket.admissionMinor && (!ticket.perkMinor || items[1]?.quantity === 1 && items[1].unitAmount.currency === "USD" && items[1].unitAmount.minor === ticket.perkMinor) && (ticket.tier === "vip" ? ticket.perkMinor > 0 : ticket.perkMinor === 0);
    const captureIntent = intents.find(item => item.command.operationId === capture?.operationId);
    const captureIntentMatches = Boolean(captureIntent && captureIntent.tenantId === show.tenantId && captureIntent.ticketId === ticket.id && captureIntent.tier === ticket.tier && ["ticket_order", "ticket_capture"].includes(captureIntent.purpose) && (captureIntent.parentId ?? captureIntent.id) === binding?.root_intent_id);
    const captureOwned = Boolean(capture && imported.has(capture.operationId) && root && root.id === binding!.root_intent_id && root.tenantId === show.tenantId && root.seller === "venue" && root.purpose === "ticket_order" && root.ticketId === ticket.id && root.tier === ticket.tier && root.command.scope.tenantId === show.tenantId && root.command.scope.projectId === "opening-night:venue" && root.command.action.kind === "create_order" && root.command.action.money.currency === "USD" && root.command.action.money.minor === ticket.admissionMinor + ticket.perkMinor && itemsMatch && captureIntentMatches && bindings.some(item => item.kind === "order" && item.provider_id === capture.parentId && item.root_intent_id === binding!.root_intent_id));
    const refundIds = new Set(bindings.filter(item => {
      if (!captureOwned || item.kind !== "refund" || item.root_intent_id !== binding!.root_intent_id) return false;
      const evidence = show.financialEvidence.find(entry => entry.kind === "refund" && entry.providerResourceId === item.provider_id && entry.ticketId === ticket.id && entry.parentId === ticket.captureId);
      const intent = evidence ? intents.find(entry => entry.command.operationId === evidence.operationId) : null;
      return Boolean(intent && imported.has(intent.command.operationId) && intent.ticketId === ticket.id && intent.parentId === root!.id && ["vip_refund", "event_refund"].includes(intent.purpose) && intent.command.action.kind === "refund_capture" && intent.command.action.captureId === ticket.captureId && intent.command.action.money.currency === "USD" && intent.command.action.money.minor === evidence!.amountMinor);
    }).map(item => item.provider_id));
    const instructions: AudienceRefundInstruction[] = intents.filter(intent => captureOwned && intent.ticketId === ticket.id && intent.parentId === root!.id && ["vip_refund", "event_refund"].includes(intent.purpose) && intent.command.action.kind === "refund_capture" && intent.command.action.captureId === ticket.captureId).map(intent => {
      const operation = operations.find(item => item.id === intent.command.operationId), confirmed = show.financialEvidence.some(entry => entry.operationId === intent.command.operationId && entry.kind === "refund" && refundIds.has(entry.providerResourceId) && currentIds.has(entry.id));
      const status: AudienceRefundInstruction["status"] = confirmed ? "confirmed" : operation?.status === "succeeded" || operation?.status === "dispatching" || operation?.status === "pending_reconciliation" ? "unknown" : operation?.status === "refused" ? "refused" : operation?.status === "not_sent" ? "not_sent" : "prepared";
      return { id: digest({ purpose: "attendee-refund-instruction", id: intent.id }), createdAt: intent.createdAt, amountMinor: intent.command.action.money.minor, admissionMinor: intent.purpose === "vip_refund" ? 0 : intent.refundAllocation?.admissionMinor ?? null, perkMinor: intent.purpose === "vip_refund" ? 1500 : intent.refundAllocation?.perkMinor ?? null, status };
    });
    const captureCurrent = operations.find(item => item.id === capture?.operationId)?.status === "succeeded";
    result.set(ticket.id, audienceTicketReceipt(show, ticket, { captureOwned, captureCurrent, refundIds, instructions }));
  }
  return result;
}
export function audienceReceiptSource(show: ShowSnapshot, receipts: ReadonlyMap<string, AudienceTicketReceipt>) {
  return digest({ source: audienceSourceDigest(show), receipts: [...receipts.values()].sort((left, right) => left.ticketId.localeCompare(right.ticketId)) });
}
export function audiencePassProof(context: AudienceContext, pass: PassRecord, progress: Progress, sourceDigest: string) {
  return createHmac("sha256", env.sessionSecret).update(JSON.stringify({ purpose: "audience-pass-read-v1", tenant: context.show.tenantId, session: context.authority.sessionHash, expiry: context.expiresAt, revision: context.revision, source: sourceDigest, pass: pass.id, progress })).digest("hex");
}
