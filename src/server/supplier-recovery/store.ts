import type { PoolClient } from "pg";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { latestSupplierDisruption } from "@/domain/disruptions";
import { digest } from "@/domain/hash";
import { supplierIds, type SupplierId } from "@/domain/supplier-contracts";
import { supplierRecoveryBasis, type SupplierDeclineCode, type SupplierTermsRecord } from "@/domain/supplier-recovery";
import { migrate, pool } from "../store";
import { openIntelligence, sealIntelligence } from "../intelligence/private-payload";
import type { RecoveryRfqRecord, SupplierRecoveryAuthority, SupplierRecoveryReceipt } from "./contracts";

export type Reader = Pick<PoolClient, "query">;
export interface RecoveryContext { db: PoolClient; show: ShowSnapshot; authority: SupplierRecoveryAuthority; expiresAt: string }
export async function requireSupplierRecoveryAuthority(db: Reader, authority: SupplierRecoveryAuthority, role: "any" | "producer" | "supplier" = "any", fixedExpiry?: string) {
  const { actor, sessionHash } = authority;
  const supplier = actor.roles.length === 1 && actor.roles[0] === "supplier" && supplierIds.includes(actor.supplierId as SupplierId) && !actor.personId && !actor.executionId;
  const operator = !actor.personId && !actor.executionId && !actor.supplierId && actor.roles.some(value => ["producer", "stage_manager"].includes(value));
  const allowed = role === "producer" ? operator && actor.roles.includes("producer") : role === "supplier" ? supplier : supplier || operator;
  if (!allowed) throw new DomainError("SUPPLIER_RECOVERY_ROLE", role === "supplier" ? "Only this enrolled supplier may publish its own terms." : "Use the current producer or this supplier's own access.", 403);
  // Preserve PostgreSQL microseconds when binding the original expiry. The pg
  // Date decoder truncates them, making a later exact comparison reject an
  // unchanged capability (or tempting callers to loosen that comparison).
  const row = (await db.query<{ expires_at: string }>(`SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at FROM on_sessions WHERE token_hash=$1 AND tenant_id=$2 AND actor=$3::jsonb AND expires_at>clock_timestamp() ${fixedExpiry ? "AND expires_at=$4::timestamptz" : ""} FOR SHARE`, [sessionHash, actor.tenantId, JSON.stringify(actor), ...(fixedExpiry ? [fixedExpiry] : [])])).rows[0];
  if (!row) throw new DomainError("SUPPLIER_RECOVERY_SESSION_ENDED", "This exact access ended or changed. Its original instructions remain retained; different access cannot adopt them.", 401);
  return row.expires_at;
}
export async function supplierRecoveryTransaction<T>(authority: SupplierRecoveryAuthority, mutate: boolean, work: (context: RecoveryContext) => Promise<T>) {
  await migrate(); const db = await pool.connect();
  try {
    await db.query("BEGIN"); const expiresAt = await requireSupplierRecoveryAuthority(db, authority);
    const row = (await db.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 " + (mutate ? "FOR UPDATE" : "FOR SHARE"), [authority.actor.tenantId])).rows[0];
    if (!row) throw new DomainError("SHOW_NOT_FOUND", "This production is not available.", 404);
    const result = await work({ db, authority, expiresAt, show: row.snapshot });
    await requireSupplierRecoveryAuthority(db, authority, "any", expiresAt); await db.query("COMMIT"); return result;
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
export async function saveSupplierTerms(db: Reader, record: SupplierTermsRecord) {
  await db.query("INSERT INTO on_supplier_terms(tenant_id,id,supplier_id,revision,digest,document_cipher) VALUES($1,$2,$3,$4,$5,$6)", [record.tenantId, record.id, record.supplierId, record.revision, digest(record), sealIntelligence(record.tenantId, `supplier-terms:${record.id}`, record)]);
}
export async function readSupplierTerms(db: Reader, tenantId: string, id: string) {
  const row = (await db.query<{ supplier_id: SupplierId; revision: number; digest: string; document_cipher: string }>("SELECT supplier_id,revision,digest,document_cipher FROM on_supplier_terms WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0];
  if (!row) throw new DomainError("SUPPLIER_TERMS_NOT_FOUND", "The original supplier terms are not in this production.", 404);
  const record = openIntelligence<SupplierTermsRecord>(tenantId, `supplier-terms:${id}`, row.document_cipher);
  if (record.id !== id || record.tenantId !== tenantId || record.supplierId !== row.supplier_id || record.revision !== row.revision || digest(record) !== row.digest) throw new DomainError("SUPPLIER_TERMS_INTEGRITY", "The original supplier source could not be verified.", 503);
  return { record, digest: row.digest };
}
export async function supplierTermsBlocker(db: Reader, show: ShowSnapshot, record: SupplierTermsRecord, recordDigest: string): Promise<{ code: SupplierDeclineCode; message: string } | null> {
  const latest = show.supplierTermRevisions?.find(item => item.supplierId === record.supplierId);
  if (!latest || latest.id !== record.id || latest.digest !== recordDigest) return { code: "TERMS_CHANGED", message: "The supplier has published a different current terms edition." };
  const now = (await db.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.getTime();
  if (Date.parse(record.validUntil) <= now || Date.parse(record.input.expiresAt) <= Date.parse(show.clock) || Date.parse(record.input.deliveryAt) < Date.parse(show.clock)) return { code: "TERMS_EXPIRED", message: "The supplier's real-time or scenario deadline passed. A fresh attributed edition is required." };
  const report = latestSupplierDisruption(show, record);
  if ((report?.id ?? null) !== record.input.sourceReportId || report?.earliestAt && Date.parse(record.input.deliveryAt) < Date.parse(report.earliestAt)) return { code: "TERMS_REPORT_CHANGED", message: "Availability changed after these terms. The supplier must review the current report and publish a new edition." };
  if (report?.availability === "unavailable") return { code: "UNIT_UNAVAILABLE", message: "The current attributed supplier report withdraws this unit." };
  try { await requireSupplierRecoveryAuthority(db, { actor: record.actor, sessionHash: record.sessionHash }, "supplier", record.sessionExpiresAt); }
  catch (error) { if (error instanceof DomainError && ["SUPPLIER_RECOVERY_SESSION_ENDED", "SUPPLIER_RECOVERY_ROLE"].includes(error.code)) return { code: "TERMS_ACCESS_ENDED", message: "The exact supplier access that issued these terms has ended or changed." }; throw error; }
  return null;
}
export async function supplierUnitCommitted(db: Reader, tenantId: string, supplierId: SupplierId, unitId: string, from: string, until: string) {
  return Boolean((await db.query("SELECT 1 FROM on_resource_holds WHERE tenant_id=$1 AND supplier_id=$2 AND unit_id=$3 AND window_start<$5::timestamptz AND window_end>$4::timestamptz AND (status='confirmed' OR (status='provisional' AND expires_at>clock_timestamp())) LIMIT 1", [tenantId, supplierId, unitId, from, until])).rowCount);
}
export async function saveRecoveryRfq(db: Reader, record: RecoveryRfqRecord) {
  await db.query("INSERT INTO on_supplier_recovery_rfqs(tenant_id,id,digest,document_cipher,expires_at) VALUES($1,$2,$3,$4,$5)", [record.tenantId, record.id, digest(record), sealIntelligence(record.tenantId, `supplier-recovery-rfq:${record.id}`, record), record.expiresAt]);
}
export async function readRecoveryRfq(db: Reader, tenantId: string, id: string): Promise<RecoveryRfqRecord | null> {
  const row = (await db.query<{ digest: string; document_cipher: string }>("SELECT digest,document_cipher FROM on_supplier_recovery_rfqs WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0];
  if (!row) return null;
  const record = openIntelligence<RecoveryRfqRecord>(tenantId, `supplier-recovery-rfq:${id}`, row.document_cipher);
  if (record.id !== id || record.tenantId !== tenantId || digest(record) !== row.digest) throw new DomainError("SUPPLIER_RFQ_INTEGRITY", "The producer's exact original quote request could not be verified.", 503);
  return record;
}
export async function requireRecoveryRfq(db: Reader, show: ShowSnapshot, record: RecoveryRfqRecord) {
  await requireSupplierRecoveryAuthority(db, { actor: record.actor, sessionHash: record.sessionHash }, "producer", record.sessionExpiresAt);
  const now = (await db.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.getTime();
  if (Date.parse(record.expiresAt) <= now) throw new DomainError("RFQ_APPROVAL_EXPIRED", "This original quote collection reached its fixed expiry. Review current facts for a separate request.");
  if (show.cancellationDecision?.mode === "cancel_show") throw new DomainError("PROGRAM_CANCELLED", "The cancelled program cannot be reopened by a supplier quote request.");
  if (show.revision !== record.expectedRevision || supplierRecoveryBasis(show) !== record.basisDigest) throw new DomainError("RFQ_PLAN_CHANGED", "The production, current supplier sources or retained obligations changed during collection. Original replies remain recorded.");
}
export async function supplierRecoveryReceipt(context: RecoveryContext, commandId: string, payloadHash?: string) {
  const row = (await context.db.query<{ actor_id: string; session_hash: string; payload_hash: string; receipt_cipher: string }>("SELECT actor_id,session_hash,payload_hash,receipt_cipher FROM on_supplier_recovery_commands WHERE tenant_id=$1 AND command_id=$2", [context.show.tenantId, commandId])).rows[0];
  if (!row || row.actor_id !== context.authority.actor.id || row.session_hash !== context.authority.sessionHash) {
    if (row && payloadHash) throw new DomainError("SUPPLIER_RECOVERY_COMMAND_OWNER", "This command identity belongs to a different exact session.", 403);
    return null;
  }
  if (payloadHash && row.payload_hash !== payloadHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This original command has different reviewed content.");
  return openIntelligence<SupplierRecoveryReceipt>(context.show.tenantId, `supplier-recovery-command:${commandId}`, row.receipt_cipher);
}
export async function saveSupplierRecoveryReceipt(context: RecoveryContext, receipt: SupplierRecoveryReceipt) {
  await context.db.query("INSERT INTO on_supplier_recovery_commands(tenant_id,command_id,actor_id,session_hash,payload_hash,receipt_cipher) VALUES($1,$2,$3,$4,$5,$6)", [context.show.tenantId, receipt.commandId, context.authority.actor.id, context.authority.sessionHash, receipt.requestDigest, sealIntelligence(context.show.tenantId, `supplier-recovery-command:${receipt.commandId}`, receipt)]);
}
