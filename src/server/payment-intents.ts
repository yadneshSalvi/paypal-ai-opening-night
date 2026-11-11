import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { payloadHash, type PaymentAction } from "@fracture/paypal-core";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { approvedRental, assertPaymentAuthority, type PaymentIntent, type PaymentPurpose, type PaymentSeller } from "@/domain/payment-authority";
import { currentRentalExecution, type RentalExecution } from "@/domain/supplier-contracts";
import { enqueueJob } from "./jobs";
import { ownedResources, readIntent } from "./payment-store";
import { saveRentalExecution } from "./supplier-storage";

export function currentPaymentRole(actor: Actor, purpose: PaymentPurpose) {
  if (["rental_fee", "rental_release"].includes(purpose)) {
    if (!actor.roles.some(role => ["producer", "supplier"].includes(role))) throw new DomainError("COMMERCIAL_ROLE_REQUIRED", "The producer or supplier must execute this approved rental step.", 403);
    if (!actor.roles.includes("producer") && !(actor.supplierId === "brightline" || actor.id.startsWith("supplier:brightline:"))) throw new DomainError("SUPPLIER_SCOPE_REQUIRED", "Only the selected Brightline supplier can execute its rental step.", 403);
  } else if (!actor.roles.includes("producer")) throw new DomainError("PRODUCER_REQUIRED", "Only the production operator can approve this sandbox payment.", 403);
}
export interface IntentSpec {
  purpose: PaymentPurpose; semanticKey: string; seller: PaymentSeller; parentId?: string; ticketId?: string;
  tier?: "standard" | "vip"; resourceIds?: string[]; expectedRevision?: number;
  approvedExecution?: RentalExecution; runAfter?: Date; build: (id: string, show: ShowSnapshot) => PaymentAction;
}
/** The caller owns the show lock and saves any execution snapshot before committing. No provider call occurs here. */
export async function preparePaymentIntent(client: PoolClient, actor: Actor, spec: IntentSpec, show: ShowSnapshot): Promise<{ intent: PaymentIntent; created: boolean }> {
  currentPaymentRole(actor, spec.purpose);
  const execution = spec.approvedExecution ?? (spec.purpose.startsWith("rental_") ? currentRentalExecution(show) : null);
  const existing = await client.query<{ document: PaymentIntent }>("SELECT document FROM on_payment_intents WHERE tenant_id=$1 AND semantic_key=$2", [actor.tenantId, spec.semanticKey]);
  if (existing.rows[0]) {
    const intent = existing.rows[0].document;
    if (intent.purpose !== spec.purpose || intent.seller !== spec.seller || intent.ticketId !== (spec.ticketId ?? null) || intent.tier !== (spec.tier ?? null) || (intent.executionId ?? null) !== (execution?.id ?? null)) throw new DomainError("PAYMENT_IDENTITY_CONFLICT", "This payment identity already has different approved terms.");
    return { intent, created: false };
  }
  if (spec.expectedRevision !== undefined && show.revision !== spec.expectedRevision) throw new DomainError("STALE_REVISION", "The production changed. Refresh before reviewing this commitment.");
  const id = randomUUID(); const now = new Date().toISOString(); const action = spec.build(id, show);
  const rental = spec.purpose.startsWith("rental_") && spec.purpose !== "rental_cancel" ? approvedRental(show) : null;
  const planVersion = execution?.planVersion ?? show.planVersion; const planDigest = execution?.planDigest ?? show.approvedPlan?.digest ?? null;
  const expiry = spec.purpose === "rental_fee" && execution ? Date.parse(execution.captureConsentAt) + 24 * 60 * 60 * 1000 : Date.now() + 24 * 60 * 60 * 1000;
  if (expiry <= Date.now()) throw new DomainError("CAPTURE_CONSENT_EXPIRED", "The producer's capture consent expired. Review the current rental before authorizing another instruction.");
  const intent: PaymentIntent = {
    id, tenantId: actor.tenantId, seller: spec.seller, purpose: spec.purpose, semanticKey: spec.semanticKey, planVersion, planDigest,
    parentId: spec.parentId ?? null, ticketId: spec.ticketId ?? null, resourceIds: spec.resourceIds ?? [], approvedBy: actor.id, createdAt: now,
    feeMinor: execution?.feeMinor ?? rental?.offer.feeMinor ?? 0, depositMinor: execution?.depositMinor ?? rental?.offer.depositMinor ?? 0, tier: spec.tier ?? null,
    ...(execution ? { executionId: execution.id } : {}),
    command: { scope: { tenantId: actor.tenantId, projectId: "opening-night:" + spec.seller }, operationId: id, businessKey: spec.semanticKey, intentId: id, providerRequestId: randomUUID(), payloadHash: payloadHash(action), action,
      approval: { id: "approval:" + id, version: planVersion, digest: digest({ actorId: actor.id, action, planDigest, ...(execution ? { executionId: execution.id, captureConsentAt: execution.captureConsentAt } : {}) }), expiresAt: new Date(expiry).toISOString() } },
  };
  assertPaymentAuthority(show, intent);
  if (spec.parentId && spec.purpose.startsWith("rental_")) {
    const parent = await readIntent(actor.tenantId, spec.parentId, client);
    if (parent.planVersion !== planVersion || parent.planDigest !== planDigest || parent.executionId !== intent.executionId) throw new DomainError("STALE_RENTAL", "The rental belongs to a different recovery execution.", 403);
  }
  if (spec.parentId) {
    const owned = await ownedResources(actor.tenantId, spec.seller, spec.parentId, client);
    if (intent.resourceIds.some(resource => !owned.some(item => item.id === resource))) throw new DomainError("PAYMENT_RESOURCE", "The referenced payment is not in this production's owned set.", 403);
  }
  await client.query("INSERT INTO on_payment_intents(id,tenant_id,seller,semantic_key,document) VALUES($1,$2,$3,$4,$5)", [id, actor.tenantId, spec.seller, spec.semanticKey, intent]);
  await enqueueJob(client, { tenantId: actor.tenantId, kind: "payment_reconcile", semanticKey: id, payload: { intentId: id }, runAfter: spec.runAfter ?? new Date(Date.now() + 65000) });
  if (execution) {
    if (spec.purpose === "rental_order") { execution.paymentRootId = intent.id; execution.state = "awaiting_payment"; }
    if (spec.purpose === "rental_fee") execution.captureIntentId = intent.id;
    if (spec.purpose === "rental_cancel") execution.compensationIntentId = intent.id;
    await saveRentalExecution(client, show, execution);
  }
  return { intent, created: true };
}
