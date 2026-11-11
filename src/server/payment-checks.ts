import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ShowSnapshot } from "@/domain/contracts";
import type { PaymentSeller } from "@/domain/payment-authority";
import { projectExecutionMilestones } from "@/domain/milestones";
import { readiness } from "@/domain/readiness";
import type { DeliveryTransport, PaymentWebhook } from "./payment-webhooks";

const adverseEvents = new Set(["PAYMENT.AUTHORIZATION.VOIDED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DECLINED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED", "PAYMENT.REFUND.PENDING", "PAYMENT.REFUND.FAILED", "CHECKOUT.PAYMENT-APPROVAL.REVERSED"]);
/** This is a reconciliation requirement, never a claim that the event moved money. */
export async function requestFinancialCheck(client: PoolClient, tenantId: string, seller: PaymentSeller, event: PaymentWebhook, transport: DeliveryTransport) {
  if (!adverseEvents.has(event.type)) return;
  const result = await client.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
  const show = result.rows[0]?.snapshot; if (!show) return;
  const id = seller + ":" + event.id;
  if (show.financialChecks?.some(check => check.id === id)) return;
  const now = new Date().toISOString(); show.revision++; show.updatedAt = now;
  show.financialChecks ??= []; show.financialChecks.push({ id, seller, eventType: event.type, resources: event.resources, status: "pending", receivedAt: now, revision: show.revision, resolvedAt: null, transport });
  const domainEvent = { id: randomUUID(), type: "payment.reconciliation_requested", message: "A verified provider update requires a fresh resource read. Its event payload is not financial proof.", at: now, fixtureAt: show.clock, actorId: "worker:webhook-intake", source: transport === "paypal_https" ? "live_sandbox" as const : "sample" as const, revision: show.revision };
  show.events.push(domainEvent);
  if (show.state !== "standby" && !readiness(show, "DOORS").ready) { show.state = "standby"; show.goReportId = null; }
  await client.query("UPDATE on_shows SET snapshot=$2,revision=$3,updated_at=now() WHERE tenant_id=$1", [tenantId, projectExecutionMilestones(show), show.revision]);
  await client.query("INSERT INTO on_events(id,tenant_id,revision,event) VALUES($1,$2,$3,$4)", [domainEvent.id, tenantId, show.revision, domainEvent]);
}
