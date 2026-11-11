import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Actor } from "@/domain/contracts";
import { createFixture } from "@/domain/fixture";
import { env } from "./env";
import { claimSessionAdmission, SESSION_ADMISSION_SCOPE } from "./session-admission";

export function sessionTokenHash(token: string) { return createHash("sha256").update(`${env.sessionSecret}:${token}`).digest("hex"); }

/** The caller owns the transaction, including its admission reservation and workspace membership. */
export async function insertProducerRehearsal(client: PoolClient, token: string, admissionScope = SESSION_ADMISSION_SCOPE) {
  await claimSessionAdmission(client, admissionScope);
  const tenantId = randomUUID();
  const actor: Actor = { id: `producer:${randomUUID()}`, tenantId, roles: ["producer", "stage_manager", "department_lead", "foh"], personId: null };
  const show = createFixture(tenantId); show.commercialProtocol = 2; show.rentalExecutions = []; show.events[0]!.id = randomUUID();
  await client.query("INSERT INTO on_shows(tenant_id,snapshot,revision) VALUES($1,$2,$3)", [tenantId, show, show.revision]);
  const event = show.events[0]!;
  await client.query("INSERT INTO on_events(id,tenant_id,revision,event) VALUES($1,$2,$3,$4)", [event.id, tenantId, event.revision, event]);
  const session = await client.query<{ expires_at: Date }>("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '7 days') RETURNING expires_at", [sessionTokenHash(token), tenantId, actor]);
  return { show, actor, expiresAt: session.rows[0]!.expires_at.toISOString() };
}
