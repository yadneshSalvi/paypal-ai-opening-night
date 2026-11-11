import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import { DomainError } from "@/domain/contracts";
import { env } from "./env";

const shared = globalThis as typeof globalThis & { openingNightCommerceLocks?: Pool };
interface Lease { active: boolean; lost: boolean }
const heldLocks = new AsyncLocalStorage<ReadonlyMap<string, Lease>>();
/** The lock owns a direct connection; network work uses the separate application query pool. */
function lockPool() {
  return shared.openingNightCommerceLocks ??= new Pool({ connectionString: env.commerceLockDatabaseUrl,
    application_name: "opening-night-commerce-lock", max: 2, connectionTimeoutMillis: 6000, idleTimeoutMillis: 15000 });
}
export async function withCommerceLock<T>(scope: string, work: () => Promise<T>): Promise<T> {
  const inherited = heldLocks.getStore()?.get(scope);
  if (inherited?.lost) throw new DomainError("COMMERCE_LOCK_LOST", "The work connection was interrupted. Reconcile its saved instruction before continuing.", 503);
  if (inherited?.active) return work();
  const client = await lockPool().connect(), lease: Lease = { active: false, lost: false };
  let began = false, failed = false;
  const lost = () => { lease.lost = true; };
  client.on("error", lost);
  try {
    // Transaction locks disappear on rollback/disconnect, even if an intermediary ever routes this connection.
    await client.query("BEGIN READ ONLY"); began = true;
    await client.query("SET LOCAL idle_in_transaction_session_timeout='90s'");
    const result = await client.query<{ held: boolean; backend: number }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,4105004)) AS held,pg_backend_pid() AS backend", [scope]);
    if (!result.rows[0]?.held) throw new DomainError("COMMERCE_WORK_ACTIVE", "The current instruction is still finishing. Its result will be checked before another starts.", 503);
    lease.active = true;
    const value = await heldLocks.run(new Map([...(heldLocks.getStore() ?? []), [scope, lease]]), work);
    const final = await client.query<{ backend: number }>("SELECT pg_backend_pid() AS backend");
    if (lease.lost || final.rows[0]?.backend !== result.rows[0].backend) throw new DomainError("COMMERCE_LOCK_LOST", "The work connection changed. Reconcile its saved instruction before continuing.", 503);
    return value;
  } catch (error) { failed = true; throw error; }
  finally {
    lease.active = false;
    try { if (began) await client.query("ROLLBACK"); }
    catch { if (!failed) throw new DomainError("COMMERCE_LOCK_RELEASE_UNCONFIRMED", "The saved work needs reconciliation after its connection closed.", 503); }
    finally { client.removeListener("error", lost); client.release(true); }
  }
}
/** Used by disposable-schema tests; production reuses its bounded process pool. */
export async function closeCommerceLocks() { if (shared.openingNightCommerceLocks) { const instance = shared.openingNightCommerceLocks; delete shared.openingNightCommerceLocks; await instance.end(); } }
