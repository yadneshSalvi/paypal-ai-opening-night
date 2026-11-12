import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { currentLightingInspector } from "@/domain/delivery-qualification";
import { currentActual } from "@/domain/finance";
import type { DeliveryAccessData, DeliveryReceipt, PublicDeliveryReceipt, RentalExecution } from "@/domain/supplier-contracts";
import { compareInstants } from "@/domain/time";
import { getShow, pool } from "./store";
import { currentSupplierPlan } from "./supplier-service";
import { appendSupplierFact, assertRevision, lockSupplierShow, readRentalExecution, saveRentalExecution, saveSupplierSnapshot, supplierActor, supplierScope, supplierTransaction } from "./supplier-storage";
import { deliveryNonceHash, issueDeliveryToken, verifyDeliveryToken } from "./delivery-token";
import { ownedResources, paymentStore, readIntent } from "./payment-store";
import { preparePaymentIntent } from "./payment-intents";

function permissions(show: ShowSnapshot, execution: RentalExecution, actor: Actor) {
  if (show.tenantId !== actor.tenantId) throw new DomainError("DELIVERY_SCOPE_REQUIRED", "This handoff belongs to another rehearsal.", 403);
  const canIssue = actor.roles.includes("producer") || actor.roles.includes("supplier") && supplierScope(actor) === execution.supplierId;
  const canScan = actor.roles.includes("driver") && actor.executionId === execution.id && supplierScope(actor) === execution.supplierId;
  const assignment = show.tasks.find(task => task.id === "lx-program"); const person = show.resources.find(item => item.id === actor.personId);
  const canInspect = actor.roles.includes("department_lead") && actor.executionId === execution.id && Boolean(person && currentLightingInspector(show)?.id === person.id && assignment?.resources.includes(person.id));
  if (!canIssue && !canScan && !canInspect) throw new DomainError("DELIVERY_SCOPE_REQUIRED", "This client does not have the assigned handoff role for this execution.", 403);
  return { canIssue, canScan, canInspect, label: canInspect ? person!.name + " · lighting acceptance" : canScan ? "Controlled " + execution.supplierId + " delivery driver" : actor.roles.includes("producer") ? "Production operator" : "Controlled " + execution.supplierId + " supplier" };
}
function publicReceipt(receipt: DeliveryReceipt): PublicDeliveryReceipt {
  const { nonceHash: _nonce, scannedBy, acceptedBy, tenantId: _tenant, ...value } = receipt;
  return { ...value, driver: scannedBy ? "Controlled supplier driver" : null, inspector: acceptedBy ? "Assigned lighting department lead" : null };
}
async function readDelivery(client: Pick<PoolClient, "query">, tenantId: string, id: string) {
  const stored = await client.query<{ document: DeliveryReceipt }>("SELECT document FROM on_delivery_receipts WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
  if (!stored.rows[0]) throw new DomainError("DELIVERY_NOT_FOUND", "This handoff does not belong to the current rehearsal.", 404);
  return stored.rows[0].document;
}
async function saveDelivery(client: PoolClient, receipt: DeliveryReceipt) { await client.query("UPDATE on_delivery_receipts SET document=$3 WHERE tenant_id=$1 AND id=$2", [receipt.tenantId, receipt.id, receipt]); }
async function priorCommand(client: PoolClient, actor: Actor, id: string, payload: unknown) {
  const hash = digest({ actorId: actor.id, payload });
  const prior = await client.query<{ payload_hash: string }>("SELECT payload_hash FROM on_commands WHERE tenant_id=$1 AND command_id=$2", [actor.tenantId, id]);
  if (prior.rows[0] && prior.rows[0].payload_hash !== hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This handoff command identity already has different instructions.");
  return { hash, replayed: Boolean(prior.rows[0]) };
}
async function recordCommand(client: PoolClient, actor: Actor, id: string, hash: string, revision: number) { await client.query("INSERT INTO on_commands(tenant_id,command_id,payload_hash,result_revision) VALUES($1,$2,$3,$4)", [actor.tenantId, id, hash, revision]); }

export async function deliveryOverview(actor: Actor, executionId: string): Promise<DeliveryAccessData> {
  const show = await getShow(actor.tenantId); const execution = await readRentalExecution(pool, actor.tenantId, executionId);
  const actorView = permissions(show, execution, actor);
  const delivery = execution.deliveryId ? await readDelivery(pool, actor.tenantId, execution.deliveryId) : null;
  const actual = currentActual(show);
  return { revision: show.revision, clock: show.clock, show: show.title, venue: show.venue, serverAt: new Date().toISOString(), actor: actorView,
    execution: { id: execution.id, planVersion: execution.planVersion, supplierId: execution.supplierId, unitId: execution.unitId, deliveryAt: execution.deliveryAt, feeMinor: execution.feeMinor, depositMinor: execution.depositMinor, state: execution.state, deliveryVersion: execution.deliveryVersion, lastCode: execution.lastCode },
    delivery: delivery ? publicReceipt(delivery) : null,
    authorizationVerified: actual.some(item => item.kind === "authorization" && item.providerResourceId === execution.authorizationId && item.amountMinor === execution.feeMinor + execution.depositMinor),
    feeCaptured: actual.some(item => item.kind === "capture" && item.purpose === "rental" && item.parentId === execution.authorizationId && item.amountMinor === execution.feeMinor),
  };
}

export async function issueDelivery(actor: Actor, executionId: string, commandId: string, expectedRevision: number) {
  return supplierTransaction(async client => {
    const show = await lockSupplierShow(client, actor.tenantId); const execution = await readRentalExecution(client, actor.tenantId, executionId);
    if (!permissions(show, execution, actor).canIssue) throw new DomainError("SUPPLIER_ISSUER_REQUIRED", "The supplier or production operator issues the controlled handoff code.", 403);
    const prior = await priorCommand(client, actor, commandId, { executionId, expectedRevision, action: "issue" });
    if (prior.replayed) return { delivery: execution.deliveryId ? publicReceipt(await readDelivery(client, actor.tenantId, execution.deliveryId)) : null, token: null };
    assertRevision(show, expectedRevision); currentSupplierPlan(show, execution);
    if (execution.state !== "confirmed") throw new DomainError("RESERVATION_CONFIRMATION_REQUIRED", "Confirm the exact supplier reservation before issuing its delivery handoff.");
    if (execution.deliveryId) {
      const old = await readDelivery(client, actor.tenantId, execution.deliveryId);
      if (old.state !== "issued" && old.state !== "revoked") throw new DomainError("DELIVERY_ALREADY_SCANNED", "This handoff already has a driver record and cannot be reissued.");
      old.state = "revoked"; await saveDelivery(client, old);
    }
    const issuedAt = new Date().toISOString(); const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const deliveryId = randomUUID(); const version = execution.deliveryVersion + 1;
    const issued = issueDeliveryToken({ tenantId: actor.tenantId, executionId, deliveryId, supplierId: execution.supplierId, unitId: execution.unitId, planVersion: execution.planVersion, planDigest: execution.planDigest, version, expiresAt });
    const receipt: DeliveryReceipt = { id: deliveryId, tenantId: actor.tenantId, executionId, supplierId: execution.supplierId, unitId: execution.unitId, version, planVersion: execution.planVersion, planDigest: execution.planDigest, nonceHash: issued.nonceHash, issuedAt, expiresAt, state: "issued", scannedAt: null, scannedBy: null, acceptedAt: null, acceptedBy: null, condition: null, source: "controlled_fixture" };
    await client.query("INSERT INTO on_delivery_receipts(id,tenant_id,execution_id,version,nonce_hash,document) VALUES($1,$2,$3,$4,$5,$6)", [deliveryId, actor.tenantId, executionId, version, issued.nonceHash, receipt]);
    execution.deliveryId = deliveryId; execution.deliveryVersion = version;
    await saveRentalExecution(client, show, execution);
    await saveSupplierSnapshot(client, show, actor.id, "delivery.code_issued", `Issued signed, expiring handoff v${version} for ${execution.unitId}. The code cannot accept condition or authorize money.`);
    await recordCommand(client, actor, commandId, prior.hash, show.revision);
    return { delivery: publicReceipt(receipt), token: issued.token };
  });
}
export async function scanDelivery(actor: Actor, token: string, commandId: string) {
  const value = verifyDeliveryToken(token);
  if (value.tenantId !== actor.tenantId) throw new DomainError("DELIVERY_SCOPE_REQUIRED", "This handoff belongs to another rehearsal.", 403);
  return supplierTransaction(async client => {
    const show = await lockSupplierShow(client, actor.tenantId); const execution = await readRentalExecution(client, actor.tenantId, value.executionId);
    if (!permissions(show, execution, actor).canScan) throw new DomainError("ASSIGNED_DRIVER_REQUIRED", "Only this execution's controlled supplier driver may record the scan.", 403);
    const prior = await priorCommand(client, actor, commandId, { action: "scan", tokenHash: digest(token) });
    const receipt = await readDelivery(client, actor.tenantId, value.deliveryId);
    if (prior.replayed) return publicReceipt(receipt);
    currentSupplierPlan(show, execution);
    if (execution.deliveryId !== value.deliveryId || execution.deliveryVersion !== value.version || execution.planDigest !== value.planDigest || execution.planVersion !== value.planVersion || execution.supplierId !== value.supplierId || execution.unitId !== value.unitId || receipt.executionId !== execution.id || receipt.nonceHash !== deliveryNonceHash(value.nonce)) throw new DomainError("DELIVERY_VERSION_CHANGED", "This code no longer matches the exact current handoff and production plan.");
    if (receipt.state !== "issued") throw new DomainError("DELIVERY_QR_ALREADY_USED", "This handoff code was already consumed or revoked.");
    if (Date.parse(receipt.expiresAt) <= Date.now()) throw new DomainError("DELIVERY_QR_EXPIRED", "The handoff code expired. Request a current code.");
    if (execution.state !== "confirmed" || compareInstants(show.clock, execution.deliveryAt) < 0) throw new DomainError("DELIVERY_NOT_DUE", "The confirmed delivery window has not arrived in the labeled show scenario.");
    receipt.state = "scanned"; receipt.scannedAt = new Date().toISOString(); receipt.scannedBy = actor.id;
    execution.state = "delivered";
    await saveDelivery(client, receipt); await saveRentalExecution(client, show, execution);
    await saveSupplierSnapshot(client, show, actor.id, "delivery.scanned", `Controlled driver consumed handoff v${receipt.version} for ${execution.unitId}. Department acceptance and fee capture are still pending.`);
    await recordCommand(client, actor, commandId, prior.hash, show.revision);
    return publicReceipt(receipt);
  });
}

export async function inspectDelivery(actor: Actor, input: { executionId: string; deliveryId: string; version: number; commandId: string; expectedRevision: number; decision: "accept" | "reject"; condition: NonNullable<DeliveryReceipt["condition"]> }) {
  await paymentStore();
  return supplierTransaction(async client => {
    const show = await lockSupplierShow(client, actor.tenantId); const execution = await readRentalExecution(client, actor.tenantId, input.executionId);
    if (!permissions(show, execution, actor).canInspect) throw new DomainError("ASSIGNED_INSPECTOR_REQUIRED", "Only the assigned qualified lighting lead may accept this console.", 403);
    const { commandId, ...instruction } = input;
    const prior = await priorCommand(client, actor, commandId, instruction);
    const receipt = await readDelivery(client, actor.tenantId, input.deliveryId);
    if (prior.replayed) return publicReceipt(receipt);
    assertRevision(show, input.expectedRevision); currentSupplierPlan(show, execution);
    if (receipt.executionId !== execution.id || execution.deliveryId !== receipt.id || execution.deliveryVersion !== input.version || receipt.version !== input.version || receipt.state !== "scanned" || execution.state !== "delivered") throw new DomainError("SCANNED_HANDOFF_REQUIRED", "Review the current consumed driver handoff before accepting condition.");
    if (input.condition.report.trim().length < 12 || input.condition.report.length > 1200) throw new DomainError("CONDITION_REPORT_REQUIRED", "Record a specific equipment condition report.", 400);
    receipt.condition = input.condition; receipt.acceptedBy = actor.id; receipt.acceptedAt = new Date().toISOString();
    if (input.decision === "reject") {
      receipt.state = "rejected"; execution.state = "needs_attention"; execution.lastCode = "DELIVERY_REJECTED";
    } else {
      if (!input.condition.powerOn || !input.condition.accessories || !input.condition.safeCondition) throw new DomainError("INSPECTION_INCOMPLETE", "Power-on, required accessories and safe condition must all be confirmed before acceptance.");
      if (!execution.paymentRootId || !execution.authorizationId || !execution.captureConsentAt) throw new DomainError("APPROVED_FEE_REQUIRED", "The original producer approval and verified authorization are required for this accepted rental.");
      const producer = await supplierActor(client, actor.tenantId, execution.producerId);
      if (!producer.roles.includes("producer")) throw new DomainError("CAPTURE_AUTHORITY_REVOKED", "The original producer's capture authority is no longer active.", 403);
      const root = await readIntent(actor.tenantId, execution.paymentRootId, client);
      const owned = await ownedResources(actor.tenantId, "brightline", root.id, client);
      const order = owned.find(item => item.kind === "order"), authorization = owned.find(item => item.kind === "authorization" && item.id === execution.authorizationId);
      if (!order || !authorization || root.executionId !== execution.id) throw new DomainError("ORIGINAL_RESOURCE_REQUIRED", "The accepted rental must retain its exact original order and authorization.");
      receipt.state = "accepted"; execution.state = "accepted"; execution.acceptedAt = receipt.acceptedAt; execution.lastCode = null;
      appendSupplierFact(show, actor, "delivery_accepted", `Signed controlled handoff ${receipt.id} v${receipt.version}; assigned lighting lead accepted condition: ${input.condition.report}`);
      await saveRentalExecution(client, show, execution);
      await preparePaymentIntent(client, producer, { purpose: "rental_fee", semanticKey: root.id + ":fee", seller: "brightline", parentId: root.id, resourceIds: [authorization.id, order.id], approvedExecution: execution, runAfter: new Date(), build: () => ({ kind: "capture_authorization", money: { currency: "USD", minor: execution.feeMinor }, authorizationId: authorization.id, orderId: order.id, finalCapture: false }) }, show);
    }
    await saveDelivery(client, receipt); await saveRentalExecution(client, show, execution);
    await saveSupplierSnapshot(client, show, actor.id, "delivery." + input.decision, input.decision === "accept" ? `Assigned lighting lead accepted the controlled ${execution.unitId} handoff. The producer-approved fee instruction was queued atomically; a verified provider capture is still required.` : `Assigned lighting lead rejected the controlled ${execution.unitId}: ${input.condition.report}. No fee instruction was created.`);
    await recordCommand(client, actor, input.commandId, prior.hash, show.revision);
    return publicReceipt(receipt);
  });
}
