import type { PoolClient } from "pg";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { supplierIds } from "@/domain/supplier-contracts";
import { migrate, pool } from "../store";
import { openIntelligence, sealIntelligence } from "../intelligence/private-payload";
import type { CloseoutAuthority, CloseoutProgress, CloseoutReceipt, RentalCloseoutGrant, RentalReturnRecord } from "./contracts";
export type Reader = Pick<PoolClient, "query">;
export interface CloseoutContext { db: PoolClient; authority: CloseoutAuthority; show: ShowSnapshot; expiresAt: string }
export function closeoutAccess(authority: CloseoutAuthority) {
  const { actor } = authority;
  if (actor.personId || actor.executionId) return null;
  if (actor.roles.length === 1 && actor.roles[0] === "supplier" && actor.supplierId && supplierIds.includes(actor.supplierId)) return "supplier" as const;
  if (actor.supplierId) return null;
  if (actor.roles.includes("producer")) return "producer" as const;
  return actor.roles.includes("stage_manager") ? "operator" as const : null;
}
export async function requireCloseoutAuthority(db: Reader, authority: CloseoutAuthority, role?: "producer" | "supplier") {
  const access = closeoutAccess(authority);
  if (!access || role && access !== role) throw new DomainError("RENTAL_CLOSEOUT_ROLE", role === "supplier" ? "Only this unit's own supplier can record its return inspection." : role === "producer" ? "The producer must separately review this original hold closure." : "Use the current producer, stage manager or own supplier capability.", 403);
  const row = (await db.query<{ expires_at: Date }>("SELECT expires_at FROM on_sessions WHERE token_hash=$1 AND tenant_id=$2 AND actor=$3::jsonb AND expires_at>clock_timestamp() FOR SHARE", [authority.sessionHash, authority.actor.tenantId, JSON.stringify(authority.actor)])).rows[0];
  if (!row) throw new DomainError("RENTAL_CLOSEOUT_SESSION_ENDED", "This exact capability expired or was revoked. Its original records remain retained.", 401);
  return row.expires_at.toISOString();
}
export async function closeoutTransaction<T>(authority: CloseoutAuthority, mutate: boolean, work: (context: CloseoutContext) => Promise<T>) {
  await migrate(); const db = await pool.connect();
  try {
    await db.query("BEGIN"); const expiresAt = await requireCloseoutAuthority(db, authority);
    const row = (await db.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 " + (mutate ? "FOR UPDATE" : "FOR SHARE"), [authority.actor.tenantId])).rows[0];
    if (!row) throw new DomainError("SHOW_NOT_FOUND", "This production is unavailable.", 404);
    const result = await work({ db, authority, expiresAt, show: row.snapshot });
    await requireCloseoutAuthority(db, authority); await db.query("COMMIT"); return result;
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
export async function readReturn(tenantId: string, id: string, db: Reader = pool) {
  const row = (await db.query<{ execution_id: string; previous_id: string | null; digest: string; document_cipher: string }>("SELECT execution_id,previous_id,digest,document_cipher FROM on_rental_return_records WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0];
  if (!row) throw new DomainError("RENTAL_RETURN_NOT_FOUND", "This return record is outside the original production.", 404);
  const value = openIntelligence<RentalReturnRecord>(tenantId, `rental-return:${id}`, row.document_cipher);
  if (value.id !== id || value.tenantId !== tenantId || value.executionId !== row.execution_id || value.previousInspectionId !== row.previous_id || digest(value) !== row.digest) throw new DomainError("RENTAL_RETURN_INTEGRITY", "The original return record could not be verified.", 503);
  return value;
}
export async function saveReturn(db: Reader, record: RentalReturnRecord) {
  await db.query("INSERT INTO on_rental_return_records(tenant_id,id,execution_id,previous_id,digest,document_cipher) VALUES($1,$2,$3,$4,$5,$6)", [record.tenantId, record.id, record.executionId, record.previousInspectionId, digest(record), sealIntelligence(record.tenantId, `rental-return:${record.id}`, record)]);
}
export async function readCloseoutGrant(tenantId: string, id: string, db: Reader = pool) {
  const row = (await db.query<{ execution_id: string; root_intent_id: string; return_id: string; digest: string; document_cipher: string; intent_id: string | null; last_code: string | null; dispatch_authorized_at: Date | null; stopped_at: Date | null }>("SELECT g.*,p.intent_id,p.last_code,p.dispatch_authorized_at,s.stopped_at FROM on_rental_closeout_grants g JOIN on_rental_closeout_progress p ON p.tenant_id=g.tenant_id AND p.grant_id=g.id LEFT JOIN on_rental_closeout_stops s ON s.tenant_id=g.tenant_id AND s.grant_id=g.id WHERE g.tenant_id=$1 AND g.id=$2", [tenantId, id])).rows[0];
  if (!row) throw new DomainError("RENTAL_CLOSEOUT_NOT_FOUND", "This original hold-closure approval is outside the production.", 404);
  const grant = openIntelligence<RentalCloseoutGrant>(tenantId, `rental-closeout:${id}`, row.document_cipher);
  if (grant.id !== id || grant.tenantId !== tenantId || grant.executionId !== row.execution_id || grant.rootIntentId !== row.root_intent_id || grant.returnId !== row.return_id || digest(grant) !== row.digest) throw new DomainError("RENTAL_CLOSEOUT_INTEGRITY", "The original hold-closure review could not be verified.", 503);
  const progress: CloseoutProgress = { intentId: row.intent_id, lastCode: row.last_code, dispatchAuthorizedAt: row.dispatch_authorized_at?.toISOString() ?? null };
  return { grant, progress, stoppedAt: row.stopped_at?.toISOString() ?? null };
}
export async function saveCloseoutGrant(db: Reader, grant: RentalCloseoutGrant) {
  await db.query("INSERT INTO on_rental_closeout_grants(tenant_id,id,execution_id,root_intent_id,return_id,digest,document_cipher) VALUES($1,$2,$3,$4,$5,$6,$7)", [grant.tenantId, grant.id, grant.executionId, grant.rootIntentId, grant.returnId, digest(grant), sealIntelligence(grant.tenantId, `rental-closeout:${grant.id}`, grant)]);
  await db.query("INSERT INTO on_rental_closeout_progress(tenant_id,grant_id) VALUES($1,$2)", [grant.tenantId, grant.id]);
}
export async function closeoutOriginalReceipt(context: CloseoutContext, commandId: string, payloadHash?: string) {
  const row = (await context.db.query<{ actor_id: string; session_hash: string; payload_hash: string; receipt_cipher: string }>("SELECT actor_id,session_hash,payload_hash,receipt_cipher FROM on_rental_closeout_commands WHERE tenant_id=$1 AND command_id=$2", [context.show.tenantId, commandId])).rows[0];
  if (!row || row.actor_id !== context.authority.actor.id || row.session_hash !== context.authority.sessionHash) {
    if (row && payloadHash) throw new DomainError("RENTAL_CLOSEOUT_COMMAND_OWNER", "This command belongs to a different exact capability.", 403);
    return null;
  }
  if (payloadHash && payloadHash !== row.payload_hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This original instruction already has different terms.");
  return openIntelligence<CloseoutReceipt>(context.show.tenantId, `rental-closeout-command:${commandId}`, row.receipt_cipher);
}
export async function saveCloseoutReceipt(context: CloseoutContext, receipt: CloseoutReceipt) {
  await context.db.query("INSERT INTO on_rental_closeout_commands(tenant_id,command_id,actor_id,session_hash,payload_hash,receipt_cipher) VALUES($1,$2,$3,$4,$5,$6)", [context.show.tenantId, receipt.commandId, context.authority.actor.id, context.authority.sessionHash, receipt.requestDigest, sealIntelligence(context.show.tenantId, `rental-closeout-command:${receipt.commandId}`, receipt)]);
}
