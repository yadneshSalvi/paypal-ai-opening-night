import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { PayoutContext, PayoutRecord, PayoutState } from "@/domain/payouts/contracts";
import { sealIntelligence, openIntelligence } from "../intelligence/private-payload";
import { migrate, pool } from "../store";
import type { SettlementAuthority } from "../settlement/service";
import { projectPayoutEvidence } from "./projection";

type Payload<T> = T extends PayoutContext ? Omit<T, keyof PayoutContext> : never;
export type PayoutPayload = Payload<PayoutRecord>;
interface Row { id: string; command_id: string; kind: PayoutRecord["kind"]; semantic_key: string; revision: number; production_revision: number; actor_id: string | null; session_hash: string | null; request_hash: string; request_cipher: string; record_cipher: string; record_digest: string; recorded_at: Date }
const context = (id: string, part: string) => `payout:v1:${id}:${part}`;
export const payoutRequestHash = (actorId: string | null, sessionHash: string | null, request: unknown) => digest({ scope: actorId === null ? "payouts:worker" : "payouts:production", actorId, sessionHash, request });
export async function payoutTransaction<T>(work: (db: PoolClient) => Promise<T>) {
  await migrate(); const db = await pool.connect();
  try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
  catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
export async function payoutShow(db: PoolClient, tenantId: string, write = false): Promise<ShowSnapshot> {
  const show = (await db.query<{ snapshot: ShowSnapshot }>(`SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR ${write ? "UPDATE" : "SHARE"}`, [tenantId])).rows[0]?.snapshot;
  if (!show) throw new DomainError("SHOW_NOT_FOUND", "The production is no longer available.", 404); return show;
}
export async function readPayoutState(db: PoolClient, show: ShowSnapshot): Promise<PayoutState> {
  const cursor = (await db.query<{ revision: number }>("SELECT revision FROM on_payout_state WHERE tenant_id=$1", [show.tenantId])).rows[0]?.revision ?? 0;
  const rows = (await db.query<Row>("SELECT * FROM on_payout_records WHERE tenant_id=$1 ORDER BY revision LIMIT 8001", [show.tenantId])).rows;
  if (cursor !== (show.payoutVersion ?? 0) || cursor !== rows.length || rows.length > 8000) throw new DomainError("PAYOUT_INTEGRITY", "The retained payout history cannot be verified. New transfers are held.", 503);
  const records = rows.map((row, index) => {
    const record = openIntelligence<PayoutRecord>(show.tenantId, context(row.id, "record"), row.record_cipher), request = openIntelligence<unknown>(show.tenantId, context(row.id, "request"), row.request_cipher);
    if (row.revision !== index + 1 || row.record_digest !== digest(record) || row.request_hash !== payoutRequestHash(row.actor_id, row.session_hash, request) || record.requestDigest !== digest(request) || record.id !== row.id || record.commandId !== row.command_id || record.actorId !== row.actor_id || record.kind !== row.kind || record.revision !== row.revision || record.productionRevision !== row.production_revision || record.recordedAt !== row.recorded_at.toISOString()) throw new DomainError("PAYOUT_INTEGRITY", "An original payout instruction or receipt cannot be verified. It remains held.", 503);
    return record;
  });
  return { schemaVersion: 1, revision: cursor, records };
}
export async function appendPayoutRecord(db: PoolClient, show: ShowSnapshot, state: PayoutState, payload: PayoutPayload, options: { request: unknown; authority?: SettlementAuthority; commandId?: string; id?: string; semanticKey?: string }) {
  if (state.records.length >= 8000) throw new DomainError("PAYOUT_HISTORY_LIMIT", "This production's payout history needs export and review before more work is admitted.", 409);
  const id = options.id ?? randomUUID(), commandId = options.commandId ?? randomUUID(), actorId = options.authority?.actor.id ?? null, sessionHash = options.authority?.sessionHash ?? null, now = new Date().toISOString();
  const record = { ...payload, id, commandId, actorId, recordedAt: now, requestDigest: digest(options.request), revision: state.revision + 1, productionRevision: show.revision + 1 } as PayoutRecord;
  const requestHash = payoutRequestHash(actorId, sessionHash, options.request), requestCipher = sealIntelligence(show.tenantId, context(id, "request"), options.request), recordCipher = sealIntelligence(show.tenantId, context(id, "record"), record);
  if (requestCipher.length > 512000 || recordCipher.length > 512000) throw new DomainError("PAYOUT_RECORD_LIMIT", "The exact payout evidence exceeds this production's bounded record limit.", 413);
  await db.query("INSERT INTO on_payout_state(tenant_id,revision) VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET revision=EXCLUDED.revision,updated_at=clock_timestamp()", [show.tenantId, record.revision]);
  await db.query("INSERT INTO on_payout_records(id,tenant_id,command_id,kind,semantic_key,revision,production_revision,actor_id,session_hash,request_hash,request_cipher,record_cipher,record_digest,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [id, show.tenantId, commandId, record.kind, options.semanticKey ?? id, record.revision, record.productionRevision, actorId, sessionHash, requestHash, requestCipher, recordCipher, digest(record), now]);
  const nextState: PayoutState = { schemaVersion: 1, revision: record.revision, records: [...state.records, record] };
  const event = { id: randomUUID(), type: "payouts." + record.kind, message: record.kind === "grant" ? "The producer approved an exact crew payout instruction; provider item verification remains separate." : record.kind === "recipient" ? "The producer recorded an exact admitted recipient version." : "The original crew payout history was updated with an attributed instruction or observation.", at: now, fixtureAt: show.clock, actorId: actorId ?? "system", source: "result" in record ? record.result.source : "sample" as const, revision: record.productionRevision };
  const next = projectPayoutEvidence({ ...show, revision: record.productionRevision, payoutVersion: record.revision, updatedAt: now, events: [...show.events, event] }, nextState, record);
  await db.query("UPDATE on_shows SET snapshot=$2,revision=$3,updated_at=clock_timestamp() WHERE tenant_id=$1", [show.tenantId, next, next.revision]);
  await db.query("INSERT INTO on_events(id,tenant_id,revision,event) VALUES($1,$2,$3,$4)", [event.id, show.tenantId, next.revision, event]);
  if (options.authority) await db.query("INSERT INTO on_commands(tenant_id,command_id,payload_hash,result_revision) VALUES($1,$2,$3,$4)", [show.tenantId, commandId, requestHash, next.revision]);
  return { show: next, state: nextState, record };
}
export async function bindPayoutResource(db: PoolClient, spec: { merchant: string; kind: "batch" | "item"; providerId: string; tenantId: string; grantId: string; senderItemId?: string }) {
  await db.query("INSERT INTO on_payout_bindings(merchant_fingerprint,kind,provider_id,tenant_id,grant_id,sender_item_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [spec.merchant, spec.kind, spec.providerId, spec.tenantId, spec.grantId, spec.senderItemId ?? null]);
  const row = (await db.query<{ tenant_id: string; grant_id: string; sender_item_id: string | null }>("SELECT tenant_id,grant_id,sender_item_id FROM on_payout_bindings WHERE merchant_fingerprint=$1 AND kind=$2 AND provider_id=$3", [spec.merchant, spec.kind, spec.providerId])).rows[0];
  if (row?.tenant_id !== spec.tenantId || row.grant_id !== spec.grantId || row.sender_item_id !== (spec.senderItemId ?? null)) throw new DomainError("PAYOUT_OWNERSHIP_CONFLICT", "The provider resource is retained under a different original payout. This instruction remains held.", 409);
}
