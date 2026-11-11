import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import type { RentalExecution, SupplierId } from "@/domain/supplier-contracts";
import { projectExecutionMilestones, readiness } from "./crew/readiness";
import { migrate, pool } from "./store";

export async function supplierTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  await migrate(); const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function lockSupplierShow(client: PoolClient, tenantId: string) {
  const result = await client.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
  if (!result.rows[0]) throw new DomainError("SHOW_NOT_FOUND", "This rehearsal no longer exists.", 404);
  return result.rows[0].snapshot;
}
export async function supplierActor(client: PoolClient, tenantId: string, actorId: string) {
  const result = await client.query<{ actor: Actor }>("SELECT actor FROM on_sessions WHERE tenant_id=$1 AND actor->>'id'=$2 AND expires_at>now() LIMIT 1", [tenantId, actorId]);
  if (!result.rows[0]) throw new DomainError("AUTHORITY_EXPIRED", "This supplier instruction needs a current production capability.", 403);
  return result.rows[0].actor;
}
export function assertProducer(actor: Actor) { if (!actor.roles.includes("producer")) throw new DomainError("PRODUCER_REQUIRED", "The production operator must approve this commitment.", 403); }
export function supplierScope(actor: Actor): SupplierId | null {
  if (actor.supplierId) return actor.supplierId;
  return actor.id.startsWith("supplier:brightline:") ? "brightline" : null;
}
export function assertSupplier(actor: Actor, supplierId: SupplierId) {
  if (!actor.roles.includes("supplier") || supplierScope(actor) !== supplierId) throw new DomainError("SUPPLIER_SCOPE_REQUIRED", "This action belongs to another supplier service.", 403);
}
export function assertRevision(show: ShowSnapshot, expected: number | undefined) {
  if (expected !== undefined && show.revision !== expected) throw new DomainError("STALE_REVISION", "The production changed. Review its current state before continuing.");
}
export async function readRentalExecution(client: Pick<PoolClient, "query">, tenantId: string, id: string): Promise<RentalExecution> {
  const result = await client.query<{ document: RentalExecution }>("SELECT document FROM on_rental_executions WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
  if (!result.rows[0]) throw new DomainError("EXECUTION_NOT_FOUND", "This rental execution does not belong to the rehearsal.", 404);
  return result.rows[0].document;
}
export async function saveRentalExecution(client: PoolClient, show: ShowSnapshot, execution: RentalExecution) {
  execution.updatedAt = new Date().toISOString();
  await client.query("UPDATE on_rental_executions SET document=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [show.tenantId, execution.id, execution]);
  show.rentalExecutions = [...(show.rentalExecutions ?? []).filter(item => item.id !== execution.id), execution];
}
export async function saveSupplierSnapshot(client: PoolClient, show: ShowSnapshot, actorId: string, type: string, message: string) {
  const now = new Date().toISOString(); show.revision++; show.updatedAt = now;
  const event = { id: randomUUID(), type, message, at: now, fixtureAt: show.clock, actorId, source: "sample" as const, revision: show.revision };
  show.events.push(event);
  if (show.state !== "standby" && !readiness(show, "DOORS").ready) { show.state = "standby"; show.goReportId = null; }
  await client.query("UPDATE on_shows SET snapshot=$2,revision=$3,updated_at=now() WHERE tenant_id=$1", [show.tenantId, projectExecutionMilestones(show), show.revision]);
  await client.query("INSERT INTO on_events(id,tenant_id,revision,event) VALUES($1,$2,$3,$4)", [event.id, show.tenantId, show.revision, event]);
}
export function appendSupplierFact(show: ShowSnapshot, actor: Actor, kind: "supplier_confirmed" | "delivery_accepted" | "return_accepted", detail: string) {
  if (show.facts.some(fact => fact.kind === kind && fact.planVersion === show.planVersion)) return;
  show.facts.push({ id: randomUUID(), kind, planVersion: show.planVersion, actorId: actor.id, role: kind === "delivery_accepted" ? "department_lead" : "supplier", recordedAt: new Date().toISOString(), fixtureAt: show.clock, source: "sample", detail });
}
