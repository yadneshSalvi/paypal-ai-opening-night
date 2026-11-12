import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { planningDigest } from "@/domain/scheduling";
import type { InputAuthority, InputScope } from "@/domain/production-inputs/contracts";
import type { ReviewContent, WorkbenchEnvelope, WorkbenchReceipt, WorkbenchResult, WorkbenchReview } from "@/domain/planning-workbench/contracts";
import { openIntelligence, sealIntelligence } from "../intelligence/private-payload";
import { inputNow } from "../production-inputs/store";
const context = (kind: "review" | "command", id: string) => `planning-workbench/v1:${kind}:${id}`;
export const workbenchDigest = (show: ShowSnapshot) => digest({ planning: planningDigest(show), showId: show.id, showDate: show.showDate, zone: show.zone, venue: show.venue, curfew: show.curfewAt, accessUntil: show.accessUntil, nextCallAt: show.nextCallAt, nextCalls: show.crewNextCalls ?? [], clock: show.clock, cancellation: show.cancellationDecision ?? null });
export function openReview(tenantId: string, row: { id: string; review_cipher: string; review_digest: string }): WorkbenchReview {
 const review = openIntelligence<WorkbenchReview>(tenantId, context("review", row.id), row.review_cipher), { digest: saved, ...content } = review;
 if (saved !== row.review_digest || saved !== digest(content) || review.id !== row.id || review.scope.tenantId !== tenantId) throw new DomainError("WORKBENCH_INTEGRITY", "The retained planning review cannot be verified.", 503);
 return review;
}
export async function reviewById(db: PoolClient, tenantId: string, id: string) {
 const row = (await db.query("SELECT * FROM on_planning_workbench_reviews WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0];
 if (!row) throw new DomainError("WORKBENCH_REVIEW_MISSING", "This review is not in the current production.", 404);
 return { row, review: openReview(tenantId, row) };
}
export async function saveReview(db: PoolClient, authority: InputAuthority, envelope: WorkbenchEnvelope, show: ShowSnapshot, content: ReviewContent) {
 const id = randomUUID(), value = { version: 1 as const, id, scope: envelope.scope, baseRevision: show.revision, sourceDigest: workbenchDigest(show), createdAt: await inputNow(db), expiresAt: envelope.scope.sessionExpiresAt, content }, review = { ...value, digest: digest(value) };
 await db.query("INSERT INTO on_planning_workbench_reviews(tenant_id,id,kind,actor_id,session_hash,expires_at,fingerprint,base_revision,review_cipher,review_digest,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [show.tenantId, id, content.kind, authority.actor.id, authority.sessionHash, review.expiresAt, envelope.scope.sessionFingerprint, show.revision, sealIntelligence(show.tenantId, context("review", id), review), review.digest, review.createdAt]);
 return review;
}
export async function readReceipt(db: PoolClient, authority: InputAuthority, scope: InputScope, id: string, requestDigest?: string): Promise<WorkbenchResult | null> {
 const row = (await db.query(`SELECT *,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_expiry FROM on_planning_workbench_commands WHERE tenant_id=$1 AND command_id=$2`, [scope.tenantId, id])).rows[0];
 if (!row) return null;
 if (row.session_hash !== authority.sessionHash || row.actor_id !== authority.actor.id || row.fingerprint !== scope.sessionFingerprint || row.exact_expiry !== scope.sessionExpiresAt) throw new DomainError("WORKBENCH_COMMAND_MISSING", "No original receipt belongs to this exact current access.", 404);
 if (requestDigest && row.request_digest !== requestDigest) throw new DomainError("WORKBENCH_COMMAND_CONFLICT", "That command identity already has different reviewed instructions.");
 const receipt = openIntelligence<WorkbenchReceipt>(scope.tenantId, context("command", id), row.receipt_cipher), { digest: saved, ...value } = receipt;
 if (saved !== row.receipt_digest || saved !== digest(value) || receipt.commandId !== id || receipt.requestDigest !== row.request_digest || digest(receipt.scope) !== digest(scope)) throw new DomainError("WORKBENCH_INTEGRITY", "The original command receipt cannot be verified.", 503);
 return { receipt, replayed: true };
}
export async function saveReceipt(db: PoolClient, authority: InputAuthority, envelope: WorkbenchEnvelope, result: WorkbenchReceipt["result"]): Promise<WorkbenchResult> {
 const content = { version: 1 as const, commandId: envelope.commandId, requestDigest: digest(envelope), scope: envelope.scope, acceptedAt: await inputNow(db), action: envelope.command.type, result }, receipt = { ...content, digest: digest(content) };
 await db.query("INSERT INTO on_planning_workbench_commands(tenant_id,command_id,actor_id,session_hash,expires_at,fingerprint,request_digest,receipt_cipher,receipt_digest,accepted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [envelope.scope.tenantId, envelope.commandId, authority.actor.id, authority.sessionHash, envelope.scope.sessionExpiresAt, envelope.scope.sessionFingerprint, receipt.requestDigest, sealIntelligence(envelope.scope.tenantId, context("command", envelope.commandId), receipt), receipt.digest, receipt.acceptedAt]);
 if (result.admitted) await db.query("INSERT INTO on_planning_workbench_admissions(tenant_id,review_id,command_id,admitted_at) VALUES($1,$2,$3,$4)", [envelope.scope.tenantId, result.reviewId, envelope.commandId, receipt.acceptedAt]);
 return { receipt, replayed: false };
}
