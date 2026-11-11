import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { WrapContext, WrapRecord, WrapState } from "@/domain/wrap/contracts";
import { openIntelligence, sealIntelligence } from "../intelligence/private-payload";
import { migrate, pool } from "../store";
import { assertSettlementAuthority, type SettlementAuthority } from "../settlement/service";

type Payload<T> = T extends WrapContext ? Omit<T, keyof WrapContext> : never;
export type WrapPayload = Payload<WrapRecord>;
type Row = { id: string; command_id: string; kind: WrapRecord["kind"]; revision: number; production_revision: number; actor_id: string | null; session_hash: string | null; request_hash: string; request_cipher: string; record_cipher: string; record_digest: string; recorded_at: Date };
export const wrapContext = (id: string, part: string) => `wrap:v1:${id}:${part}`;
export const wrapRequestHash = (authority: SettlementAuthority | undefined, request: unknown) => digest({ scope: authority ? "wrap:producer" : "wrap:worker", actorId: authority?.actor.id ?? null, sessionHash: authority?.sessionHash ?? null, request });
export async function wrapTransaction<T>(work: (db: PoolClient) => Promise<T>) { await migrate(); const db = await pool.connect(); try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); } }
export async function wrapShow(db: PoolClient, tenantId: string, write = false): Promise<ShowSnapshot> { const show = (await db.query<{ snapshot: ShowSnapshot }>(`SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR ${write ? "UPDATE" : "SHARE"}`, [tenantId])).rows[0]?.snapshot; if (!show) throw new DomainError("SHOW_NOT_FOUND", "This production is unavailable.", 404); return show; }
export async function assertWrapAuthority(db: PoolClient, authority: SettlementAuthority, show: ShowSnapshot) { if (authority.scope !== "production" || authority.actor.tenantId !== show.tenantId || !authority.actor.roles.includes("producer")) throw new DomainError("WRAP_SCOPE_DENIED", "The current producer access is required for this private account.", 403); await assertSettlementAuthority(db, authority, show); }
export async function readWrapState(db: PoolClient, show: ShowSnapshot): Promise<WrapState> {
  const revision = (await db.query<{ revision: number }>("SELECT revision FROM on_wrap_state WHERE tenant_id=$1", [show.tenantId])).rows[0]?.revision ?? 0, rows = (await db.query<Row>("SELECT * FROM on_wrap_records WHERE tenant_id=$1 ORDER BY revision LIMIT 16001", [show.tenantId])).rows;
  if (revision !== (show.wrapVersion ?? 0) || revision !== rows.length || rows.length > 16000) throw new DomainError("WRAP_INTEGRITY", "The original account history cannot be verified. New financial instructions are held.", 503);
  const records = rows.map((row, index) => {
    const record = openIntelligence<WrapRecord>(show.tenantId, wrapContext(row.id, "record"), row.record_cipher), request = openIntelligence<unknown>(show.tenantId, wrapContext(row.id, "request"), row.request_cipher), hash = digest({ scope: row.actor_id ? "wrap:producer" : "wrap:worker", actorId: row.actor_id, sessionHash: row.session_hash, request });
    if (row.revision !== index + 1 || row.record_digest !== digest(record) || row.request_hash !== hash || record.requestDigest !== digest(request) || record.id !== row.id || record.commandId !== row.command_id || record.kind !== row.kind || record.actorId !== row.actor_id || record.revision !== row.revision || record.productionRevision !== row.production_revision || record.recordedAt !== row.recorded_at.toISOString()) throw new DomainError("WRAP_INTEGRITY", "An original instruction, entry or observation cannot be verified. Its history is held.", 503);
    return record;
  }); return { schemaVersion: 1, revision, records };
}
export async function appendWrapRecord(db: PoolClient, show: ShowSnapshot, state: WrapState, payload: WrapPayload, options: { request: unknown; authority?: SettlementAuthority; commandId?: string; id?: string; semanticKey?: string; registerCommand?: boolean }) {
  if (state.records.length >= 16000) throw new DomainError("WRAP_HISTORY_LIMIT", "This production has reached its retained history bound. Its complete account must be reviewed before accepting further work.", 409);
  const id = options.id ?? randomUUID(), commandId = options.commandId ?? randomUUID(), now = new Date().toISOString(), actorId = options.authority?.actor.id ?? null, sessionHash = options.authority?.sessionHash ?? null, hash = wrapRequestHash(options.authority, options.request);
  const record = { ...payload, id, commandId, actorId, requestDigest: digest(options.request), revision: state.revision + 1, productionRevision: show.revision + 1, recordedAt: now } as WrapRecord, requestCipher = sealIntelligence(show.tenantId, wrapContext(id, "request"), options.request), recordCipher = sealIntelligence(show.tenantId, wrapContext(id, "record"), record);
  if (requestCipher.length > 1_000_000 || recordCipher.length > 4_000_000) throw new DomainError("WRAP_RECORD_LIMIT", "The complete evidence exceeds this bounded record. No partial record is accepted.", 413);
  await db.query("INSERT INTO on_wrap_state(tenant_id,revision) VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET revision=EXCLUDED.revision,updated_at=clock_timestamp()", [show.tenantId, record.revision]);
  await db.query("INSERT INTO on_wrap_records(id,tenant_id,command_id,kind,semantic_key,revision,production_revision,actor_id,session_hash,request_hash,request_cipher,record_cipher,record_digest,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [id, show.tenantId, commandId, record.kind, options.semanticKey ?? id, record.revision, record.productionRevision, actorId, sessionHash, hash, requestCipher, recordCipher, digest(record), now]);
  const event = { id: randomUUID(), type: `wrap.${record.kind}`, message: record.kind === "report_sealed" ? "An immutable account edition and its complete exports were sealed." : "The private production account retained an attributed entry, instruction or observation.", at: now, fixtureAt: show.clock, actorId: actorId ?? "system", source: "sample" as const, revision: record.productionRevision }, next = { ...show, revision: record.productionRevision, wrapVersion: record.revision, updatedAt: now, events: [...show.events, event] };
  await db.query("UPDATE on_shows SET snapshot=$2,revision=$3,updated_at=clock_timestamp() WHERE tenant_id=$1", [show.tenantId, next, next.revision]); await db.query("INSERT INTO on_events(id,tenant_id,revision,event) VALUES($1,$2,$3,$4)", [event.id, show.tenantId, next.revision, event]);
  if (options.authority && options.registerCommand !== false) await db.query("INSERT INTO on_commands(tenant_id,command_id,payload_hash,result_revision) VALUES($1,$2,$3,$4)", [show.tenantId, commandId, hash, next.revision]);
  return { show: next, state: { schemaVersion: 1 as const, revision: record.revision, records: [...state.records, record] }, record };
}
export async function bindInvoiceResource(db: PoolClient, spec: { merchant: string; kind: "invoice" | "invoice_payment" | "invoice_refund"; providerId: string; tenantId: string; invoiceId: string }) {
  await db.query("INSERT INTO on_wrap_bindings(merchant_fingerprint,kind,provider_id,tenant_id,invoice_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [spec.merchant, spec.kind, spec.providerId, spec.tenantId, spec.invoiceId]);
  const row = (await db.query<{ tenant_id: string; invoice_id: string }>("SELECT tenant_id,invoice_id FROM on_wrap_bindings WHERE merchant_fingerprint=$1 AND kind=$2 AND provider_id=$3", [spec.merchant, spec.kind, spec.providerId])).rows[0];
  if (row?.tenant_id !== spec.tenantId || row.invoice_id !== spec.invoiceId) throw new DomainError("INVOICE_OWNERSHIP_CONFLICT", "The original provider identity is already retained under another invoice. It cannot be counted or reused here.", 409);
}
