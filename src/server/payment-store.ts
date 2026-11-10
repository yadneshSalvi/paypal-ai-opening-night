import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { SqlPaymentStore, type PaymentOperation, type SqlDatabase, type SqlConnection } from "@fracture/paypal-core";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { evidenceForOperation, type PaymentIntent, type PaymentSeller } from "@/domain/payment-authority";
import { readiness } from "@/domain/readiness";
import { migrate, pool } from "./store";

const shared = globalThis as typeof globalThis & { openingNightPayments?: Promise<SqlPaymentStore> };
const connection = (client: Pick<PoolClient, "query">): SqlConnection => ({ dialect: "postgres", query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => { const result = await client.query<T>(sql, params); return { rows: result.rows, rowCount: result.rowCount ?? 0 }; } });
export const paymentDatabase: SqlDatabase = {
  ...connection(pool),
  transaction: async work => paymentTransaction(client => work(connection(client))),
  close: async () => { /* The shared application pool owns its lifecycle. */ },
};
export async function paymentTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function paymentStore() {
  if (!shared.openingNightPayments) shared.openingNightPayments = (async () => {
    await migrate();
    await paymentTransaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(4105002)");
      await client.query(`
        CREATE TABLE IF NOT EXISTS on_payment_intents (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE, seller text NOT NULL CHECK(seller IN ('venue','brightline')), semantic_key text NOT NULL, document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,semantic_key));
        CREATE TABLE IF NOT EXISTS on_payment_bindings (seller text NOT NULL, kind text NOT NULL, provider_id text NOT NULL, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE, root_intent_id uuid NOT NULL REFERENCES on_payment_intents(id), PRIMARY KEY(seller,kind,provider_id));
        CREATE TABLE IF NOT EXISTS on_payment_imports (tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE, operation_id text NOT NULL, receipt_hash text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,operation_id,receipt_hash));
        CREATE INDEX IF NOT EXISTS on_payment_intents_tenant ON on_payment_intents(tenant_id);
        CREATE INDEX IF NOT EXISTS on_payment_bindings_root ON on_payment_bindings(tenant_id,root_intent_id);
      `);
    });
    const store = new SqlPaymentStore(paymentDatabase); await store.initialize(); return store;
  })().catch(error => { delete shared.openingNightPayments; throw error; });
  return shared.openingNightPayments;
}
export async function readIntent(tenantId: string, id: string, client: Pick<PoolClient, "query"> = pool): Promise<PaymentIntent> {
  const result = await client.query<{ document: PaymentIntent }>("SELECT document FROM on_payment_intents WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
  if (!result.rows[0]) throw new DomainError("PAYMENT_NOT_FOUND", "This payment does not belong to the current rehearsal.", 404);
  return result.rows[0].document;
}
export async function listIntents(tenantId: string) {
  await paymentStore(); const result = await pool.query<{ document: PaymentIntent }>("SELECT document FROM on_payment_intents WHERE tenant_id=$1 ORDER BY created_at,id", [tenantId]); return result.rows.map(r => r.document);
}
export async function ownedResources(tenantId: string, seller: PaymentSeller, rootId: string, client: Pick<PoolClient, "query"> = pool) {
  const result = await client.query<{ kind: string; provider_id: string }>("SELECT kind,provider_id FROM on_payment_bindings WHERE tenant_id=$1 AND seller=$2 AND root_intent_id=$3", [tenantId, seller, rootId]);
  return result.rows.map(r => ({ kind: r.kind, id: r.provider_id }));
}

export async function importPaymentOperation(intent: PaymentIntent, operation: PaymentOperation) {
  const receipt = operation.receipt;
  if (!receipt || receipt.source !== "live_sandbox" || operation.status !== "succeeded") return;
  await paymentTransaction(async client => {
    const result = await client.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR UPDATE", [intent.tenantId]);
    const show = result.rows[0]?.snapshot; if (!show) throw new DomainError("SHOW_NOT_FOUND", "The production could not be found.", 404);
    const imported = await client.query("INSERT INTO on_payment_imports(tenant_id,operation_id,receipt_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING operation_id", [intent.tenantId, operation.command.operationId, receipt.bodyHash]);
    if (!imported.rowCount) return;
    const rootId = intent.parentId ?? intent.id;
    for (const resource of receipt.resources) {
      await client.query("INSERT INTO on_payment_bindings(seller,kind,provider_id,tenant_id,root_intent_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [intent.seller, resource.kind, resource.id, intent.tenantId, rootId]);
      const binding = await client.query<{ tenant_id: string; root_intent_id: string }>("SELECT tenant_id,root_intent_id FROM on_payment_bindings WHERE seller=$1 AND kind=$2 AND provider_id=$3", [intent.seller, resource.kind, resource.id]);
      if (binding.rows[0]?.tenant_id !== intent.tenantId || binding.rows[0]?.root_intent_id !== rootId) throw new DomainError("PROVIDER_OWNERSHIP_CONFLICT", "The provider receipt conflicts with an existing resource owner.", 409);
    }
    const evidence = evidenceForOperation(intent, operation).filter(item => !show.financialEvidence.some(existing => existing.id === item.id));
    show.financialEvidence.push(...evidence);
    for (const item of evidence) {
      if (item.purpose === "ticket" && item.ticketId && intent.tier) {
        const existing = show.tickets.find(t => t.id === item.ticketId);
        if (existing && existing.captureId && existing.captureId !== item.providerResourceId) throw new DomainError("TICKET_CAPTURE_CONFLICT", "This ticket already has a different verified capture.");
        if (!existing) show.tickets.push({ id: item.ticketId, tier: intent.tier, admissionMinor: 3500, perkMinor: intent.tier === "vip" ? 1500 : 0, captureId: item.providerResourceId, source: "live_sandbox", refundedMinor: 0, status: "captured" });
        else { existing.captureId = item.providerResourceId; existing.source = "live_sandbox"; existing.status = "captured"; }
      }
      if (item.purpose === "vip_remedy" && item.ticketId) {
        const ticket = show.tickets.find(t => t.id === item.ticketId);
        if (ticket) { ticket.refundedMinor = show.financialEvidence.filter(e => e.ticketId === ticket.id && e.kind === "refund" && e.verified && e.status === "completed").reduce((sum, e) => sum + e.amountMinor, 0); ticket.status = "partially_refunded"; }
      }
    }
    const now = new Date().toISOString();
    show.revision++; show.updatedAt = now;
    const event = { id: randomUUID(), type: "payment." + intent.purpose + ".confirmed", message: evidence.length ? "Verified PayPal sandbox " + intent.purpose.replaceAll("_", " ") + " receipt. Operational and crew evidence remain separate." : "PayPal sandbox order created. Buyer approval and money movement remain separate steps.", at: now, fixtureAt: show.clock, actorId: intent.approvedBy, source: "live_sandbox" as const, revision: show.revision };
    show.events.push(event);
    if (show.state !== "standby" && !readiness(show, "DOORS").ready) { show.state = "standby"; show.goReportId = null; }
    await client.query("UPDATE on_shows SET snapshot=$2,revision=$3,updated_at=now() WHERE tenant_id=$1", [intent.tenantId, show, show.revision]);
    await client.query("INSERT INTO on_events(id,tenant_id,revision,event) VALUES($1,$2,$3,$4)", [event.id, intent.tenantId, show.revision, event]);
  });
}
