import { createHmac, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { DomainError, type Actor } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { RehearsalOverview, RehearsalSummary } from "@/domain/rehearsal-contracts";
import { env } from "./env";
import { migrate, pool } from "./store";
import { SESSION_ADMISSION_SCOPE } from "./session-admission";
import { insertProducerRehearsal, sessionTokenHash } from "./session-records";

const label = z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f\u007f]+$/);
const common = { idempotencyKey: z.uuid(), expectedTenantId: z.uuid() };
export const rehearsalRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), ...common, label }).strict(),
  z.object({ type: z.literal("switch"), ...common, targetTenantId: z.uuid() }).strict(),
  z.object({ type: z.literal("rename"), ...common, label }).strict(),
]);
export type RehearsalRequest = z.infer<typeof rehearsalRequest>;
type Member = { tenant_id: string; workspace_id: string; actor_id: string; actor: Actor; label: string; authority_expires_at: Date };
function producer(actor: Actor) { if (!actor.roles.includes("producer")) throw new DomainError("PRODUCER_REQUIRED", "Only the production operator can manage saved rehearsals.", 403); }
async function activeActor(client: PoolClient, actor: Actor) {
  const result = await client.query<{ actor: Actor; expires_at: Date }>("SELECT actor,expires_at FROM on_sessions WHERE tenant_id=$1 AND actor->>'id'=$2 AND expires_at>now() ORDER BY expires_at DESC LIMIT 1", [actor.tenantId, actor.id]);
  const row = result.rows[0]; if (!row?.actor.roles.includes("producer")) throw new DomainError("REHEARSAL_ACCESS_EXPIRED", "This rehearsal's producer access expired. Its history is retained.", 403);
  if (digest(row.actor) !== digest(actor)) throw new DomainError("REHEARSAL_ACTOR_CHANGED", "Refresh this production's current operator before switching rehearsals.", 403);
  return row;
}
function assertMember(member: Member, actor: Actor) {
  if (member.tenant_id !== actor.tenantId || member.actor_id !== actor.id || member.actor.tenantId !== actor.tenantId || member.actor.id !== actor.id || digest(member.actor) !== digest(actor)) throw new DomainError("REHEARSAL_MEMBERSHIP_CHANGED", "This saved workspace does not match its original producer.", 403);
  if (member.authority_expires_at.getTime() <= Date.now()) throw new DomainError("REHEARSAL_ACCESS_EXPIRED", "This saved rehearsal's navigation access expired. Its history is retained.", 403);
}
async function ensureWorkspace(client: PoolClient, actor: Actor) {
  // Concurrent first-use requests must all adopt the same existing producer.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,4105005))", [actor.id]);
  const session = await activeActor(client, actor);
  let member = (await client.query<Member>("SELECT * FROM on_rehearsal_members WHERE tenant_id=$1", [actor.tenantId])).rows[0];
  if (!member) {
    const workspaceId = randomUUID();
    await client.query("INSERT INTO on_rehearsal_workspaces(id) VALUES($1)", [workspaceId]);
    const inserted = await client.query<Member>("INSERT INTO on_rehearsal_members(tenant_id,workspace_id,actor_id,actor,label,authority_expires_at) VALUES($1,$2,$3,$4,'Alder Hall rehearsal',$5) RETURNING *", [actor.tenantId, workspaceId, actor.id, actor, session.expires_at]);
    member = inserted.rows[0]!;
  }
  assertMember(member, actor);
  await client.query("SELECT id FROM on_rehearsal_workspaces WHERE id=$1 FOR UPDATE", [member.workspace_id]);
  return member;
}
const summarySelect = `SELECT m.tenant_id,m.label,m.authority_expires_at,m.created_at,m.last_opened_at,
  s.revision,s.snapshot->>'title' AS title,s.snapshot->>'venue' AS venue,s.snapshot->>'state' AS state,
  (s.snapshot->>'planVersion')::integer AS plan_version,
  EXISTS(SELECT 1 FROM jsonb_array_elements(s.snapshot->'financialEvidence') AS evidence
    WHERE evidence->>'source'='live_sandbox' AND evidence->>'verified'='true' AND evidence->>'provenance' IS DISTINCT FROM 'replay') AS financial_history,
  EXISTS(SELECT 1 FROM on_sessions WHERE tenant_id=m.tenant_id AND actor=m.actor AND expires_at>now()) AS producer_active,
  (SELECT count(*)::integer FROM on_jobs WHERE tenant_id=m.tenant_id AND status IN ('queued','running','waiting')) AS pending_work,
  (SELECT count(*)::integer FROM on_jobs WHERE tenant_id=m.tenant_id AND status='needs_attention') AS review_work
  FROM on_rehearsal_members m JOIN on_shows s ON s.tenant_id=m.tenant_id`;
type SummaryRow = { tenant_id: string; label: string; authority_expires_at: Date; created_at: Date; last_opened_at: Date;
  revision: number; title: string; venue: string; state: RehearsalSummary["state"]; plan_version: number; financial_history: boolean; producer_active: boolean; pending_work: number; review_work: number };
const summary = (row: SummaryRow, current: string): RehearsalSummary => ({ tenantId: row.tenant_id, label: row.label, title: row.title, venue: row.venue,
  revision: row.revision, planVersion: row.plan_version, state: row.state, createdAt: row.created_at.toISOString(), lastOpenedAt: row.last_opened_at.toISOString(), accessExpiresAt: row.authority_expires_at.toISOString(),
  current: row.tenant_id === current, accessExpired: row.authority_expires_at.getTime() <= Date.now() || !row.producer_active, hasFinancialHistory: row.financial_history, pendingWork: row.pending_work, reviewWork: row.review_work });

