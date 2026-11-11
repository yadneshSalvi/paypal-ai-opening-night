import type { PoolClient } from "pg";
import { DomainError, type Actor } from "@/domain/contracts";
import type { CohortState, CohortTerms, TicketTier } from "@/domain/commerce-contracts";
import { pool } from "./store";
export { withCommerceLock, closeCommerceLocks } from "./commerce-locks";

export type DatabaseReader = Pick<PoolClient, "query">;
export interface TicketCohortRecord {
  id: string; tenantId: string; state: CohortState; terms: CohortTerms; digest: string; ticketSetDigest: string; version: number;
  createdAt: string; approvedBy: string | null; approvedAt: string | null; expiresAt: string | null;
  revokedAt: string | null; pauseCode: string | null; pauseTicketId: string | null; origin: string; reviewDigest: string | null;
}
export interface CohortTicketRecord {
  id: string; tenantId: string; cohortId: string; ordinal: number; tier: TicketTier; amountMinor: number;
  rootIntentId: string | null; captureIntentId: string | null; reservedAt: string | null;
  dispatchAuthorizedAt: string | null; lastCode: string | null;
}
export interface RemedyItemRecord {
  id: string; tenantId: string; batchId: string; ticketId: string; ordinal: number;
  rootIntentId: string; orderId: string; captureId: string; amountMinor: 1500;
  intentId: string | null; dispatchAuthorizedAt: string | null; lastCode: string | null;
}
export interface RemedyBatchRecord {
  id: string; tenantId: string; state: Exclude<CohortState, "draft">; digest: string;
  planVersion: number; planDigest: string; approvedBy: string; approvedAt: string; expiresAt: string;
  revokedAt: string | null; pauseCode: string | null; pauseItemId: string | null;
}

export async function activeCommerceActor(tenantId: string, actorId: string, client: DatabaseReader = pool): Promise<Actor> {
  const result = await client.query<{ actor: Actor }>("SELECT actor FROM on_sessions WHERE tenant_id=$1 AND actor->>'id'=$2 AND expires_at>now() LIMIT 1", [tenantId, actorId]);
  const actor = result.rows[0]?.actor;
  if (!actor?.roles.includes("producer")) throw new DomainError("COMMERCE_AUTHORITY_EXPIRED", "This instruction needs its current production operator.", 403);
  return actor;
}
export async function readCohort(tenantId: string, id: string, client: DatabaseReader = pool, lock = false) {
  const result = await client.query<{ document: TicketCohortRecord }>("SELECT document FROM on_ticket_cohorts WHERE tenant_id=$1 AND id=$2" + (lock ? " FOR UPDATE" : ""), [tenantId, id]);
  if (!result.rows[0]) throw new DomainError("COHORT_NOT_FOUND", "This ticket cohort does not belong to the current production.", 404);
  return result.rows[0].document;
}
export async function readCohortTicket(tenantId: string, id: string, client: DatabaseReader = pool) {
  const result = await client.query<{ cohort_id: string; ordinal: number; tier: string; amount_minor: number; document: CohortTicketRecord }>("SELECT cohort_id,ordinal,tier,amount_minor,document FROM on_cohort_tickets WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
  if (!result.rows[0]) throw new DomainError("COHORT_TICKET_NOT_FOUND", "This ticket does not belong to the current cohort.", 404);
  const row = result.rows[0], line = row.document;
  if (line.id !== id || line.tenantId !== tenantId || line.cohortId !== row.cohort_id || line.ordinal !== row.ordinal || line.tier !== row.tier || line.amountMinor !== row.amount_minor) throw new DomainError("COHORT_LINE_MISMATCH", "The logical ticket no longer matches its immutable allocation.", 403);
  return line;
}
export async function saveCohort(client: DatabaseReader, cohort: TicketCohortRecord) { await client.query("UPDATE on_ticket_cohorts SET document=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [cohort.tenantId, cohort.id, cohort]); }
export async function saveCohortTicket(client: DatabaseReader, line: CohortTicketRecord) { await client.query("UPDATE on_cohort_tickets SET root_intent_id=$3,capture_intent_id=$4,document=$5 WHERE tenant_id=$1 AND id=$2", [line.tenantId, line.id, line.rootIntentId, line.captureIntentId, line]); }
export async function readRemedyBatch(tenantId: string, id: string, client: DatabaseReader = pool, lock = false) {
  const result = await client.query<{ document: RemedyBatchRecord }>("SELECT document FROM on_remedy_batches WHERE tenant_id=$1 AND id=$2" + (lock ? " FOR UPDATE" : ""), [tenantId, id]);
  if (!result.rows[0]) throw new DomainError("REMEDY_BATCH_NOT_FOUND", "This remedy batch does not belong to the current production.", 404);
  return result.rows[0].document;
}
export async function readRemedyItem(tenantId: string, id: string, client: DatabaseReader = pool) {
  const result = await client.query<{ batch_id: string; ticket_id: string; capture_id: string; amount_minor: number; ordinal: number; document: RemedyItemRecord }>("SELECT batch_id,ticket_id,capture_id,amount_minor,ordinal,document FROM on_remedy_items WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
  if (!result.rows[0]) throw new DomainError("REMEDY_ITEM_NOT_FOUND", "This remedy does not belong to the current batch.", 404);
  const row = result.rows[0], item = row.document;
  if (item.id !== id || item.tenantId !== tenantId || item.batchId !== row.batch_id || item.ticketId !== row.ticket_id || item.captureId !== row.capture_id || item.amountMinor !== row.amount_minor || item.ordinal !== row.ordinal) throw new DomainError("REMEDY_BATCH_LINE_MISMATCH", "The remedy no longer matches its immutable original-capture allocation.", 403);
  return item;
}
export async function saveRemedyBatch(client: DatabaseReader, batch: RemedyBatchRecord) { await client.query("UPDATE on_remedy_batches SET document=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [batch.tenantId, batch.id, batch]); }
export async function saveRemedyItem(client: DatabaseReader, item: RemedyItemRecord) { await client.query("UPDATE on_remedy_items SET intent_id=$3,document=$4 WHERE tenant_id=$1 AND id=$2", [item.tenantId, item.id, item.intentId, item]); }
