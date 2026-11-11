import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { migrate, pool } from "./store";

export type JobKind = "payment_reconcile" | "webhook_reconcile" | "supplier_rfq" | "supplier_expire" | "supplier_confirm";
export type JobStatus = "queued" | "running" | "waiting" | "complete" | "needs_attention";
export interface Job {
  id: string; tenantId: string; kind: JobKind; semanticKey: string; payload: Record<string, unknown>;
  status: JobStatus; attempts: number; maxAttempts: number; leaseId: string | null;
  leaseUntil: string | null; runAfter: string; lastCode: string | null; createdAt: string; updatedAt: string;
}
type JobRow = {
  id: string; tenant_id: string; kind: JobKind; semantic_key: string; payload: Record<string, unknown>; payload_hash: string;
  status: JobStatus; attempts: number; max_attempts: number; lease_id: string | null; lease_until: Date | null;
  run_after: Date; last_code: string | null; created_at: Date; updated_at: Date;
};
const project = (row: JobRow): Job => ({ id: row.id, tenantId: row.tenant_id, kind: row.kind, semanticKey: row.semantic_key, payload: row.payload, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts, leaseId: row.lease_id, leaseUntil: row.lease_until?.toISOString() ?? null, runAfter: row.run_after.toISOString(), lastCode: row.last_code, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });

/** Pass the intent/inbox transaction so the wakeup cannot be lost after commit. */
export async function enqueueJob(client: Pick<PoolClient, "query">, spec: { tenantId: string; kind: JobKind; semanticKey: string; payload: Record<string, unknown>; runAfter?: Date; maxAttempts?: number }) {
  const payloadHash = digest(spec.payload);
  const result = await client.query<JobRow>(`INSERT INTO on_jobs(id,tenant_id,kind,semantic_key,payload,payload_hash,status,run_after,max_attempts)
    VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8) ON CONFLICT(tenant_id,kind,semantic_key)
    DO UPDATE SET semantic_key=EXCLUDED.semantic_key RETURNING *`,
  [randomUUID(), spec.tenantId, spec.kind, spec.semanticKey, spec.payload, payloadHash, spec.runAfter ?? new Date(), spec.maxAttempts ?? 12]);
  if (result.rows[0]!.payload_hash !== payloadHash) throw new DomainError("JOB_IDENTITY_CONFLICT", "This work identity already has different instructions.");
  return project(result.rows[0]!);
}

/** Database time, row locks and a fresh fencing token decide the only active owner. */
export async function claimJob(tenantId?: string): Promise<Job | null> {
  await migrate();
  await pool.query(`UPDATE on_jobs SET status='needs_attention',last_code='ATTEMPT_LIMIT',lease_id=NULL,lease_until=NULL,updated_at=now()
    WHERE attempts>=max_attempts AND ((status IN ('queued','waiting') AND run_after<=now()) OR (status='running' AND lease_until<=now()))
    AND ($1::uuid IS NULL OR tenant_id=$1)`, [tenantId ?? null]);
  const result = await pool.query<JobRow>(`WITH next AS (
    SELECT id FROM on_jobs WHERE attempts<max_attempts AND ($1::uuid IS NULL OR tenant_id=$1)
      AND ((status IN ('queued','waiting') AND run_after<=now()) OR (status='running' AND lease_until<=now()))
    ORDER BY run_after,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE on_jobs AS job SET status='running',lease_id=$2,lease_until=now()+interval '75 seconds',
      attempts=attempts+1,updated_at=now() FROM next WHERE job.id=next.id RETURNING job.*`, [tenantId ?? null, randomUUID()]);
  return result.rows[0] ? project(result.rows[0]) : null;
}

export type JobResult = { status: "complete" } | { status: "waiting"; code: string; delaySeconds?: number } | { status: "needs_attention"; code: string };
const retrySeconds = [2, 5, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 3600];
export async function finishJob(job: Job, result: JobResult, client: Pick<PoolClient, "query"> = pool): Promise<boolean> {
  const exhausted = result.status === "waiting" && job.attempts >= job.maxAttempts;
  const state = exhausted ? "needs_attention" : result.status;
  const delay = result.status === "waiting" ? Math.max(1, Math.min(3600, result.delaySeconds ?? retrySeconds[Math.min(job.attempts - 1, retrySeconds.length - 1)]!)) : 0;
  const code = exhausted ? "ATTEMPT_LIMIT" : result.status === "complete" ? null : result.code;
  if (code && !/^[A-Z0-9_]{1,80}$/.test(code)) throw new Error("Job errors must be safe codes, never provider payloads");
  const changed = await client.query(`UPDATE on_jobs SET status=$4,run_after=now()+($5*interval '1 second'),last_code=$6,
    lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status='running' AND lease_id=$3 AND lease_until>now()`,
  [job.id, job.tenantId, job.leaseId, state, delay, code]);
  return changed.rowCount === 1;
}

export async function listJobs(tenantId: string): Promise<Job[]> {
  await migrate();
  return (await pool.query<JobRow>("SELECT * FROM on_jobs WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 160", [tenantId])).rows.map(project);
}

/** Explicit user retry wakes work; timer retries never extend the original financial authority. */
export async function wakePaymentJob(tenantId: string, intentId: string) {
  await pool.query(`UPDATE on_jobs SET status='queued',run_after=now()+interval '65 seconds',attempts=0,last_code=NULL,updated_at=now()
    WHERE tenant_id=$1 AND kind='payment_reconcile' AND semantic_key=$2 AND status<>'running'`, [tenantId, intentId]);
}
