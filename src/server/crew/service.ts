import type { PoolClient } from "pg";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import { applyCrewCommand } from "@/domain/crew/commands";
import type { CrewCommandEnvelope, CrewCommandReceipt, CrewCommandResponse } from "@/domain/crew/contracts";
import { requireCrewPerson } from "@/domain/crew/policy";
import { getShow, migrate, pool, transactCommand } from "../store";
import { sessionTokenHash } from "../session-records";
import { crewData } from "./projection";
import { signCrewRecord, verifyCrewRecord } from "./signatures";
import { projectExecutionMilestones } from "./readiness";

export interface CrewSession { actor: Actor; expiresAt: string; tokenHash: string }
export async function requireCrewSession(request: Request): Promise<CrewSession> {
  const authorization = request.headers.get("authorization");
  // A producer cookie, scoped delivery cookie, or body person ID is never a
  // substitute for this explicit personal bearer capability.
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw new DomainError("CREW_CAPABILITY_REQUIRED", "Open your personal crew access link to continue.", 401);
  await migrate();
  const tokenHash = sessionTokenHash(authorization.slice(7));
  const result = await pool.query<{ actor: Actor; expires_at: Date }>("SELECT actor,expires_at FROM on_sessions WHERE token_hash=$1 AND expires_at>clock_timestamp()", [tokenHash]);
  const session = result.rows[0];
  if (!session) throw new DomainError("CREW_ACCESS_EXPIRED", "This crew link expired or was revoked. Request a new personal link from the producer.", 401);
  const show = await getShow(session.actor.tenantId);
  requireCrewPerson(show, session.actor);
  return { actor: session.actor, expiresAt: session.expires_at.toISOString(), tokenHash };
}
async function assertCurrentAccess(client: PoolClient, access: CrewSession) {
  const result = await client.query<{ actor: Actor }>("SELECT actor FROM on_sessions WHERE token_hash=$1 AND expires_at>clock_timestamp() FOR SHARE", [access.tokenHash]);
  const actor = result.rows[0]?.actor;
  if (!actor || actor.id !== access.actor.id || actor.tenantId !== access.actor.tenantId || actor.personId !== access.actor.personId || actor.roles.length !== 1 || actor.roles[0] !== "crew" || actor.executionId || actor.supplierId) throw new DomainError("CREW_ACCESS_EXPIRED", "This crew capability is no longer current. Request a new personal link.", 401);
}
export async function readCrew(access: CrewSession) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR SHARE", [access.actor.tenantId]);
    if (!result.rows[0]) throw new DomainError("SHOW_NOT_FOUND", "This production no longer exists.", 404);
    await assertCurrentAccess(client, access);
    const data = crewData(projectExecutionMilestones(result.rows[0].snapshot), access.actor, access.expiresAt);
    await client.query("COMMIT"); return data;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export async function executeCrew(access: CrewSession, envelope: CrewCommandEnvelope): Promise<CrewCommandResponse> {
  const { idempotencyKey, expectedRevision, command } = envelope;
  const result = await transactCommand(access.actor, idempotencyKey, expectedRevision, command, show => applyCrewCommand(show, access.actor, idempotencyKey, command, { sign: signCrewRecord, verify: verifyCrewRecord }), client => assertCurrentAccess(client, access));
  const data = crewData(result.show, access.actor, access.expiresAt);
  let receipt: CrewCommandReceipt;
  if (command.type === "acknowledge") {
    const saved = data.acknowledgments.find(ack => ack.commandId === idempotencyKey);
    if (!saved) throw new DomainError("CREW_RECEIPT_UNAVAILABLE", "The command was retained, but its receipt could not be read. Check the saved readback before retrying.", 503);
    receipt = { id: saved.id, commandId: idempotencyKey, type: "acknowledgment", current: saved.current };
  } else {
    const saved = data.history.find(record => record.commandId === idempotencyKey);
    if (!saved) throw new DomainError("CREW_RECEIPT_UNAVAILABLE", "The command was retained, but its signed receipt could not be read. Check the saved history before retrying.", 503);
    receipt = { id: saved.id, commandId: idempotencyKey, type: saved.type, current: saved.status === "current" };
  }
  return { data, receipt, replayed: result.replayed };
}
