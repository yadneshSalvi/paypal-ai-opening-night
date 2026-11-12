/**
 * Tenant-scoped payment-provider selection for guided demonstrations.
 *
 * A demonstration tenant never reaches PayPal:
 * 1. Inside `withTenantProviderScope` (the director and the durable job
 *    worker), the `providers` getter returns the installed SDK bound to an
 *    in-process replay transport for that one tenant. Nothing is patched
 *    globally, so a live-sandbox tenant served by the same instance keeps its
 *    actual provider.
 * 2. Outside a scope, the actual provider's transport refuses any request that
 *    names a replayed resource or whose durable operation belongs to a
 *    demonstration tenant, before anything is sent.
 * A tenant is a demonstration only if it was created as one; that fact is
 * immutable, so both answers are cached per process.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { SandboxPayPalProvider } from "@fracture/paypal-core";
import { DomainError } from "@/domain/contracts";
import type { PaymentSeller } from "@/domain/payment-authority";
import { REPLAY_ID_MARKER, REPLAY_ORIGIN, ReplayWire } from "./wire";

export interface ReplayScope { tenantId: string; wire: ReplayWire; providers: Partial<Record<PaymentSeller, SandboxPayPalProvider>> }
const shared = globalThis as typeof globalThis & {
  openingNightReplayScope?: AsyncLocalStorage<ReplayScope>;
  openingNightDemonstrationTenants?: Map<string, boolean>;
  openingNightProviderEgress?: { replayed: number; forwarded: number; refused: number };
};
const storage = shared.openingNightReplayScope ??= new AsyncLocalStorage<ReplayScope>();
const known = shared.openingNightDemonstrationTenants ??= new Map<string, boolean>();
/** Process-local counters for diagnostics and tests. `forwarded` counts requests handed to the network transport. */
export const providerEgress = shared.openingNightProviderEgress ??= { replayed: 0, forwarded: 0, refused: 0 };

const database = async () => (await import("../store")).pool;
export class DemonstrationProviderError extends DomainError {
  constructor() { super("DEMONSTRATION_REPLAY_ONLY", "This guided demonstration replays its payment outcomes. No PayPal request is made for it; continue from the demonstration guide.", 409); }
}

export function currentReplayScope() { return storage.getStore(); }
export async function isDemonstrationTenant(tenantId: string): Promise<boolean> {
  const cached = known.get(tenantId); if (cached !== undefined) return cached;
  const pool = await database(); await (await import("../store")).migrate();
  const row = (await pool.query<{ demonstration: boolean; found: boolean }>(`SELECT EXISTS(SELECT 1 FROM on_judge_demonstrations WHERE tenant_id=$1)
    OR COALESCE((SELECT snapshot ? 'demonstration' FROM on_shows WHERE tenant_id=$1), false) AS demonstration, EXISTS(SELECT 1 FROM on_shows WHERE tenant_id=$1) AS found`, [tenantId])).rows[0]!;
  // An unknown tenant is not cached: a rehearsal and its marker are created in one transaction.
  if (row.found) { if (known.size > 20000) known.clear(); known.set(tenantId, row.demonstration); }
  return row.demonstration;
}
/** Used by the creator inside its own transaction, before the row is visible to other connections. */
export function rememberDemonstrationTenant(tenantId: string) { known.set(tenantId, true); }

function replayProvider(scope: ReplayScope, seller: PaymentSeller) {
  return scope.providers[seller] ??= new SandboxPayPalProvider({ environment: "sandbox", baseUrl: REPLAY_ORIGIN, isolatedProject: "guided-demonstration-replay", clientId: "guided-demonstration-replay-" + seller, clientSecret: "no-credential-replay-transport" }, async (input, init) => { providerEgress.replayed++; return scope.wire.fetch(input, init); });
}
/** The `providers` getter asks this first. Undefined means: not a demonstration scope. */
export function replayProviderFor(seller: PaymentSeller) { const scope = storage.getStore(); return scope ? replayProvider(scope, seller) : undefined; }

/** Runs work for one tenant. Demonstration tenants get the replay provider; all others run unchanged. */
export async function withTenantProviderScope<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  const active = storage.getStore();
  if (active) { if (active.tenantId !== tenantId) throw new DemonstrationProviderError(); return work(); }
  if (!await isDemonstrationTenant(tenantId)) return work();
  return storage.run({ tenantId, wire: new ReplayWire(tenantId, database), providers: {} }, work);
}
/** The director's entry: refuses to run for anything that was not created as a demonstration. */
export async function withReplayScope<T>(tenantId: string, work: (scope: ReplayScope) => Promise<T>): Promise<T> {
  if (!await isDemonstrationTenant(tenantId)) throw new DomainError("DEMONSTRATION_REQUIRED", "This rehearsal is not a guided demonstration.", 409);
  return withTenantProviderScope(tenantId, () => work(storage.getStore()!));
}

/** For actual-provider features that have no replay (Agent Toolkit reads, invoices, payouts): a demonstration tenant is refused before any request is built. */
export async function assertActualProviderTenant(tenantId: string) { if (storage.getStore() || await isDemonstrationTenant(tenantId)) throw new DemonstrationProviderError(); }

async function requestOwnedByDemonstration(requestId: string) {
  const pool = await database();
  for (const sql of ["SELECT tenant_id::text AS tenant_id FROM paycore_operations WHERE provider_request_id=$1", "SELECT tenant_id::text AS tenant_id FROM on_wallet_operations WHERE request_id::text=$1"]) {
    let rows: { tenant_id: string }[];
    try { rows = (await pool.query<{ tenant_id: string }>(sql, [requestId])).rows; }
    catch (error) { if ((error as { code?: string }).code === "42P01") continue; throw error; }
    for (const row of rows) if (await isDemonstrationTenant(row.tenant_id)) return true;
  }
  return false;
}
/**
 * Transport of the ACTUAL sandbox providers. It forwards to the network
 * unchanged unless the request belongs to a demonstration, which fails closed.
 */
export const liveProviderFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  let refuse = Boolean(storage.getStore()) || url.includes(REPLAY_ID_MARKER);
  if (!refuse && method !== "GET" && !url.endsWith("/v1/oauth2/token")) {
    const requestId = new Headers(init?.headers).get("PayPal-Request-Id") ?? (input instanceof Request ? input.headers.get("PayPal-Request-Id") : null);
    if (requestId) refuse = await requestOwnedByDemonstration(requestId);
  }
  if (refuse) { providerEgress.refused++; throw new DemonstrationProviderError(); }
  providerEgress.forwarded++;
  return fetch(input, init);
};
