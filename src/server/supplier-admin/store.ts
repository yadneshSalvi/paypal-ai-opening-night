import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { managedSupplierIdSchema } from "@/domain/supplier-admin/commands";
import type { AdminAccess, AdminAuthority, AdminKind, AdminReceipt, AdminRecord, Enrollment, InventoryEdition, ManagedSupplierId, Revocation, SupplierKey, TermEdition } from "@/domain/supplier-admin/contracts";
import { pool, migrate } from "../store";
import { openIntelligence, sealIntelligence } from "../intelligence/private-payload";

export type AdminReader = Pick<PoolClient, "query">;
export interface AdminContext { db: PoolClient; show: ShowSnapshot; authority: AdminAuthority; expiresAt: string; now: string; records: AdminRecord[] }
export const adminFingerprint = (sessionHash: string) => digest({ purpose: "supplier-admin-client-v1", sessionHash });
export async function requireAdminAuthority(db: AdminReader, authority: AdminAuthority, fixedExpiry?: string, role: "either" | "producer" | "supplier" = "either") {
  const { actor } = authority;
  const producer = !actor.personId && !actor.executionId && !actor.supplierId && actor.roles.includes("producer");
  const supplier = !actor.personId && !actor.executionId && actor.roles.length === 1 && actor.roles[0] === "supplier" && managedSupplierIdSchema.safeParse(actor.supplierId).success;
  if (!(role === "producer" ? producer : role === "supplier" ? supplier : producer || supplier)) throw new DomainError("SUPPLIER_ADMIN_ROLE", role === "supplier" ? "Use this admitted supplier's own access." : "Use the current producer or the supplier's separate access.", 403);
  const row = (await db.query<{ expires_at: string }>(`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
    FROM on_sessions WHERE token_hash=$1 AND tenant_id=$2 AND actor=$3::jsonb AND expires_at>clock_timestamp()
    ${fixedExpiry ? "AND expires_at=$4::timestamptz" : ""} FOR SHARE`, [authority.sessionHash, actor.tenantId, JSON.stringify(actor), ...(fixedExpiry ? [fixedExpiry] : [])])).rows[0];
  if (!row) throw new DomainError("SUPPLIER_ADMIN_ACCESS_ENDED", "This exact access ended or changed. Its saved instructions cannot adopt different access or a later expiry.", 401);
  return row.expires_at;
}
export async function readAdminRecords(db: AdminReader, tenantId: string): Promise<AdminRecord[]> {
  const rows = (await db.query<{ id: string; supplier_id: ManagedSupplierId; kind: AdminKind; revision: number; digest: string; document_cipher: string }>("SELECT id,supplier_id,kind,revision,digest,document_cipher FROM on_supplier_admin_records WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 4097", [tenantId])).rows;
  if (rows.length > 4096) throw new DomainError("SUPPLIER_ADMIN_HISTORY_LIMIT", "This production's retained supplier history needs an operator export before adding more instructions.", 409);
  return rows.map(row => {
    const record = openIntelligence<AdminRecord>(tenantId, `supplier-admin:${row.id}`, row.document_cipher);
    if (record.id !== row.id || record.tenantId !== tenantId || record.supplierId !== row.supplier_id || record.kind !== row.kind || record.revision !== row.revision || digest(record) !== row.digest) throw new DomainError("SUPPLIER_ADMIN_INTEGRITY", "The original supplier source could not be verified.", 503);
    return record;
  });
}
export async function adminTransaction<T>(authority: AdminAuthority, mutate: boolean, work: (context: AdminContext) => Promise<T>) {
  await migrate(); const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const row = (await db.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 " + (mutate ? "FOR UPDATE" : "FOR SHARE"), [authority.actor.tenantId])).rows[0];
    if (!row) throw new DomainError("SHOW_NOT_FOUND", "This production is not available.", 404);
    const expiresAt = await requireAdminAuthority(db, authority);
    const now = (await db.query<{ now: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS now")).rows[0]!.now;
    const result = await work({ db, show: row.snapshot, authority, expiresAt, now, records: await readAdminRecords(db, authority.actor.tenantId) });
    await requireAdminAuthority(db, authority, expiresAt); await db.query("COMMIT"); return result;
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
export function ownSupplier(context: AdminContext, supplierId: ManagedSupplierId) {
  const actor = context.authority.actor;
  if (actor.supplierId !== supplierId || actor.roles.length !== 1 || actor.roles[0] !== "supplier") throw new DomainError("SUPPLIER_ADMIN_SCOPE", "Only this supplier's own admitted access can change its inventory, keys or terms.", 403);
}
export function recordById<T>(records: AdminRecord[], id: string, kind: AdminKind, supplierId?: ManagedSupplierId): AdminRecord<T> {
  const record = records.find(value => value.id === id && value.kind === kind && (!supplierId || value.supplierId === supplierId));
  if (!record) throw new DomainError("SUPPLIER_ADMIN_SOURCE_NOT_FOUND", "The exact original supplier source is outside this scope.", 404);
  return record as AdminRecord<T>;
}
export function latestRecord<T>(records: AdminRecord[], supplierId: ManagedSupplierId, kind: AdminKind, predicate?: (record: AdminRecord<T>) => boolean): AdminRecord<T> | null {
  return records.filter(value => value.supplierId === supplierId && value.kind === kind).sort((a, b) => b.revision - a.revision).find(value => !predicate || predicate(value as AdminRecord<T>)) as AdminRecord<T> | undefined ?? null;
}
export function revoked(records: AdminRecord[], id: string) { return records.some(value => value.kind === "revocation" && (value.data as Revocation).targetId === id); }
export function admitted(records: AdminRecord[], supplierId: ManagedSupplierId) {
  const record = latestRecord<Enrollment>(records, supplierId, "enrollment");
  if (!record || record.data.status !== "admitted" || revoked(records, record.id) || records.some(value => value.supplierId === supplierId && value.kind === "revocation" && (value.data as Revocation).targetKind === "enrollment")) throw new DomainError("SUPPLIER_NOT_ADMITTED", "This supplier is not currently admitted. Its historical replies and commitments remain retained.", 403);
  return record;
}
export function currentInventory(records: AdminRecord[], supplierId: ManagedSupplierId, unitId: string) { return latestRecord<InventoryEdition>(records, supplierId, "inventory", record => record.data.unitId === unitId); }
export function currentTerms(records: AdminRecord[], supplierId: ManagedSupplierId, unitId: string) {
  return latestRecord<TermEdition>(records, supplierId, "terms", record => recordById<InventoryEdition>(records, record.data.inventoryId, "inventory", supplierId).data.unitId === unitId);
}
export function currentKey(records: AdminRecord[], supplierId: ManagedSupplierId) {
  const key = latestRecord<SupplierKey>(records, supplierId, "key");
  if (!key || revoked(records, key.id)) throw new DomainError("SUPPLIER_KEY_REVOKED", "The supplier needs its own current signing key before issuing new replies.", 403);
  return key;
}
export async function appendAdminRecord<T>(context: AdminContext, supplierId: ManagedSupplierId, kind: AdminKind, data: T, id = randomUUID()): Promise<AdminRecord<T>> {
  const revision = Math.max(0, ...context.records.filter(value => value.supplierId === supplierId && value.kind === kind).map(value => value.revision)) + 1;
  const record: AdminRecord<T> = { id, tenantId: context.show.tenantId, supplierId, kind, revision, createdAt: context.now,
    access: { actor: context.authority.actor, sessionHash: context.authority.sessionHash, expiresAt: context.expiresAt }, data, provenance: "declared_controlled_supplier" };
  await context.db.query("INSERT INTO on_supplier_admin_records(tenant_id,id,supplier_id,kind,revision,digest,document_cipher) VALUES($1,$2,$3,$4,$5,$6,$7)", [record.tenantId, id, supplierId, kind, revision, digest(record), sealIntelligence(record.tenantId, `supplier-admin:${id}`, record)]);
  context.records.push(record); return record;
}
export async function accessCurrent(db: AdminReader, access: AdminAccess) { await requireAdminAuthority(db, { actor: access.actor, sessionHash: access.sessionHash }, access.expiresAt); }
export async function readAdminReceipt(context: AdminContext, commandId: string, payloadHash?: string): Promise<AdminReceipt | null> {
  const row = (await context.db.query<{ actor_id: string; session_hash: string; expiry: string; payload_hash: string; receipt_cipher: string }>(`SELECT actor_id,session_hash,to_char(session_expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expiry,payload_hash,receipt_cipher
    FROM on_supplier_admin_commands WHERE tenant_id=$1 AND command_id=$2`, [context.show.tenantId, commandId])).rows[0];
  if (!row) return null;
  if (row.actor_id !== context.authority.actor.id || row.session_hash !== context.authority.sessionHash || row.expiry !== context.expiresAt) {
    if (payloadHash) throw new DomainError("SUPPLIER_ADMIN_COMMAND_OWNER", "This command belongs to different exact access.", 403); return null;
  }
  if (payloadHash && row.payload_hash !== payloadHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This original command identity has different reviewed instructions.");
  return openIntelligence<AdminReceipt>(context.show.tenantId, `supplier-admin-command:${commandId}`, row.receipt_cipher);
}
export async function saveAdminReceipt(context: AdminContext, receipt: AdminReceipt) {
  await context.db.query("INSERT INTO on_supplier_admin_commands(tenant_id,command_id,actor_id,session_hash,session_expiry,payload_hash,receipt_cipher) VALUES($1,$2,$3,$4,$5,$6,$7)", [context.show.tenantId, receipt.commandId, context.authority.actor.id, context.authority.sessionHash, context.expiresAt, receipt.requestDigest, sealIntelligence(context.show.tenantId, `supplier-admin-command:${receipt.commandId}`, receipt)]);
}
