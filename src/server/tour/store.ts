import type { PoolClient } from "pg";
import type { Actor, ShowSnapshot } from "@/domain/contracts";
import { DomainError } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { PlanningAcknowledgment, TourReceipt, TourRecord, Tour } from "@/domain/tour/contracts";
import { recordDigest } from "@/domain/tour/templates";
import { migrate, pool } from "../store";
import { sealIntelligence, openIntelligence } from "../intelligence/private-payload";
export interface TourAuthority { actor: Actor; sessionHash: string }
export interface TourContext { db: PoolClient; authority: TourAuthority; expiresAt: string; root: ShowSnapshot }
export async function requireTourAuthority(db: PoolClient, authority: TourAuthority, personal = false) {
  const actor = authority.actor;
  const permitted = personal ? Boolean(actor.personId && actor.roles.length === 1 && actor.roles[0] === "crew") : !actor.personId && actor.roles.some(role => role === "producer" || role === "stage_manager");
  if (actor.executionId || actor.supplierId || !permitted) throw new DomainError("TOUR_ROLE_REQUIRED", personal ? "Use your own personal crew link." : "Use the current production operator session.", 403);
  const session = (await db.query<{ expires_at: Date }>("SELECT expires_at FROM on_sessions WHERE token_hash=$1 AND tenant_id=$2 AND actor=$3::jsonb AND expires_at>clock_timestamp() FOR SHARE", [authority.sessionHash, actor.tenantId, JSON.stringify(actor)])).rows[0];
  if (!session) throw new DomainError("TOUR_SESSION_ENDED", "This exact session expired or was revoked. Its saved planning history is retained.", 401);
  const root = (await db.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR SHARE", [actor.tenantId])).rows[0]?.snapshot;
  if (!root || personal && !root.resources.some(resource => resource.id === actor.personId && resource.kind === "person")) throw new DomainError("TOUR_PERSON_NOT_CURRENT", "This person is not in the current admitted roster.", 403);
  return { expiresAt: session.expires_at.toISOString(), root };
}
export async function tourTransaction<T>(authority: TourAuthority, personal: boolean, mutate: boolean, fn: (context: TourContext) => Promise<T>) {
  await migrate(); const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const access = await requireTourAuthority(db, authority, personal);
    if (mutate) await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,4548))", [authority.actor.tenantId]);
    const value = await fn({ db, authority, ...access });
    await requireTourAuthority(db, authority, personal);
    await db.query("COMMIT"); return value;
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
const recordContext = (id: string, revision: number) => `tour:${id}:edition:${revision}`;
export function decodeRecord(tenantId: string, row: { id?: string; record_id?: string; revision: number; digest: string; snapshot_cipher: string }): TourRecord {
  const record = openIntelligence<TourRecord>(tenantId, recordContext(row.id ?? row.record_id!, row.revision), row.snapshot_cipher);
  if (record.digest !== row.digest || recordDigest(record) !== row.digest) throw new DomainError("TOUR_EDITION_INTEGRITY", "The retained planning edition could not be verified.", 503);
  return record;
}
export async function records(db: PoolClient, tenant: string) { return (await db.query("SELECT * FROM on_tour_records WHERE tenant_id=$1 ORDER BY created_at,id", [tenant])).rows.map(row => decodeRecord(tenant, row)); }
export async function record<T extends TourRecord["kind"]>(db: PoolClient, tenant: string, id: string, kind: T): Promise<Extract<TourRecord, { kind: T }>> {
  const row = (await db.query("SELECT * FROM on_tour_records WHERE tenant_id=$1 AND id=$2 AND kind=$3 FOR UPDATE", [tenant, id, kind])).rows[0];
  if (!row) throw new DomainError("TOUR_RECORD_NOT_FOUND", "This planning record is not in your current production library.", 404);
  return decodeRecord(tenant, row) as Extract<TourRecord, { kind: T }>;
}
export function expected(record: TourRecord, revision: number) { if (record.revision !== revision) throw new DomainError("TOUR_STALE_REVISION", `This ${record.kind} is now edition ${record.revision}. Refresh and review that edition.`); }
export function active(record: TourRecord) { if (record.archived) throw new DomainError("TOUR_ARCHIVED", "This planning record is archived. Its history is available; restore it before making changes."); }
export async function saveRecord(db: PoolClient, tenant: string, value: TourRecord, commandId: string) {
  value.digest = recordDigest(value);
  const cipher = sealIntelligence(tenant, recordContext(value.id, value.revision), value);
  const existing = (await db.query<{ revision: number }>("SELECT revision FROM on_tour_records WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenant, value.id])).rows[0];
  if (existing && existing.revision + 1 !== value.revision || !existing && value.revision !== 1) throw new DomainError("TOUR_EDITION_SEQUENCE", "The next planning edition must extend its exact predecessor.");
  await db.query("INSERT INTO on_tour_records(tenant_id,id,kind,revision,digest,archived,snapshot_cipher) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,id) DO UPDATE SET revision=EXCLUDED.revision,digest=EXCLUDED.digest,archived=EXCLUDED.archived,snapshot_cipher=EXCLUDED.snapshot_cipher,updated_at=clock_timestamp()", [tenant, value.id, value.kind, value.revision, value.digest, value.archived, cipher]);
  await db.query("INSERT INTO on_tour_editions(tenant_id,record_id,revision,digest,snapshot_cipher,actor_id,command_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [tenant, value.id, value.revision, value.digest, cipher, value.actorId, commandId]);
  if ((value.kind === "template" || value.kind === "production") && value.compilerBinding) for (const source of value.compilerBinding.sources) await db.query("INSERT INTO on_tour_source_bindings(tenant_id,record_id,source_id,source_version,source_hash,compilation_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [tenant, value.id, source.id, source.version, source.hash, value.compilerBinding.id]);
}
export async function acknowledgments(db: PoolClient, tenantId: string): Promise<PlanningAcknowledgment[]> {
  return (await db.query("SELECT * FROM on_tour_acknowledgments WHERE tenant_id=$1 ORDER BY at,id", [tenantId])).rows.map(row => ({ id: row.id, personId: row.person_id, productionId: row.production_id, callId: row.call_id, obligationDigest: row.obligation_digest, actorId: row.actor_id, at: row.at.toISOString(), kind: "readback" }));
}
export async function sourceState(db: PoolClient, tenantId: string, values: TourRecord[]) {
  const bindings = values.flatMap(value => (value.kind === "template" || value.kind === "production") ? value.compilerBinding?.sources ?? [] : []);
  const states = [];
  let current = true;
  for (const binding of [...new Map(bindings.map(binding => [binding.id, binding])).values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const row = (await db.query("SELECT current,state,content_hash,extraction_digest,version FROM on_source_documents WHERE tenant_id=$1 AND id=$2 FOR SHARE", [tenantId, binding.id])).rows[0];
    const matches = Boolean(row?.current && row.state !== "deleted" && row.content_hash === binding.hash && row.extraction_digest === binding.extractionDigest && row.version === binding.version);
    current &&= matches; states.push({ binding, current: matches, row: row ?? null });
  }
  return { current, digest: digest(states) };
}
export async function commandReceipt(context: TourContext, commandId: string) {
  const row = (await context.db.query("SELECT * FROM on_tour_commands WHERE tenant_id=$1 AND command_id=$2", [context.authority.actor.tenantId, commandId])).rows[0];
  if (!row || row.actor_id !== context.authority.actor.id || row.session_hash !== context.authority.sessionHash) throw new DomainError("TOUR_COMMAND_NOT_FOUND", "This exact command is not recorded for your current session.", 404);
  return { row, receipt: openIntelligence<TourReceipt>(context.authority.actor.tenantId, `tour-command:${commandId}`, row.receipt_cipher) };
}
export const sealReceipt = (tenant: string, receipt: TourReceipt) => sealIntelligence(tenant, `tour-command:${receipt.commandId}`, receipt);
export const openReceipt = (tenant: string, id: string, cipher: string) => openIntelligence<TourReceipt>(tenant, `tour-command:${id}`, cipher);

export function currentRoster(context: TourContext, tour: Tour) {
  for (const resource of tour.resources) if (resource.personId) {
    const person = context.root.resources.find(value => value.kind === "person" && value.id === resource.personId);
    if (!person || resource.id !== person.id || resource.label !== person.name || digest([...resource.skills].sort()) !== digest([...person.skills].sort())) throw new DomainError("TOUR_ROSTER_CHANGED", "The admitted roster changed. Review the tour resource edition with current identities and qualifications before comparison, application or consent.");
  }
}
