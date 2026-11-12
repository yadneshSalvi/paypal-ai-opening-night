import type { PoolClient } from "pg";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { migrate, pool } from "../store";
import { openIntelligence, sealIntelligence } from "../intelligence/private-payload";
import type { CancellationRecord, DisruptionAuthority, DisruptionReceipt, EventRemedyAllocation, RemedyProgress } from "./contracts";
export type Reader = Pick<PoolClient, "query">;
export interface Context { db: PoolClient; authority: DisruptionAuthority; show: ShowSnapshot; expiresAt: string }

export async function requireDisruptionAuthority(db: Reader, authority: DisruptionAuthority, producer = false) {
  const { actor, sessionHash } = authority;
  const supplier = actor.roles.length === 1 && actor.roles[0] === "supplier" && Boolean(actor.supplierId);
  const operator = !actor.personId && !actor.executionId && !actor.supplierId && actor.roles.some(role => ["producer", "stage_manager"].includes(role));
  const permitted = producer ? operator && actor.roles.includes("producer") : !actor.personId && !actor.executionId && (supplier || operator);
  if (!permitted) throw new DomainError("DISRUPTION_ROLE_REQUIRED", producer ? "The producer must review this exact cancellation." : "Use the current production operator or the supplier's own session.", 403);
  const row = (await db.query<{ expires_at: Date }>("SELECT expires_at FROM on_sessions WHERE token_hash=$1 AND tenant_id=$2 AND actor=$3::jsonb AND expires_at>clock_timestamp() FOR SHARE", [sessionHash, actor.tenantId, JSON.stringify(actor)])).rows[0];
  if (!row) throw new DomainError("DISRUPTION_SESSION_ENDED", "This exact session expired or was revoked. Its saved instructions remain available to their original authorized session.", 401);
  return row.expires_at.toISOString();
}
export async function disruptionTransaction<T>(authority: DisruptionAuthority, mutate: boolean, work: (context: Context) => Promise<T>) {
  await migrate(); const db = await pool.connect();
  try {
    await db.query("BEGIN"); const expiresAt = await requireDisruptionAuthority(db, authority);
    const row = (await db.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 " + (mutate ? "FOR UPDATE" : "FOR SHARE"), [authority.actor.tenantId])).rows[0];
    if (!row) throw new DomainError("SHOW_NOT_FOUND", "This production is not available.", 404);
    const value = await work({ db, authority, expiresAt, show: row.snapshot });
    await requireDisruptionAuthority(db, authority); await db.query("COMMIT"); return value;
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
export async function saveRecord(db: Reader, tenantId: string, id: string, kind: "report" | "assessment" | "decision", record: unknown) {
  await db.query("INSERT INTO on_disruption_records(tenant_id,id,kind,digest,document_cipher) VALUES($1,$2,$3,$4,$5)", [tenantId, id, kind, digest(record), sealIntelligence(tenantId, `disruption:${kind}:${id}`, record)]);
}
export async function readRecord<T>(db: Reader, tenantId: string, id: string, kind: "report" | "assessment" | "decision"): Promise<T> {
  const row = (await db.query<{ digest: string; document_cipher: string }>("SELECT digest,document_cipher FROM on_disruption_records WHERE tenant_id=$1 AND id=$2 AND kind=$3", [tenantId, id, kind])).rows[0];
  if (!row) throw new DomainError("DISRUPTION_RECORD_NOT_FOUND", "This record is not in the current production.", 404);
  const value = openIntelligence<T>(tenantId, `disruption:${kind}:${id}`, row.document_cipher);
  if (digest(value) !== row.digest) throw new DomainError("DISRUPTION_RECORD_INTEGRITY", "The original disruption record could not be verified.", 503);
  return value;
}
export async function readDecision(tenantId: string, id: string, db: Reader = pool) { return readRecord<CancellationRecord>(db, tenantId, id, "decision"); }
export async function readRemedyItem(tenantId: string, id: string, db: Reader = pool) {
  const row = (await db.query<{ decision_id: string; ticket_id: string; digest: string; allocation_cipher: string; intent_id: string | null; last_code: string | null; dispatch_authorized_at: Date | null }>("SELECT item.*,progress.intent_id,progress.last_code,progress.dispatch_authorized_at FROM on_event_remedy_items item JOIN on_event_remedy_progress progress ON progress.tenant_id=item.tenant_id AND progress.item_id=item.id WHERE item.tenant_id=$1 AND item.id=$2", [tenantId, id])).rows[0];
  if (!row) throw new DomainError("EVENT_REMEDY_NOT_FOUND", "This original-capture allocation is not in the current production.", 404);
  const allocation = openIntelligence<EventRemedyAllocation>(tenantId, `event-remedy:${id}`, row.allocation_cipher);
  if (allocation.id !== id || allocation.tenantId !== tenantId || allocation.decisionId !== row.decision_id || allocation.ticketId !== row.ticket_id || digest(allocation) !== row.digest) throw new DomainError("EVENT_REMEDY_INTEGRITY", "The original capture allocation could not be verified.", 503);
  const progress: RemedyProgress = { intentId: row.intent_id, lastCode: row.last_code, dispatchAuthorizedAt: row.dispatch_authorized_at?.toISOString() ?? null };
  return { allocation, progress };
}
export async function saveRemedyItem(db: Reader, item: EventRemedyAllocation) {
  await db.query("INSERT INTO on_event_remedy_items(tenant_id,id,decision_id,ticket_id,digest,allocation_cipher) VALUES($1,$2,$3,$4,$5,$6)", [item.tenantId, item.id, item.decisionId, item.ticketId, digest(item), sealIntelligence(item.tenantId, `event-remedy:${item.id}`, item)]);
  await db.query("INSERT INTO on_event_remedy_progress(tenant_id,item_id) VALUES($1,$2)", [item.tenantId, item.id]);
}
export async function remedyItems(tenantId: string, decisionId: string, db: Reader = pool) {
  const rows = (await db.query<{ id: string }>("SELECT id FROM on_event_remedy_items WHERE tenant_id=$1 AND decision_id=$2 ORDER BY ticket_id", [tenantId, decisionId])).rows;
  return Promise.all(rows.map(row => readRemedyItem(tenantId, row.id, db)));
}
export const allocationDigest = (items: Omit<EventRemedyAllocation, "id" | "decisionId">[]) => digest([...items].sort((a, b) => a.ticketId.localeCompare(b.ticketId)));
export async function assertDecisionInventory(db: Reader, record: CancellationRecord) {
  const items = await remedyItems(record.tenantId, record.decision.id, db);
  const allocations = items.map(({ allocation: { id: _id, decisionId: _decision, ...item } }) => item);
  if (allocationDigest(allocations) !== record.allocationDigest || allocations.length !== record.decision.newRefundCount || allocations.reduce((sum, item) => sum + item.amountMinor, 0) !== record.decision.newRefundMinor) throw new DomainError("EVENT_REMEDY_INVENTORY_CHANGED", "The producer's exact original-capture allocation could not be verified.", 403);
  return items;
}
export async function originalReceipt(context: Context, commandId: string, payloadHash?: string) {
  const row = (await context.db.query<{ actor_id: string; session_hash: string; payload_hash: string; receipt_cipher: string }>("SELECT actor_id,session_hash,payload_hash,receipt_cipher FROM on_disruption_commands WHERE tenant_id=$1 AND command_id=$2", [context.show.tenantId, commandId])).rows[0];
  if (!row || row.actor_id !== context.authority.actor.id || row.session_hash !== context.authority.sessionHash) {
    if (row && payloadHash) throw new DomainError("DISRUPTION_COMMAND_OWNERSHIP", "This command identity belongs to a different exact session.", 403);
    return null;
  }
  if (payloadHash && row.payload_hash !== payloadHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This command identity already contains different instructions.");
  return openIntelligence<DisruptionReceipt>(context.show.tenantId, `disruption-command:${commandId}`, row.receipt_cipher);
}
export async function saveReceipt(context: Context, payloadHash: string, receipt: DisruptionReceipt) {
  await context.db.query("INSERT INTO on_disruption_commands(tenant_id,command_id,actor_id,session_hash,payload_hash,receipt_cipher) VALUES($1,$2,$3,$4,$5,$6)", [context.show.tenantId, receipt.commandId, context.authority.actor.id, context.authority.sessionHash, payloadHash, sealIntelligence(context.show.tenantId, `disruption-command:${receipt.commandId}`, receipt)]);
}
