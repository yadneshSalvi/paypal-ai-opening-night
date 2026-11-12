/**
 * Live, read-only proof for judges: GET a small fixed sample (at most three)
 * of this deployment's RETAINED original sandbox captures/refunds from PayPal.
 * The sample comes from ordinary rehearsals only, never a demonstration.
 * Globally rate limited through one database row; identifiers are redacted and
 * nothing else about the owning rehearsal is returned.
 */
import { JUDGE_LIVE_READ_LABEL, type JudgeLiveRead, type JudgeLiveReadItem } from "@/domain/judge/contracts";
import { migrate, pool } from "../store";
import { currentReplayScope } from "./scope";

const WINDOW_MINUTES = 10, SAMPLE = 3;
type Candidate = { kind: "capture" | "refund"; provider_id: string; amount_minor: number; recorded_at: string };
const redact = (id: string) => "••••" + id.slice(-6);
const result = (value: Partial<JudgeLiveRead>): JudgeLiveRead => ({ version: 1, label: JUDGE_LIVE_READ_LABEL, status: "unavailable", readAt: null, nextReadAfter: null, cached: false, items: [], ...value });

export async function readRetainedEvidence(): Promise<JudgeLiveRead> {
  // Never from inside a replay scope: this is the one deliberate actual-provider read.
  if (currentReplayScope()) return result({ reason: "A demonstration step cannot perform the live read." });
  await migrate();
  // One visitor per window claims the read; everyone else gets its stored result.
  const claim = await pool.query<{ read_at: Date }>(`INSERT INTO on_judge_live_reads(id,result,read_at) VALUES('retained-sandbox-evidence','{"state":"reading"}',clock_timestamp())
    ON CONFLICT(id) DO UPDATE SET result=EXCLUDED.result,read_at=EXCLUDED.read_at WHERE on_judge_live_reads.read_at<=clock_timestamp()-($1*interval '1 minute') RETURNING read_at`, [WINDOW_MINUTES]);
  if (!claim.rows[0]) {
    const saved = (await pool.query<{ result: JudgeLiveRead | { state: "reading" }; read_at: Date }>("SELECT result,read_at FROM on_judge_live_reads WHERE id='retained-sandbox-evidence'")).rows[0]!;
    const next = new Date(saved.read_at.getTime() + WINDOW_MINUTES * 60_000).toISOString();
    if ("state" in saved.result) return result({ reason: "A live read is in progress or did not finish. Another can be made after the shown time.", nextReadAfter: next });
    return { ...saved.result, cached: true, nextReadAfter: next };
  }
  const readAt = claim.rows[0].read_at, next = new Date(readAt.getTime() + WINDOW_MINUTES * 60_000).toISOString();
  let value: JudgeLiveRead;
  try {
    // Venue ticket captures and their refunds, recorded as verified actual sandbox receipts by ordinary rehearsals.
    const candidates = (await pool.query<Candidate>(`SELECT kind,provider_id,amount_minor,recorded_at FROM (
        SELECT DISTINCT ON (entry->>'providerResourceId') entry->>'kind' AS kind,entry->>'providerResourceId' AS provider_id,(entry->>'amountMinor')::int AS amount_minor,entry->>'recordedAt' AS recorded_at
        FROM on_shows show CROSS JOIN LATERAL jsonb_array_elements(show.snapshot->'financialEvidence') AS entry
        WHERE NOT (show.snapshot ? 'demonstration') AND NOT EXISTS (SELECT 1 FROM on_judge_demonstrations d WHERE d.tenant_id=show.tenant_id)
          AND entry->>'source'='live_sandbox' AND entry->>'verified'='true' AND entry->>'status'='completed' AND entry->>'provenance' IS DISTINCT FROM 'replay'
          AND entry->>'kind' IN ('capture','refund') AND entry->>'purpose' IN ('ticket','vip_remedy') AND entry->>'providerResourceId' ~ '^[A-Z0-9]{17}$'
          AND EXISTS (SELECT 1 FROM on_payment_bindings bound WHERE bound.seller='venue' AND bound.kind=entry->>'kind' AND bound.provider_id=entry->>'providerResourceId' AND bound.tenant_id=show.tenant_id)
      ) retained ORDER BY (kind='refund') DESC,recorded_at DESC LIMIT 40`)).rows;
    const sample = [...candidates.filter(row => row.kind === "refund").slice(0, 1), ...candidates.filter(row => row.kind === "capture")].slice(0, SAMPLE);
    if (!sample.length) value = result({ reason: "This database holds no retained original sandbox captures or refunds to read.", readAt: readAt.toISOString(), nextReadAfter: next });
    else {
      const { providers } = await import("../paypal-providers"), items: JudgeLiveReadItem[] = [];
      for (const row of sample) {
        let status: string | null = null, amountMinor: number | null = null, currency: string | null = null;
        try {
          const read = (await providers.venue.read(row.kind, row.provider_id, AbortSignal.timeout(12_000))).find(resource => resource.kind === row.kind && resource.id === row.provider_id);
          if (read) { status = read.status; amountMinor = read.money?.minor ?? null; currency = read.money?.currency ?? null; }
        } catch { /* A failed read is reported as unread; no provider detail is returned. */ }
        items.push({ kind: row.kind, reference: redact(row.provider_id), status, amountMinor, currency, recordedAt: row.recorded_at, matchesRetainedRecord: status !== null && amountMinor === row.amount_minor && currency === "USD" });
      }
      const read = items.filter(item => item.status !== null).length;
      value = result({ status: read === items.length ? "verified" : read ? "partial" : "unavailable", ...(read ? {} : { reason: "PayPal sandbox could not be read just now." }), readAt: readAt.toISOString(), nextReadAfter: next, items });
    }
  } catch { value = result({ reason: "The retained evidence could not be read just now.", readAt: readAt.toISOString(), nextReadAfter: next }); }
  await pool.query("UPDATE on_judge_live_reads SET result=$1 WHERE id='retained-sandbox-evidence' AND result->>'state'='reading'", [JSON.stringify(value)]);
  return value;
}
