import { DomainError } from "@/domain/contracts";
import { assertSameOrigin, consoleData, errorResponse, requireActor } from "@/server/http";
import { listJobs } from "@/server/jobs";
import { runJobTick } from "@/server/job-runner";
import { getShow, pool } from "@/server/store";
export const runtime = "nodejs";
export const maxDuration = 60;
async function producer(request: Request) {
  const actor = await requireActor(request);
  if (!actor.roles.includes("producer")) throw new DomainError("PRODUCER_REQUIRED", "Only this production’s producer can inspect or resume its financial work.", 403);
  return actor;
}
export async function GET(request: Request) {
  try {
    const actor = await producer(request); const jobs = await listJobs(actor.tenantId);
    const [counts, deliveries] = await Promise.all([
      pool.query<{ status: string; count: number }>("SELECT status,count(*)::int AS count FROM on_jobs WHERE tenant_id=$1 GROUP BY status", [actor.tenantId]),
      pool.query<{ received: number; processed: number }>("SELECT count(*)::int AS received,count(*) FILTER(WHERE status='processed')::int AS processed FROM on_webhook_inbox WHERE tenant_id=$1 AND transport='paypal_https'", [actor.tenantId]),
    ]);
    return Response.json({ jobs: jobs.map(({ id, kind, status, attempts, maxAttempts, runAfter, lastCode, updatedAt }) => ({ id, kind, status, attempts, maxAttempts, runAfter, lastCode, updatedAt })), counts: Object.fromEntries(counts.rows.map(row => [row.status, row.count])), deliveries: deliveries.rows[0], workerConfigured: Boolean(process.env.CRON_SECRET && process.env.CRON_SECRET.length >= 32), webhookConfigured: { venue: Boolean(process.env.PAYPAL_WEBHOOK_ID), brightline: Boolean(process.env.OPENING_NIGHT_SUPPLIER_PAYPAL_WEBHOOK_ID) } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try { assertSameOrigin(request); const actor = await producer(request); const tick = await runJobTick({ tenantId: actor.tenantId }); return Response.json({ ...consoleData(await getShow(actor.tenantId), actor), tick }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return errorResponse(error); }
}
