import { appendEvent } from "@/domain/commands";
import { DomainError, type Actor } from "@/domain/contracts";
import { getShow, pool, transactCommand } from "../store";

function requireProducer(actor: Actor) {
  if (!actor.roles.includes("producer") || actor.personId || actor.executionId || actor.supplierId) throw new DomainError("PRODUCER_REQUIRED", "The producer manages personal crew links.", 403);
}
export async function crewAccessOverview(actor: Actor) {
  requireProducer(actor);
  const show = await getShow(actor.tenantId);
  const result = await pool.query<{ person_id: string; active: string; latest_expiry: Date | null }>("SELECT actor->>'personId' AS person_id,count(*) FILTER (WHERE expires_at>clock_timestamp()) AS active,max(expires_at) FILTER (WHERE expires_at>clock_timestamp()) AS latest_expiry FROM on_sessions WHERE tenant_id=$1 AND actor->'roles'='[\"crew\"]'::jsonb GROUP BY actor->>'personId'", [actor.tenantId]);
  return { revision: show.revision, people: show.resources.filter(person => person.kind === "person").map(person => { const row = result.rows.find(item => item.person_id === person.id); return { personId: person.id, activeLinks: Number(row?.active ?? 0), latestExpiry: row?.latest_expiry?.toISOString() ?? null }; }) };
}
export async function revokeCrewAccess(actor: Actor, personId: string, commandId: string, expectedRevision: number) {
  requireProducer(actor);
  return transactCommand(actor, commandId, expectedRevision, { type: "crew.revoke_access", personId }, input => {
    const person = input.resources.find(resource => resource.id === personId && resource.kind === "person");
    if (!person) throw new DomainError("PERSON_NOT_FOUND", "This person is not on the current production roster.", 404);
    const show = structuredClone(input); const now = new Date().toISOString();
    appendEvent(show, actor, "crew.access_revoked", `Revoked current personal access links for ${person.name}. Previously recorded readbacks and signed actions remain in history.`, now);
    show.revision++; show.updatedAt = now; return show;
  }, undefined, async client => {
    await client.query("UPDATE on_sessions SET expires_at=LEAST(expires_at,clock_timestamp()) WHERE tenant_id=$1 AND actor->>'personId'=$2 AND actor->'roles'='[\"crew\"]'::jsonb", [actor.tenantId, personId]);
  });
}
