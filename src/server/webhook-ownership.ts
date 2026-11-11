import type { PoolClient } from "pg";
import type { ProviderResource } from "@fracture/paypal-core";
import { z } from "zod";
import type { PaymentIntent, PaymentSeller } from "@/domain/payment-authority";
import type { PaymentWebhook } from "./payment-webhooks";
import { enqueueJob } from "./jobs";
import { requestFinancialCheck } from "./payment-checks";
import type { DeliveryTransport } from "./payment-webhooks";

export async function lockWebhookOwnership(client: Pick<PoolClient, "query">, seller: PaymentSeller) {
  // Take this before a show row lock. Receipt imports and intake then have one consistent order.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,4105003))", ["opening-night:webhook-ownership:" + seller]);
}

export async function resolveWebhookOwner(client: Pick<PoolClient, "query">, seller: PaymentSeller, event: PaymentWebhook) {
  const bound = await client.query<{ tenant_id: string; root_intent_id: string }>(`SELECT DISTINCT binding.tenant_id,binding.root_intent_id
    FROM on_payment_bindings AS binding JOIN jsonb_to_recordset($2::jsonb) AS hint(kind text,id text)
    ON binding.kind=hint.kind AND binding.provider_id=hint.id WHERE binding.seller=$1`, [seller, JSON.stringify(event.resources)]);
  const ids = event.customIds.map(id => id.replace(/^on:/, "")).filter(id => z.uuid().safeParse(id).success);
  const matching = ids.length ? await client.query<{ document: PaymentIntent }>("SELECT document FROM on_payment_intents WHERE seller=$1 AND id=ANY($2::uuid[])", [seller, ids]) : { rows: [] };
  const owners = new Map(bound.rows.map(row => [row.tenant_id + ":" + row.root_intent_id, { tenantId: row.tenant_id, rootIntentId: row.root_intent_id }]));
  for (const { document: intent } of matching.rows) {
    const customId = intent.command.action.kind === "create_order" ? intent.command.action.customId : intent.command.action.kind === "refund_capture" ? intent.command.operationId : null;
    if (customId && event.customIds.includes(customId)) owners.set(intent.tenantId + ":" + (intent.parentId ?? intent.id), { tenantId: intent.tenantId, rootIntentId: intent.parentId ?? intent.id });
  }
  return { owner: owners.size === 1 ? [...owners.values()][0]! : null, conflict: owners.size > 1 };
}

/** A verified receipt can arrive after its webhook. Rebind only through newly persisted ownership. */
export async function bindWaitingWebhooks(client: PoolClient, intent: PaymentIntent, resources: ProviderResource[]) {
  const waiting = await client.query<{ event_id: string; hints: PaymentWebhook; transport: DeliveryTransport }>(`SELECT event_id,hints,transport FROM on_webhook_inbox
    WHERE seller=$1 AND status='unmatched' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(hints->'resources') AS hint
      JOIN jsonb_to_recordset($2::jsonb) AS owned(kind text,id text) ON hint->>'kind'=owned.kind AND hint->>'id'=owned.id
    ) ORDER BY received_at,event_id FOR UPDATE SKIP LOCKED LIMIT 100`, [intent.seller, JSON.stringify(resources.map(({ kind, id }) => ({ kind, id })))]);
  for (const row of waiting.rows) {
    const { owner, conflict } = await resolveWebhookOwner(client, intent.seller, row.hints);
    if (conflict) { await client.query("UPDATE on_webhook_inbox SET status='conflict',last_code='OWNERSHIP_CONFLICT' WHERE seller=$1 AND event_id=$2", [intent.seller, row.event_id]); continue; }
    if (!owner || owner.tenantId !== intent.tenantId || owner.rootIntentId !== (intent.parentId ?? intent.id)) continue;
    await client.query("UPDATE on_webhook_inbox SET tenant_id=$3,root_intent_id=$4,status='queued',last_code=NULL WHERE seller=$1 AND event_id=$2", [intent.seller, row.event_id, owner.tenantId, owner.rootIntentId]);
    await requestFinancialCheck(client, owner.tenantId, intent.seller, row.hints, row.transport);
    await enqueueJob(client, { tenantId: owner.tenantId, kind: "webhook_reconcile", semanticKey: intent.seller + ":" + row.event_id, payload: { seller: intent.seller, eventId: row.event_id, rootIntentId: owner.rootIntentId } });
  }
}
