import { createHash, randomUUID } from "node:crypto";
import { PayPalWebhookVerifier, PaymentError, type ProviderResource, type WebhookVerifier } from "@fracture/paypal-core";
import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import type { PaymentSeller } from "@/domain/payment-authority";
import { merchantConfig } from "./payment-config";
import { paymentStore, paymentTransaction } from "./payment-store";
import { enqueueJob } from "./jobs";
import { lockWebhookOwnership, resolveWebhookOwner } from "./webhook-ownership";
import { requestFinancialCheck } from "./payment-checks";

export const paymentEventTypes = new Set([
  "PAYMENT.AUTHORIZATION.CREATED", "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DECLINED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.REFUND.PENDING", "PAYMENT.REFUND.FAILED", "CHECKOUT.ORDER.APPROVED", "CHECKOUT.ORDER.COMPLETED", "CHECKOUT.PAYMENT-APPROVAL.REVERSED",
]);
export type DeliveryTransport = "paypal_https" | "local_fixture";
type ResourceHint = { kind: ProviderResource["kind"]; id: string };
export interface PaymentWebhook {
  id: string; type: string; resourceId: string; resourceKind: ProviderResource["kind"];
  resources: ResourceHint[]; customIds: string[];
}
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$/);
const eventSchema = z.object({ id: identifier, event_type: z.string().min(1).max(100), resource_type: z.string().max(60).optional(), resource: z.object({ id: identifier }).passthrough() });
const kindNames: Record<string, ProviderResource["kind"]> = { "checkout-order": "order", order: "order", authorization: "authorization", capture: "capture", refund: "refund" };
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function parsePaymentWebhook(raw: string): PaymentWebhook | null {
  let json: unknown; try { json = JSON.parse(raw); } catch { return null; }
  const parsed = eventSchema.safeParse(json); if (!parsed.success || !paymentEventTypes.has(parsed.data.event_type)) return null;
  const data = parsed.data; const resource = data.resource;
  const inferred = data.event_type.startsWith("CHECKOUT.") ? "order" : data.event_type.startsWith("PAYMENT.AUTHORIZATION.") ? "authorization" : data.event_type.startsWith("PAYMENT.REFUND.") ? "refund" : "capture";
  const resourceKind = data.resource_type ? kindNames[data.resource_type] : inferred;
  if (!resourceKind || resourceKind !== inferred && !(data.event_type === "PAYMENT.CAPTURE.REFUNDED" && resourceKind === "refund")) return null;
  const resources: ResourceHint[] = [{ kind: resourceKind, id: resource.id }];
  const related = object(object(resource.supplementary_data).related_ids);
  for (const kind of ["order", "authorization", "capture", "refund"] as const) {
    const id = related[kind + "_id"]; if (typeof id === "string" && identifier.safeParse(id).success) resources.push({ kind, id });
  }
  const customIds = [resource.custom_id, ...(Array.isArray(resource.purchase_units) ? resource.purchase_units.slice(0, 10).map(unit => object(unit).custom_id) : [])].filter((id): id is string => typeof id === "string" && id.length <= 128);
  return { id: data.id, type: data.event_type, resourceId: resource.id, resourceKind, resources, customIds };
}

const verifiers: Partial<Record<PaymentSeller, PayPalWebhookVerifier>> = {};
function verifierFor(seller: PaymentSeller) {
  if (verifiers[seller]) return verifiers[seller]!;
  const webhookId = process.env[seller === "venue" ? "PAYPAL_WEBHOOK_ID" : "OPENING_NIGHT_SUPPLIER_PAYPAL_WEBHOOK_ID"];
  if (!webhookId) throw new DomainError("REGISTERED_WEBHOOK_REQUIRED", "This merchant’s signed delivery endpoint is not registered yet.", 503);
  return verifiers[seller] = new PayPalWebhookVerifier(merchantConfig(seller), webhookId);
}