/** Listing never adopts a workspace, extends a capability, writes a show or contacts a provider. */
export async function listRehearsals(actor: Actor, offset = 0): Promise<RehearsalOverview> {
  producer(actor); await migrate(); const client = await pool.connect();
  try {
    const current = await activeActor(client, actor);
    const member = (await client.query<Member>("SELECT * FROM on_rehearsal_members WHERE tenant_id=$1", [actor.tenantId])).rows[0];
    if (!member) {
      const row = (await client.query<Omit<SummaryRow, "label" | "authority_expires_at" | "last_opened_at" | "producer_active">>(`SELECT tenant_id,revision,created_at,snapshot->>'title' AS title,snapshot->>'venue' AS venue,snapshot->>'state' AS state,(snapshot->>'planVersion')::integer AS plan_version,
        EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'financialEvidence') AS evidence WHERE evidence->>'source'='live_sandbox' AND evidence->>'verified'='true' AND evidence->>'provenance' IS DISTINCT FROM 'replay') AS financial_history,
        (SELECT count(*)::integer FROM on_jobs WHERE tenant_id=s.tenant_id AND status IN ('queued','running','waiting')) AS pending_work,
        (SELECT count(*)::integer FROM on_jobs WHERE tenant_id=s.tenant_id AND status='needs_attention') AS review_work FROM on_shows s WHERE tenant_id=$1`, [actor.tenantId])).rows[0]!;
      return { currentTenantId: actor.tenantId, items: offset ? [] : [summary({ ...row, label: "Alder Hall rehearsal", authority_expires_at: current.expires_at, last_opened_at: row.created_at, producer_active: true }, actor.tenantId)], total: 1, nextOffset: null, serverAt: new Date().toISOString() };
    }
    assertMember(member, actor);
    const rows = await client.query<SummaryRow>(summarySelect + " WHERE m.workspace_id=$1 ORDER BY m.last_opened_at DESC,m.tenant_id LIMIT 25 OFFSET $2", [member.workspace_id, offset]);
    const total = (await client.query<{ count: number }>("SELECT count(*)::integer AS count FROM on_rehearsal_members WHERE workspace_id=$1", [member.workspace_id])).rows[0]!.count;
    return { currentTenantId: actor.tenantId, items: rows.rows.map(row => summary(row, actor.tenantId)), total, nextOffset: offset + rows.rowCount! < total ? offset + rows.rowCount! : null, serverAt: new Date().toISOString() };
  } finally { client.release(); }
}

/** A fixed request identity prevents a lost create response from creating another rehearsal. */
export async function changeRehearsal(actor: Actor, input: RehearsalRequest, admissionScope = SESSION_ADMISSION_SCOPE) {
  producer(actor); await migrate();
  if (input.expectedTenantId !== actor.tenantId) throw new DomainError("PRODUCTION_CHANGED", "This tab belongs to another rehearsal. Reload to see the currently selected production before acting.", 409);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const source = await ensureWorkspace(client, actor), payloadHash = digest({ actorId: actor.id, ...input });
    const prior = (await client.query<{ payload_hash: string; target_tenant_id: string }>("SELECT payload_hash,target_tenant_id FROM on_rehearsal_requests WHERE workspace_id=$1 AND request_id=$2", [source.workspace_id, input.idempotencyKey])).rows[0];
    const token = input.type === "rename" ? null : createHmac("sha256", env.sessionSecret).update("rehearsal-session:" + source.workspace_id + ":" + input.idempotencyKey).digest("base64url");
    let targetId: string;
    if (prior) {
      if (prior.payload_hash !== payloadHash) throw new DomainError("REHEARSAL_REQUEST_CHANGED", "This request already has different saved instructions. Keep its original result and review a new action.", 409);
      targetId = prior.target_tenant_id;
    } else if (input.type === "create") {
      const created = await insertProducerRehearsal(client, token!, admissionScope);
      targetId = created.actor.tenantId;
      await client.query("INSERT INTO on_rehearsal_members(tenant_id,workspace_id,actor_id,actor,label,authority_expires_at) VALUES($1,$2,$3,$4,$5,$6)", [targetId, source.workspace_id, created.actor.id, created.actor, input.label, created.expiresAt]);
    } else {
      targetId = input.type === "switch" ? input.targetTenantId : actor.tenantId;
    }
    const target = (await client.query<Member>("SELECT * FROM on_rehearsal_members WHERE workspace_id=$1 AND tenant_id=$2", [source.workspace_id, targetId])).rows[0];
    if (!target) throw new DomainError("REHEARSAL_NOT_OWNED", "This rehearsal is not part of the current producer's saved workspace.", 404);
    assertMember(target, target.actor); await activeActor(client, target.actor);
    if (!prior) {
      if (input.type === "rename") await client.query("UPDATE on_rehearsal_members SET label=$2 WHERE tenant_id=$1", [targetId, input.label]);
      await client.query("INSERT INTO on_rehearsal_requests(workspace_id,request_id,payload_hash,kind,source_tenant_id,target_tenant_id) VALUES($1,$2,$3,$4,$5,$6)", [source.workspace_id, input.idempotencyKey, payloadHash, input.type, actor.tenantId, targetId]);
    }
    if (token) {
      await client.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(token_hash) DO NOTHING", [sessionTokenHash(token), targetId, target.actor, target.authority_expires_at]);
      await client.query("UPDATE on_rehearsal_members SET last_opened_at=now() WHERE tenant_id=$1", [targetId]);
    }
    await client.query("COMMIT");
    return { tenantId: targetId, token, actor: target.actor, expiresAt: target.authority_expires_at.toISOString(), replayed: Boolean(prior) };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
