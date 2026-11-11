import { randomUUID } from "node:crypto";
import type { ProviderResource } from "@fracture/paypal-core";
import { DomainError, type FinancialObservation, type ShowSnapshot } from "@/domain/contracts";
import type { PaymentIntent } from "@/domain/payment-authority";
import { currentActual } from "@/domain/finance";
import { readiness, projectExecutionMilestones } from "./crew/readiness";
import { pool } from "./store";
import { ownedResources, paymentTransaction } from "./payment-store";
import type { DeliveryTransport } from "./payment-webhooks";

type Reader = { read(kind: ProviderResource["kind"], id: string, signal: AbortSignal): Promise<ProviderResource[]> };
/** Fresh direct reads use a database start time, so a slow older read cannot overwrite a newer one. */
export async function observeOwnedPayment(root: PaymentIntent, provider: Reader, signal: AbortSignal, transport: DeliveryTransport = "paypal_https") {
  const owned = await ownedResources(root.tenantId, root.seller, root.id);
  const order = owned.find(r => r.kind === "order");
  if (!order) throw new DomainError("RESOURCE_BINDING_REQUIRED", "The original order is not yet bound to a verified provider response.");
  const timestamp = await pool.query<{ read_at: Date; revision: number }>("SELECT clock_timestamp() AS read_at,revision FROM on_shows WHERE tenant_id=$1", [root.tenantId]);
  const observedAt = timestamp.rows[0]!.read_at.toISOString();
  const orderRead = await provider.read("order", order.id, signal);
  if (!orderRead.some(r => r.kind === "order" && r.id === order.id)) throw new DomainError("PROVIDER_READ_IDENTITY", "The provider returned a different order identity.");
  const observations: FinancialObservation[] = [];
  for (const resource of owned) {
    if (!["order", "authorization", "capture", "refund"].includes(resource.kind)) continue;
    const kind = resource.kind as ProviderResource["kind"];
    const read = kind === "order" ? orderRead : await provider.read(kind, resource.id, signal);
    const exact = read.filter(item => item.kind === kind && item.id === resource.id);
    if (exact.length !== 1 || exact[0]!.source !== "live_sandbox") throw new DomainError("PROVIDER_READ_IDENTITY", "The provider resource identity could not be verified.");
    const value = exact[0]!;
    const observation: FinancialObservation = { id: randomUUID(), seller: root.seller, kind, providerResourceId: resource.id, status: value.status, amountMinor: value.money?.minor ?? null, currency: value.money?.currency ?? null, parentId: value.parentId, observedAt, transport, readRevision: timestamp.rows[0]!.revision };
    if (kind === "capture" && root.purpose === "ticket_order") {
      const refunds = orderRead.filter(item => item.kind === "refund" && !["FAILED", "CANCELLED"].includes(item.status));
      const sum = refunds.reduce((total, refund) => total + (refund.money?.minor ?? 0), 0);
      const completeHistory = orderRead.filter(item => item.kind === "capture").length === 1 && refunds.every(item => item.status === "COMPLETED" && item.money?.currency === "USD") &&
        (value.status === "COMPLETED" && sum === 0 || value.status === "PARTIALLY_REFUNDED" && sum > 0 && sum < (value.money?.minor ?? 0) || value.status === "REFUNDED" && sum === value.money?.minor);
      observation.refundedMinor = completeHistory ? sum : null;
    }
    observations.push(observation);
  }
  await recordPaymentObservations(root, observations);
  return observations;
}

export async function recordPaymentObservations(root: PaymentIntent, observations: FinancialObservation[]) {
  await paymentTransaction(async client => {
    const result = await client.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR UPDATE", [root.tenantId]);
    const show = result.rows[0]?.snapshot; if (!show) throw new DomainError("SHOW_NOT_FOUND", "The production no longer exists.", 404);
    const owned = await ownedResources(root.tenantId, root.seller, root.id, client);
    const before = new Set(currentActual(show).map(item => item.id));
    const current = show.financialObservations ?? [];
    let changed = false;
    for (const observation of observations) {
      if (observation.seller !== root.seller || !owned.some(item => item.kind === observation.kind && item.id === observation.providerResourceId) || !Number.isFinite(Date.parse(observation.observedAt))) throw new DomainError("OBSERVATION_OWNERSHIP", "A provider observation is outside this payment’s owned set.", 403);
      await client.query(`INSERT INTO on_resource_observations(id,tenant_id,seller,root_intent_id,kind,provider_id,status,amount_minor,currency,parent_id,refunded_minor,observed_at,transport)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`, [observation.id, root.tenantId, root.seller, root.id, observation.kind, observation.providerResourceId, observation.status, observation.amountMinor, observation.currency, observation.parentId, observation.refundedMinor ?? null, observation.observedAt, observation.transport]);
      // Fixtures are auditable but never replace a real current-resource read.
      const index = current.findIndex(item => item.seller === observation.seller && item.kind === observation.kind && item.providerResourceId === observation.providerResourceId && item.transport === observation.transport);
      const old = current[index];
      if (old && Date.parse(old.observedAt) >= Date.parse(observation.observedAt)) continue;
      if (index < 0) current.push(observation); else current[index] = observation;
      changed = true;
    }
    if (!changed) return;
    show.financialObservations = current;
    for (const check of show.financialChecks ?? []) {
      if (check.status !== "pending" || check.seller !== root.seller) continue;
      const related = check.resources.filter(resource => owned.some(binding => binding.kind === resource.kind && binding.id === resource.id));
      if (related.length && related.every(resource => observations.some(read => read.transport === check.transport && read.kind === resource.kind && read.providerResourceId === resource.id && (read.readRevision ?? 0) >= check.revision && Date.parse(read.observedAt) >= Date.parse(check.receivedAt)))) { check.status = "resolved"; check.resolvedAt = new Date().toISOString(); }
    }
    const after = new Set(currentActual(show).map(item => item.id));
    const withdrawn = [...before].some(id => !after.has(id));
    const now = new Date().toISOString(); show.revision++; show.updatedAt = now;
    const event = { id: randomUUID(), type: withdrawn ? "payment.readiness_withdrawn" : "payment.resources_observed", message: withdrawn ? "A fresh provider read changed financial readiness. Historical receipts are preserved; review the current resource status." : "Read the owned payment resources and refreshed current financial evidence.", at: now, fixtureAt: show.clock, actorId: "worker:payment-observer", source: observations.every(item => item.transport === "paypal_https") ? "live_sandbox" as const : "sample" as const, revision: show.revision };
    show.events.push(event);
    if (show.state !== "standby" && !readiness(show, "DOORS").ready) { show.state = "standby"; show.goReportId = null; }
    await client.query("UPDATE on_shows SET snapshot=$2,revision=$3,updated_at=now() WHERE tenant_id=$1", [root.tenantId, projectExecutionMilestones(show), show.revision]);
    await client.query("INSERT INTO on_events(id,tenant_id,revision,event) VALUES($1,$2,$3,$4)", [event.id, root.tenantId, show.revision, event]);
  });
}
