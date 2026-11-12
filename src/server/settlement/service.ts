import { randomUUID } from "node:crypto";
import { controlledPresentation } from "../judge/presentation";
import type { PoolClient } from "pg";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import { requireCrewPerson } from "@/domain/crew/policy";
import { digest } from "@/domain/hash";
import { applySettlementCommand, personSettlement, requireSettlementProducer, settlementDays, settlementReceipt } from "@/domain/settlement/commands";
import { settlementEnvelopeSchema, type PersonalSettlementData, type ProductionSettlementData, type SettlementCommandResponse, type SettlementData, type SettlementEnvelope, type SettlementRecord, type SettlementState, type SettlementViewContext } from "@/domain/settlement/contracts";
import { env } from "../env";
import { openIntelligence, sealIntelligence } from "../intelligence/private-payload";
import { migrate, pool } from "../store";

export interface SettlementAuthority { actor: Actor; sessionHash: string; scope: "personal" | "production" }
interface RecordRow { id: string; command_id: string; request_hash: string; request_cipher: string; revision: number; production_revision: number; actor_id: string; session_hash: string; person_id: string; kind: SettlementRecord["kind"]; record_cipher: string; record_digest: string; recorded_at: Date }
const privateContext = (id: string, part: "request" | "record") => `settlement:v1:${id}:${part}`;
export async function assertSettlementAuthority(db: PoolClient, authority: SettlementAuthority, show: ShowSnapshot) {
  if (authority.scope === "personal") requireCrewPerson(show, authority.actor); else requireSettlementProducer(authority.actor);
  const valid = await db.query("SELECT token_hash FROM on_sessions WHERE token_hash=$1 AND tenant_id=$2 AND actor=$3::jsonb AND expires_at>clock_timestamp() FOR SHARE", [authority.sessionHash, show.tenantId, JSON.stringify(authority.actor)]);
  if (!valid.rowCount) throw new DomainError("SETTLEMENT_SESSION_ENDED", "This exact session has ended. Open your current personal or production access.", 401);
}
async function withSettlement<T>(fn: (db: PoolClient) => Promise<T>) {
  await migrate(); const db = await pool.connect();
  try { await db.query("BEGIN"); const result = await fn(db); await db.query("COMMIT"); return result; }
  catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
async function lockedShow(db: PoolClient, tenantId: string, write: boolean): Promise<ShowSnapshot> {
  const row = (await db.query<{ snapshot: ShowSnapshot }>(`SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR ${write ? "UPDATE" : "SHARE"}`, [tenantId])).rows[0];
  if (!row) throw new DomainError("SHOW_NOT_FOUND", "This production is no longer available.", 404);
  return row.snapshot;
}
export async function readState(db: PoolClient, show: ShowSnapshot): Promise<SettlementState> {
  const saved = (await db.query<{ revision: number }>("SELECT revision FROM on_settlement_state WHERE tenant_id=$1", [show.tenantId])).rows[0];
  const rows = (await db.query<RecordRow>("SELECT * FROM on_settlement_records WHERE tenant_id=$1 ORDER BY revision LIMIT 4001", [show.tenantId])).rows;
  const revision = saved?.revision ?? 0;
  if (revision !== (show.settlementVersion ?? 0) || revision !== rows.length || rows.length > 4000) throw new DomainError("SETTLEMENT_INTEGRITY", "The retained settlement history cannot be verified. It is held for review.", 503);
  const records = rows.map((row, index) => {
    const record = openIntelligence<SettlementRecord>(show.tenantId, privateContext(row.id, "record"), row.record_cipher);
    const envelope = openIntelligence<SettlementEnvelope>(show.tenantId, privateContext(row.id, "request"), row.request_cipher);
    const requestHash = digest({ actorId: row.actor_id, sessionHash: row.session_hash, scope: row.kind === "time_report" ? "personal" : "production", envelope });
    if (row.revision !== index + 1 || digest(record) !== row.record_digest || requestHash !== row.request_hash || digest(envelope) !== record.requestDigest || record.id !== row.id || record.commandId !== row.command_id || record.personId !== row.person_id || record.actorId !== row.actor_id || record.revision !== row.revision || record.productionRevision !== row.production_revision || record.kind !== row.kind || record.recordedAt !== row.recorded_at.toISOString()) throw new DomainError("SETTLEMENT_INTEGRITY", "A retained settlement receipt cannot be verified. No new approval can proceed.", 503);
    return record;
  });
  return { schemaVersion: 1, revision, records };
}
function view(show: ShowSnapshot, state: SettlementState, authority: SettlementAuthority): SettlementData {
  const sheet = show.sheets.at(-1);
  const context: SettlementViewContext = { schemaVersion: 1, actorId: authority.actor.id, revision: state.revision, productionRevision: show.revision, serverAt: new Date().toISOString(), production: { title: show.title, showDate: show.showDate, zone: show.zone, clock: show.clock, allowedDays: settlementDays(show), sheet: sheet ? { version: sheet.version, digest: sheet.digest } : null }, controlledQa: controlledPresentation(show), paymentCapability: "separate_payout_review_required", receipts: [] };
  if (authority.scope === "personal") {
    const person = requireCrewPerson(show, authority.actor);
    context.receipts = state.records.filter(record => record.personId === person.id).map(settlementReceipt);
    // Build an explicit personal DTO. The complete state and producer roster are never serialized here.
    return { ...context, scope: "personal", personal: personSettlement(show, state, person.id) } satisfies PersonalSettlementData;
  }
  const people = show.resources.filter(person => person.kind === "person").map(person => personSettlement(show, state, person.id));
  context.receipts = state.records.map(settlementReceipt);
  return { ...context, scope: "production", tenantId: show.tenantId, people, totals: { reportedMinutes: people.flatMap(person => person.reports).filter(item => item.current).reduce((sum, item) => sum + item.report.minutes, 0), pendingReports: people.reduce((sum, person) => sum + person.pendingReports, 0), approvedBalanceMinor: people.reduce((sum, person) => sum + person.approvedBalanceMinor, 0), creditAdjustments: people.reduce((sum, person) => sum + person.creditAdjustments, 0) } } satisfies ProductionSettlementData;
}
export async function readSettlement(authority: SettlementAuthority): Promise<SettlementData> {
  return withSettlement(async db => { const show = await lockedShow(db, authority.actor.tenantId, false); await assertSettlementAuthority(db, authority, show); return view(show, await readState(db, show), authority); });
}
export async function executeSettlement(authority: SettlementAuthority, raw: SettlementEnvelope): Promise<SettlementCommandResponse> {
  const envelope = settlementEnvelopeSchema.parse(raw), requestHash = digest({ actorId: authority.actor.id, sessionHash: authority.sessionHash, scope: authority.scope, envelope });
  if (authority.scope === "personal" && envelope.command.type !== "report_time" || authority.scope === "production" && envelope.command.type === "report_time") throw new DomainError("SETTLEMENT_SCOPE_DENIED", "This action needs its assigned personal or producer capability.", 403);
  return withSettlement(async db => {
    const show = await lockedShow(db, authority.actor.tenantId, true); await assertSettlementAuthority(db, authority, show);
    const state = await readState(db, show), tenant = show.tenantId;
    const previous = (await db.query<{ payload_hash: string }>("SELECT payload_hash FROM on_commands WHERE tenant_id=$1 AND command_id=$2", [tenant, envelope.idempotencyKey])).rows[0];
    if (previous) {
      if (previous.payload_hash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This saved request identity belongs to different instructions or access. Check its retained receipt before another action.");
      const record = state.records.find(item => item.commandId === envelope.idempotencyKey);
      if (!record) throw new DomainError("SETTLEMENT_RECEIPT_UNAVAILABLE", "The original command was retained, but its settlement receipt cannot be verified. No replacement has been created.", 503);
      return { data: view(show, state, authority), receipt: settlementReceipt(record), replayed: true };
    }
    if (envelope.expectedRevision !== state.revision || envelope.expectedShowRevision !== show.revision) throw new DomainError("SETTLEMENT_REVIEW_STALE", "The production or settlement history changed. Refresh and review the current hours, rate and balance.");
    const id = randomUUID(), now = new Date().toISOString(), nextRevision = show.revision + 1;
    const applied = applySettlementCommand(show, authority.actor, state, envelope.command, { id, commandId: envelope.idempotencyKey, requestDigest: digest(envelope), actorId: authority.actor.id, recordedAt: now, revision: state.revision + 1, productionRevision: nextRevision });
    const requestCipher = sealIntelligence(tenant, privateContext(id, "request"), envelope), recordCipher = sealIntelligence(tenant, privateContext(id, "record"), applied.record);
    if (recordCipher.length > 256000) throw new DomainError("SETTLEMENT_RECORD_SIZE", "The reference calls exceed this report’s retained evidence limit. Review the production’s call scope.", 413);
    await db.query("INSERT INTO on_settlement_state(tenant_id,revision) VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET revision=EXCLUDED.revision,updated_at=clock_timestamp()", [tenant, applied.state.revision]);
    await db.query("INSERT INTO on_settlement_records(id,tenant_id,command_id,request_hash,request_cipher,revision,production_revision,actor_id,session_hash,person_id,kind,record_cipher,record_digest,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [id, tenant, envelope.idempotencyKey, requestHash, requestCipher, applied.state.revision, nextRevision, authority.actor.id, authority.sessionHash, applied.record.personId, applied.record.kind, recordCipher, digest(applied.record), now]);
    const labels = { time_report: "A personal crew time report was retained for review.", rate: "The producer recorded a versioned crew rate agreement.", payable: "The producer approved an exact reported-work liability; payment remains separate.", changes_requested: "The producer requested a corrected personal time report." };
    const event = { id: randomUUID(), type: "settlement." + applied.record.kind, message: labels[applied.record.kind], at: now, fixtureAt: show.clock, actorId: authority.actor.id, source: "sample" as const, revision: nextRevision };
    const next = { ...show, revision: nextRevision, settlementVersion: applied.state.revision, updatedAt: now, events: [...show.events, event] };
    await db.query("UPDATE on_shows SET snapshot=$2,revision=$3,updated_at=clock_timestamp() WHERE tenant_id=$1", [tenant, next, nextRevision]);
    await db.query("INSERT INTO on_commands(tenant_id,command_id,payload_hash,result_revision) VALUES($1,$2,$3,$4)", [tenant, envelope.idempotencyKey, requestHash, nextRevision]);
    await db.query("INSERT INTO on_events(id,tenant_id,revision,event) VALUES($1,$2,$3,$4)", [event.id, tenant, nextRevision, event]);
    return { data: view(next, applied.state, authority), receipt: settlementReceipt(applied.record), replayed: false };
  });
}