export async function readWebhookBody(request: Request) {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > 1048576)) throw new DomainError("WEBHOOK_TOO_LARGE", "Webhook payload exceeds the intake limit.", 413);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new DomainError("WEBHOOK_CONTENT_TYPE", "A JSON webhook body is required.", 415);
  for (const name of ["paypal-transmission-id", "paypal-transmission-time", "paypal-cert-url", "paypal-auth-algo", "paypal-transmission-sig"]) {
    if ((request.headers.get(name)?.length ?? 0) > 4096) throw new DomainError("WEBHOOK_HEADER_LIMIT", "Webhook verification headers exceed the intake limit.", 400);
  }
  const reader = request.body?.getReader(); if (!reader) throw new DomainError("WEBHOOK_BODY_REQUIRED", "A webhook body is required.", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 1048576) { await reader.cancel(); throw new DomainError("WEBHOOK_TOO_LARGE", "Webhook payload exceeds the intake limit.", 413); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new DomainError("WEBHOOK_ENCODING", "Webhook JSON must use valid UTF-8.", 400); }
}

/** The injection seam is server/test-only. HTTP always uses the real registered verifier. */
export async function ingestPaymentWebhook(seller: PaymentSeller, raw: string, headers: Headers, testBoundary?: { verifier: WebhookVerifier; transport: "local_fixture" }) {
  if (Buffer.byteLength(raw, "utf8") > 1048576) throw new DomainError("WEBHOOK_TOO_LARGE", "Webhook payload exceeds the intake limit.", 413);
  const transport: DeliveryTransport = testBoundary?.transport ?? "paypal_https";
  const verified = await (testBoundary?.verifier ?? verifierFor(seller)).verify(raw, headers);
  const event = parsePaymentWebhook(raw); const bodyHash = createHash("sha256").update(raw).digest("hex");
  const store = await paymentStore();
  const audited = await store.recordWebhook({ id: randomUUID(), scope: { tenantId: "merchant:" + seller, projectId: "opening-night:" + seller }, eventId: event?.id ?? "invalid:" + bodyHash,
    eventType: event?.type ?? "unsupported", resourceId: event?.resourceId ?? "unknown", transmissionId: verified.transmissionId,
    receivedAt: new Date().toISOString(), bodyHash, verified: verified.verified, schemaValid: Boolean(event),
    rejectionReason: !verified.verified ? "signature_rejected" : !event ? "unsupported_or_invalid_event" : null,
    source: transport === "paypal_https" ? "live_sandbox" : "sample", status: !verified.verified ? "rejected" : event ? "queued" : "dead_letter" });
  if (!verified.verified) throw new PaymentError("WEBHOOK_SIGNATURE_REJECTED", "The webhook signature could not be verified.", 400);
  if (audited.conflict) throw new PaymentError("WEBHOOK_PAYLOAD_CONFLICT", "A previously verified event has a different body.", 409);
  if (!event) return { accepted: false, duplicate: audited.duplicate, status: "unsupported" as const };
  return paymentTransaction(async client => {
    // The audit may already exist after a previous request died; the inbox still must be repaired.
    await lockWebhookOwnership(client, seller);
    const { owner, conflict } = await resolveWebhookOwner(client, seller, event);
    const status = conflict ? "conflict" : owner ? "queued" : "unmatched";
    const stored = await client.query<{ body_hash: string; status: string; tenant_id: string | null; root_intent_id: string | null }>(`INSERT INTO on_webhook_inbox(seller,event_id,body_hash,event_type,resource_kind,resource_id,hints,tenant_id,root_intent_id,status,transport)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(seller,event_id) DO UPDATE SET event_id=EXCLUDED.event_id RETURNING body_hash,status,tenant_id,root_intent_id`,
    [seller, event.id, bodyHash, event.type, event.resourceKind, event.resourceId, event, owner?.tenantId ?? null, owner?.rootIntentId ?? null, status, transport]);
    const row = stored.rows[0]!;
    if (row.body_hash !== bodyHash) throw new PaymentError("WEBHOOK_PAYLOAD_CONFLICT", "A previously verified event has a different body.", 409);
    if (row.status === "queued" && row.tenant_id && row.root_intent_id) {
      await requestFinancialCheck(client, row.tenant_id, seller, event, transport);
      await enqueueJob(client, { tenantId: row.tenant_id, kind: "webhook_reconcile", semanticKey: seller + ":" + event.id, payload: { seller, eventId: event.id, rootIntentId: row.root_intent_id } });
    }
    return { accepted: row.status === "queued" || row.status === "processed", duplicate: audited.duplicate, status: row.status };
  });
}
