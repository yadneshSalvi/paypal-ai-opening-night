import type { PoolClient } from "pg";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { InputAuthority, InputCommandResult, InputEnvelope, InputReceipt, InputScope } from "@/domain/production-inputs/contracts";
import { pool, migrate } from "../store";
import { openIntelligence, sealIntelligence } from "../intelligence/private-payload";

export const inputContext = (id: string, part: string) => `production-inputs/v1:${id}:${part}`;
export function inputFail(code: string, message: string, status = 409): never { throw new DomainError(code, message, status); }
export const inputFingerprint = (authority: InputAuthority, expiresAt: string) => digest({ purpose: "production-inputs/original-access/v1", actor: authority.actor, sessionHash: authority.sessionHash, expiresAt });
export async function inputNow(db: PoolClient) { return (await db.query<{ now: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`)).rows[0]!.now; }
export async function inputTransaction<T>(run: (db: PoolClient) => Promise<T>) {
  await migrate(); const db = await pool.connect();
  try { await db.query("BEGIN"); const result = await run(db); await db.query("COMMIT"); return result; }
  catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
export async function inputShow(db: PoolClient, tenantId: string, lock = false): Promise<ShowSnapshot> {
  const row = (await db.query<{ snapshot: ShowSnapshot }>(`SELECT snapshot FROM on_shows WHERE tenant_id=$1${lock ? " FOR UPDATE" : ""}`, [tenantId])).rows[0];
  if (!row) inputFail("INPUT_PRODUCTION_NOT_FOUND", "This production is unavailable.", 404);
  return row.snapshot;
}
export async function inputAuthority(db: PoolClient, authority: InputAuthority, expected?: InputScope): Promise<InputScope> {
  const actor = authority.actor;
  if (actor.personId || actor.executionId || actor.supplierId || actor.roles.includes("crew") || !actor.roles.includes("producer")) inputFail("INPUT_PRODUCER_REQUIRED", "The production's producer reviews and admits these planning inputs.", 403);
  const row = (await db.query<{ expiry: string }>(`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expiry FROM on_sessions WHERE token_hash=$1 AND tenant_id=$2 AND actor=$3::jsonb AND expires_at>clock_timestamp() FOR SHARE`, [authority.sessionHash, actor.tenantId, JSON.stringify(actor)])).rows[0];
  if (!row) inputFail("INPUT_ACCESS_ENDED", "This original producer access ended or changed. Its retained instructions cannot transfer to another session.", 401);
  const scope = { tenantId: actor.tenantId, actorId: actor.id, sessionFingerprint: inputFingerprint(authority, row.expiry), sessionExpiresAt: row.expiry };
  if (expected && digest(expected) !== digest(scope)) inputFail("INPUT_ACCESS_CHANGED", "This instruction belongs to different original access or a different fixed expiry.", 401);
  return scope;
}
export async function inputUnexpired(db: PoolClient, expiry: string) { return Boolean((await db.query("SELECT 1 WHERE $1::timestamptz>clock_timestamp()", [expiry])).rowCount); }
interface ReceiptRow { session_hash: string; exact_expiry: string; fingerprint: string; request_digest: string; receipt_cipher: string; receipt_digest: string }
export async function inputReceipt(db: PoolClient, authority: InputAuthority, scope: InputScope, commandId: string, requestDigest?: string): Promise<InputCommandResult | null> {
  const row = (await db.query<ReceiptRow>(`SELECT *,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_expiry FROM on_production_input_commands WHERE tenant_id=$1 AND command_id=$2`, [scope.tenantId, commandId])).rows[0];
  if (!row) return null;
  if (row.session_hash !== authority.sessionHash || row.fingerprint !== scope.sessionFingerprint || row.exact_expiry !== scope.sessionExpiresAt) inputFail("INPUT_COMMAND_NOT_FOUND", "No result is available for that original instruction and current access.", 404);
  if (requestDigest && requestDigest !== row.request_digest) inputFail("INPUT_IDEMPOTENCY_CONFLICT", "This command identity already has different immutable instructions.");
  const receipt = openIntelligence<InputReceipt>(scope.tenantId, inputContext(commandId, "receipt"), row.receipt_cipher), { receiptDigest, ...content } = receipt;
  if (digest(content) !== receiptDigest || receiptDigest !== row.receipt_digest || receipt.commandId !== commandId || receipt.scopeId !== scope.sessionFingerprint || receipt.requestDigest !== row.request_digest || receipt.expiresAt !== scope.sessionExpiresAt) inputFail("INPUT_INTEGRITY", "The exact original command receipt cannot be verified.", 503);
  return { receipt, replayed: true };
}
export async function saveInputReceipt(db: PoolClient, authority: InputAuthority, envelope: InputEnvelope, result: InputReceipt["result"]): Promise<InputCommandResult> {
  const content = { version: 1 as const, commandId: envelope.commandId, requestDigest: digest(envelope), scopeId: envelope.scope.sessionFingerprint, expiresAt: envelope.scope.sessionExpiresAt, action: envelope.command.type, acceptedAt: await inputNow(db), result };
  const receipt: InputReceipt = { ...content, receiptDigest: digest(content) };
  await db.query("INSERT INTO on_production_input_commands(tenant_id,command_id,session_hash,expires_at,fingerprint,request_digest,receipt_cipher,receipt_digest,accepted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [envelope.scope.tenantId, envelope.commandId, authority.sessionHash, envelope.scope.sessionExpiresAt, envelope.scope.sessionFingerprint, receipt.requestDigest, sealIntelligence(envelope.scope.tenantId, inputContext(envelope.commandId, "receipt"), receipt), receipt.receiptDigest, receipt.acceptedAt]);
  return { receipt, replayed: false };
}
export function inputObject<T>(tenantId: string, id: string, part: string, cipher: string, hash: string): T {
  const value = openIntelligence<T>(tenantId, inputContext(id, part), cipher);
  if (digest(value) !== hash) inputFail("INPUT_INTEGRITY", "The retained production input cannot be verified.", 503);
  return value;
}
