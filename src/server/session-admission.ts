import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError } from "@/domain/contracts";

export const SESSION_ADMISSION_SCOPE = "opening-night:new-rehearsals:v1";
export const SESSION_CREATION_LIMITS = Object.freeze({ perHour: 30, perDay: 200 });

export class SessionCreationLimitError extends DomainError {
  constructor(readonly retryAfterSeconds: number) {
    super("SESSION_CREATION_LIMIT", "New rehearsals are temporarily at capacity. Existing rehearsals remain available. Please try again later.", 429);
  }
}

/** The caller must commit this reservation in the same transaction as the new show. */
export async function claimSessionAdmission(client: PoolClient, scope = SESSION_ADMISSION_SCOPE) {
  // All app instances serialize this small check using the same database lock.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4105002))", [scope]);
  const time = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  const now = time.rows[0]!.now;
  await client.query("DELETE FROM on_session_admissions WHERE scope=$1 AND created_at<=$2::timestamptz-interval '1 day'", [scope, now]);
  const result = await client.query<{
    hourly: number;
    daily: number;
    oldest_hour: Date | null;
    oldest_day: Date | null;
  }>(`
    SELECT count(*) FILTER (WHERE created_at>$2::timestamptz-interval '1 hour')::int AS hourly,
           count(*)::int AS daily,
           min(created_at) FILTER (WHERE created_at>$2::timestamptz-interval '1 hour') AS oldest_hour,
           min(created_at) AS oldest_day
    FROM on_session_admissions WHERE scope=$1
  `, [scope, now]);
  const counts = result.rows[0]!;
  const waits: number[] = [];
  if (counts.hourly >= SESSION_CREATION_LIMITS.perHour) waits.push(counts.oldest_hour!.getTime() + 3_600_000 - now.getTime());
  if (counts.daily >= SESSION_CREATION_LIMITS.perDay) waits.push(counts.oldest_day!.getTime() + 86_400_000 - now.getTime());
  if (waits.length) throw new SessionCreationLimitError(Math.max(1, Math.ceil(Math.max(...waits) / 1000)));
  await client.query("INSERT INTO on_session_admissions(id,scope,created_at) VALUES($1,$2,$3)", [randomUUID(), scope, now]);
}
