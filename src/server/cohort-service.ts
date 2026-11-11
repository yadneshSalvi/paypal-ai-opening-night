import { randomUUID } from "node:crypto";
import { payloadHash, type PaymentAction, type PaymentOperation, type ProviderResource } from "@fracture/paypal-core";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import { ticketCohort, type CohortMode, type CohortTerms, type PublicCohort, type PublicCommerceLine } from "@/domain/commerce-contracts";
import { digest } from "@/domain/hash";
import { currentActual } from "@/domain/finance";
import { assertPaymentAuthority, safeApprovalUrl, type PaymentIntent } from "@/domain/payment-authority";
import { activeCommerceActor, readCohort, readCohortTicket, saveCohort, withCommerceLock, type CohortTicketRecord, type TicketCohortRecord } from "./commerce-storage";
import { assertCohortActive, assertCohortInventory, cohortConsentDigest, pauseCohortTicket } from "./commerce-policy";
import { readSavedWallet } from "./wallet-storage";
import { verifySavedWallet } from "./wallet-service";
import { getShow, pool } from "./store";
import { importPaymentOperation, ownedResources, paymentStore, paymentTransaction, readIntent } from "./payment-store";
import { preparePaymentIntent } from "./payment-intents";
import { checkoutOrigin, handlePayment, reconcilePaymentIntent, returnExperience } from "./payment-service";
import { providers } from "./paypal-providers";
import { assertProducer, assertRevision, lockSupplierShow, saveSupplierSnapshot } from "./supplier-storage";
import { enqueueJob, type JobResult } from "./jobs";

function termsFor(show: ShowSnapshot, mode: CohortMode, walletId: string | null): CohortTerms {
  return { version: 1, seller: "venue", currency: "USD", showId: show.id, mode, walletId,
    standardCount: 42, vipCount: 38, maximumTickets: 80, maximumMinor: 337000, admissionMinor: 3500, perkMinor: 1500, purpose: "controlled_sandbox_ticket_cohort" };
}
export function verifiedCohortCapture(show: ShowSnapshot, line: Pick<CohortTicketRecord, "id" | "amountMinor">) {
  return show.financialEvidence.find(item => item.ticketId === line.id && item.kind === "capture" && item.purpose === "ticket" && item.source === "live_sandbox" && item.verified && item.status === "completed" && item.amountMinor === line.amountMinor) ?? null;
}
export async function draftCohort(actor: Actor, mode: CohortMode, walletId: string | null, expectedRevision: number, rawOrigin: string) {
  assertProducer(actor); await paymentStore(); const origin = checkoutOrigin(rawOrigin);
  if (mode === "saved_wallet") {
    if (!walletId) throw new DomainError("COHORT_WALLET_REQUIRED", "Save a PayPal wallet before reviewing its bounded use.");
    const wallet = await readSavedWallet(actor.tenantId, walletId);
    if (!wallet.active || wallet.actorId !== actor.id) throw new DomainError("WALLET_AUTHORITY_REVOKED", "The selected wallet is not available to this operator.", 403);
  } else if (walletId) throw new DomainError("COHORT_MODE_MISMATCH", "Individual approval does not use a saved wallet.", 400);
  return paymentTransaction(async client => {
    const show = await lockSupplierShow(client, actor.tenantId); const terms = termsFor(show, mode, walletId);
    const existing = await client.query<{ document: TicketCohortRecord }>("SELECT document FROM on_ticket_cohorts WHERE tenant_id=$1 FOR UPDATE", [actor.tenantId]);
    if (existing.rows[0]) {
      const cohort = existing.rows[0].document;
      if (digest(cohort.terms) === digest(terms)) return cohort;
      if (cohort.state !== "draft") throw new DomainError("COHORT_ALREADY_APPROVED", "This production already has its one approved eighty-ticket cohort. Its identities and limits cannot be replaced.");
      assertRevision(show, expectedRevision); cohort.terms = terms; cohort.version++; cohort.digest = cohortConsentDigest(cohort); cohort.origin = origin;
      await saveCohort(client, cohort); return cohort;
    }
    assertRevision(show, expectedRevision); const id = randomUUID();
    const lines: CohortTicketRecord[] = Array.from({ length: 80 }, (_, index) => ({ id: randomUUID(), tenantId: actor.tenantId, cohortId: id, ordinal: index + 1,
      tier: index < 42 ? "standard" : "vip", amountMinor: index < 42 ? 3500 : 5000, rootIntentId: null, captureIntentId: null, reservedAt: null, dispatchAuthorizedAt: null, lastCode: null }));
    const cohort: TicketCohortRecord = { id, tenantId: actor.tenantId, state: "draft", terms, digest: "", version: 1,
      ticketSetDigest: digest(lines.map(line => ({ id: line.id, ordinal: line.ordinal, tier: line.tier, amountMinor: line.amountMinor }))),
      createdAt: new Date().toISOString(), approvedBy: null, approvedAt: null, expiresAt: null, revokedAt: null, pauseCode: null, pauseTicketId: null, origin, reviewDigest: null };
    cohort.digest = cohortConsentDigest(cohort);
    await client.query("INSERT INTO on_ticket_cohorts(id,tenant_id,document) VALUES($1,$2,$3)", [id, actor.tenantId, cohort]);
    await client.query(`INSERT INTO on_cohort_tickets(id,tenant_id,cohort_id,ordinal,tier,amount_minor,document)
      SELECT (value->>'id')::uuid,(value->>'tenantId')::uuid,(value->>'cohortId')::uuid,(value->>'ordinal')::integer,value->>'tier',(value->>'amountMinor')::integer,value FROM jsonb_array_elements($1::jsonb)`, [JSON.stringify(lines)]);
    return cohort;
  });
}
export async function approveCohort(actor: Actor, id: string, reviewedDigest: string, expectedRevision: number, signal: AbortSignal) {
  assertProducer(actor); const before = await readCohort(actor.tenantId, id);
  if (before.terms.mode === "saved_wallet") await verifySavedWallet(actor.tenantId, before.terms.walletId!, actor.id, signal);
  return paymentTransaction(async client => {
    const show = await lockSupplierShow(client, actor.tenantId); const cohort = await readCohort(actor.tenantId, id, client, true);
    if (cohort.state !== "draft") {
      if (cohort.reviewDigest !== reviewedDigest || cohort.approvedBy !== actor.id) throw new DomainError("COHORT_APPROVAL_CONFLICT", "This cohort already has different recorded consent.");
      return cohort;
    }
    assertRevision(show, expectedRevision);
    if (cohort.digest !== reviewedDigest || cohort.digest !== cohortConsentDigest(cohort)) throw new DomainError("COHORT_REVIEW_CHANGED", "The ticket cohort changed after review. Review its exact terms again.");
    await assertCohortInventory(cohort, client); await activeCommerceActor(actor.tenantId, actor.id, client);
    const approvedAt = Date.now();
    cohort.approvedBy = actor.id; cohort.approvedAt = new Date(approvedAt).toISOString(); cohort.expiresAt = new Date(approvedAt + 24 * 60 * 60 * 1000).toISOString();
    cohort.reviewDigest = reviewedDigest; cohort.state = "approved"; cohort.digest = cohortConsentDigest(cohort);
    await saveCohort(client, cohort);
    if (cohort.terms.mode === "saved_wallet") {
      const lines = await client.query<{ id: string }>("SELECT id FROM on_cohort_tickets WHERE tenant_id=$1 AND cohort_id=$2 ORDER BY ordinal", [actor.tenantId, id]);
      for (const line of lines.rows) await enqueueJob(client, { tenantId: actor.tenantId, kind: "cohort_ticket", semanticKey: line.id, payload: { cohortId: id, ticketId: line.id } });
    }
    await saveSupplierSnapshot(client, show, actor.id, "cohort.approved", "Approved at most 80 separate controlled sandbox purchases by one buyer: 42 × $35 and 38 × $50, total ceiling $3,370. No purchase is counted until its capture is verified.");
    return cohort;
  });
}
export async function revokeCohort(actor: Actor, id: string) {
  assertProducer(actor);
  return paymentTransaction(async client => {
    const show = await lockSupplierShow(client, actor.tenantId), cohort = await readCohort(actor.tenantId, id, client, true);
    if (cohort.revokedAt) return cohort;
    cohort.revokedAt = new Date().toISOString(); cohort.state = "revoked";
    await saveCohort(client, cohort);
    await saveSupplierSnapshot(client, show, actor.id, "cohort.revoked", "Stopped unstarted cohort instructions. An instruction authorized immediately before this stop may still finish; existing receipts and unknown outcomes retain their original ticket identities.");
    return cohort;
  });
}
export async function resumeCohort(actor: Actor, id: string) {
  assertProducer(actor);
  return withCommerceLock("cohort:" + actor.tenantId + ":" + id, () => paymentTransaction(async client => {
    const show = await lockSupplierShow(client, actor.tenantId), cohort = await readCohort(actor.tenantId, id, client, true);
    assertCohortActive(cohort, cohort.pauseTicketId ?? undefined);
    if (cohort.approvedBy !== actor.id) throw new DomainError("COHORT_APPROVING_ACTOR_REQUIRED", "The operator who approved this bounded cohort must review its continuation.", 403);
    await activeCommerceActor(actor.tenantId, actor.id, client); await assertCohortInventory(cohort, client);
    checkoutOrigin(cohort.origin);
    const wallet = cohort.terms.walletId ? await readSavedWallet(actor.tenantId, cohort.terms.walletId, client) : null;
    if (wallet) {
      if (!wallet.active || wallet.actorId !== actor.id) throw new DomainError("WALLET_AUTHORITY_REVOKED", "The approved wallet is no longer available to this operator.", 403);
    }
    if (cohort.state === "paused" && cohort.pauseTicketId) {
      const line = await readCohortTicket(actor.tenantId, cohort.pauseTicketId, client);
      if (line.cohortId !== cohort.id) throw new DomainError("COHORT_LINE_MISMATCH", "The paused ticket differs from this approved cohort.", 403);
      const capture = verifiedCohortCapture(show, line);
      const settled = Boolean(capture && currentActual(show).some(item => item.id === capture.id));
      let undispatched = !line.captureIntentId && !line.dispatchAuthorizedAt
        && !show.tickets.some(ticket => ticket.id === line.id) && !show.financialEvidence.some(item => item.ticketId === line.id);
      if (undispatched) {
        const intents = await client.query<{ id: string; document: PaymentIntent }>("SELECT id,document FROM on_payment_intents WHERE tenant_id=$1 AND (document->>'ticketId'=$2 OR semantic_key=$3)", [actor.tenantId, line.id, "ticket:" + line.id + ":order"]);
        const original = line.rootIntentId && intents.rows.length === 1 && intents.rows[0]?.id === line.rootIntentId ? intents.rows[0].document : null;
        undispatched = line.rootIntentId ? Boolean(original && line.reservedAt) : !line.reservedAt && intents.rows.length === 0;
        if (undispatched && original) {
          assertPaymentAuthority(show, original);
          const command = original.command, expectedAction = ticketAction(original.id, cohort, line, wallet?.tokenId ?? null);
          undispatched = original.id === line.rootIntentId && original.tenantId === actor.tenantId && original.ticketId === line.id && original.cohortId === cohort.id
            && original.seller === "venue" && original.purpose === "ticket_order" && original.tier === line.tier && original.parentId === null
            && original.approvedBy === actor.id && original.semanticKey === "ticket:" + line.id + ":order"
            && command.operationId === original.id && command.businessKey === original.semanticKey && command.intentId === original.id
            && command.approval.expiresAt === cohort.expiresAt && command.approval.id === "approval:" + original.id && command.approval.version === original.planVersion
            && command.payloadHash === payloadHash(expectedAction) && digest(command.action) === digest(expectedAction)
            && digest(original.resourceIds) === digest(wallet ? [wallet.tokenId] : [])
            && command.approval.digest === digest({ actorId: actor.id, action: command.action, planDigest: original.planDigest, cohortId: cohort.id, cohortDigest: cohort.digest });
        }
        // A reserved identity is retained only if the durable core has never started it. Even a
        // not_sent/refused operation needs its existing explicit retry path; unknown effects reconcile.
        const records = await client.query<{ aligned: boolean; operation: boolean; attempt: boolean; binding: boolean; imported: boolean }>(`SELECT
          EXISTS(SELECT 1 FROM on_cohort_tickets WHERE tenant_id=$1::uuid AND id=$2::uuid AND root_intent_id IS NOT DISTINCT FROM $4::uuid AND capture_intent_id IS NULL) AS aligned,
          EXISTS(SELECT 1 FROM paycore_operations WHERE tenant_id=$1::text AND (business_key=$3 OR id=$4::text OR provider_request_id=$5)) AS operation,
          EXISTS(SELECT 1 FROM paycore_attempts WHERE tenant_id=$1::text AND operation_id=$4::text) AS attempt,
          EXISTS(SELECT 1 FROM on_payment_bindings WHERE tenant_id=$1::uuid AND root_intent_id=$4::uuid) AS binding,
          EXISTS(SELECT 1 FROM on_payment_imports WHERE tenant_id=$1::uuid AND operation_id=$4::text) AS imported`,
        [actor.tenantId, line.id, "ticket:" + line.id + ":order", line.rootIntentId, original?.command.providerRequestId ?? null]);
        const proof = records.rows[0];
        undispatched = Boolean(undispatched && proof?.aligned && !proof.operation && !proof.attempt && !proof.binding && !proof.imported);
      }
      if (!settled && !undispatched) throw new DomainError("COHORT_UNRESOLVED_TICKET", "Resolve the paused ticket's original instruction and current provider state before resuming the remainder.");
    }
    cohort.state = "approved"; cohort.pauseCode = null; cohort.pauseTicketId = null; await saveCohort(client, cohort);
    await client.query("UPDATE on_jobs SET status='queued',run_after=now(),attempts=0,last_code=NULL WHERE tenant_id=$1 AND kind='cohort_ticket' AND payload->>'cohortId'=$2 AND status NOT IN ('running','complete')", [actor.tenantId, id]);
    await saveSupplierSnapshot(client, show, actor.id, "cohort.resumed", "Resumed the remaining original ticket instructions under the same unexpired approval and unchanged $3,370 ceiling.");
    return cohort;
  }));
}
function ticketAction(id: string, cohort: TicketCohortRecord, line: CohortTicketRecord, tokenId: string | null): PaymentAction {
  return { kind: "create_order", money: { currency: "USD", minor: line.amountMinor }, intent: "CAPTURE", customId: "on:" + id,
    items: [{ name: "Night Ferries — controlled sandbox admission", unitAmount: { currency: "USD", minor: 3500 }, quantity: 1 }, ...(line.tier === "vip" ? [{ name: "Controlled VIP soundcheck perk allocation", unitAmount: { currency: "USD", minor: 1500 }, quantity: 1 }] : [])],
    experience: returnExperience(id, cohort.tenantId, cohort.origin, false),
    ...(tokenId ? { savedWallet: { vaultId: tokenId, consentId: cohort.id, consentVersion: cohort.version, consentDigest: cohort.digest, paymentInitiator: "MERCHANT" as const, usagePattern: "IMMEDIATE" as const, usage: "DERIVED" as const } } : {}) };
}
async function prepareLine(tenantId: string, cohortId: string, ticketId: string, captureOrderId?: string) {
  return paymentTransaction(async client => {
    const show = await lockSupplierShow(client, tenantId), cohort = await readCohort(tenantId, cohortId, client, true), line = await readCohortTicket(tenantId, ticketId, client);
    assertCohortActive(cohort, ticketId); if (line.cohortId !== cohort.id) throw new DomainError("COHORT_LINE_MISMATCH", "The ticket belongs to another cohort.", 403);
    const actor = await activeCommerceActor(tenantId, cohort.approvedBy!, client);
    const wallet = cohort.terms.walletId ? await readSavedWallet(tenantId, cohort.terms.walletId, client) : null;
    const result = await preparePaymentIntent(client, actor, captureOrderId ? {
      purpose: "ticket_capture", semanticKey: line.rootIntentId! + ":capture", seller: "venue", parentId: line.rootIntentId!, ticketId, tier: line.tier, cohortId, resourceIds: [captureOrderId],
      build: () => ({ kind: "capture_order", money: { currency: "USD", minor: line.amountMinor }, orderId: captureOrderId }),
    } : {
      purpose: "ticket_order", semanticKey: "ticket:" + ticketId + ":order", seller: "venue", ticketId, tier: line.tier, cohortId, resourceIds: wallet ? [wallet.tokenId] : [],
      build: id => ticketAction(id, cohort, line, wallet?.tokenId ?? null),
    }, show);
    return result.intent;
  });
}
/** A successful create may contain a pending or immediate capture. Read that same order; never blindly capture it again. */
export async function refreshCohortOrder(root: PaymentIntent, signal: AbortSignal): Promise<ProviderResource[]> {
  const operation = await (await paymentStore()).get(root.command.scope, root.id);
  if (!operation?.receipt || operation.status !== "succeeded" || root.purpose !== "ticket_order" || !root.cohortId) return [];
  const bindings = await ownedResources(root.tenantId, "venue", root.id); const orders = bindings.filter(item => item.kind === "order");
  if (orders.length !== 1) throw new DomainError("COHORT_ORDER_AMBIGUOUS", "The ticket's one original order could not be verified.");
  const resources = await providers.venue.read("order", orders[0]!.id, signal), captures = resources.filter(item => item.kind === "capture");
  if (!resources.some(item => item.kind === "order" && item.id === orders[0]!.id) || captures.length > 1) throw new DomainError("COHORT_ORDER_AMBIGUOUS", "The original ticket order has ambiguous capture evidence.");
  if (captures.length) {
    const capture = captures[0]!;
    if (capture.parentId !== orders[0]!.id || capture.money?.currency !== "USD" || capture.money.minor !== root.command.action.money.minor) throw new DomainError("COHORT_CAPTURE_MISMATCH", "The original order's capture differs from the exact ticket allocation.", 403);
    const direct = (await providers.venue.read("capture", capture.id, signal)).find(item => item.kind === "capture" && item.id === capture.id);
    if (!direct?.money || direct.money.currency !== "USD" || direct.money.minor !== capture.money.minor) throw new DomainError("COHORT_CAPTURE_MISMATCH", "The direct capture read did not corroborate the original ticket amount.", 403);
    const observedAt = new Date().toISOString(); const corroborated = resources.map(item => item === capture ? { ...direct, parentId: orders[0]!.id } : item);
    if (!["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(direct.status)) return corroborated;
    const readback: PaymentOperation = { ...operation, receipt: { ...operation.receipt, id: randomUUID(), observedAt, resources: corroborated, bodyHash: digest(corroborated), reconciled: true } };
    await importPaymentOperation(root, readback, { observedAt, orderId: orders[0]!.id, resources: corroborated });
    return corroborated;
  }
  return resources;
}
export async function runCohortTicket(tenantId: string, cohortId: string, ticketId: string, signal: AbortSignal): Promise<JobResult> {
  return withCommerceLock("cohort:" + tenantId + ":" + cohortId, async () => {
    try { return await runLine(tenantId, cohortId, ticketId, signal); }
    catch (error) { await pauseCohortTicket(tenantId, cohortId, ticketId, error instanceof DomainError ? error.code : "COHORT_READBACK_REQUIRED"); throw error; }
  });
}
async function runLine(tenantId: string, cohortId: string, ticketId: string, signal: AbortSignal): Promise<JobResult> {
  let line = await readCohortTicket(tenantId, ticketId); const cohort = await readCohort(tenantId, cohortId);
  if (line.cohortId !== cohortId) return { status: "needs_attention", code: "COHORT_LINE_MISMATCH" };
  if (verifiedCohortCapture(await getShow(tenantId), line)) return { status: "complete" };
  const permitted = !cohort.revokedAt && Boolean(cohort.expiresAt && Date.parse(cohort.expiresAt) > Date.now()) && (cohort.state === "approved" || cohort.state === "paused" && cohort.pauseTicketId === ticketId);
  if (!permitted && !line.rootIntentId) return cohort.state === "paused" ? { status: "waiting", code: "COHORT_PAUSED", delaySeconds: 300 } : { status: "needs_attention", code: "COHORT_AUTHORITY_REVOKED" };
  if (!line.rootIntentId) checkoutOrigin(cohort.origin);
  const root = line.rootIntentId ? await readIntent(tenantId, line.rootIntentId) : await prepareLine(tenantId, cohortId, ticketId);
  const rootResult = await reconcilePaymentIntent(tenantId, root.id, signal, permitted);
  if (rootResult.status !== "complete") return rootResult;
  if (verifiedCohortCapture(await getShow(tenantId), line)) return { status: "complete" };
  const resources = await refreshCohortOrder(root, signal);
  if (verifiedCohortCapture(await getShow(tenantId), line)) return { status: "complete" };
  if (resources.some(item => item.kind === "capture")) { await pauseCohortTicket(tenantId, cohortId, ticketId, "COHORT_CAPTURE_PENDING"); return { status: "waiting", code: "COHORT_CAPTURE_PENDING", delaySeconds: 30 }; }
  const order = resources.find(item => item.kind === "order");
  if (!order || order.status !== "APPROVED") { await pauseCohortTicket(tenantId, cohortId, ticketId, "COHORT_BUYER_APPROVAL_REQUIRED"); return { status: "needs_attention", code: "COHORT_BUYER_APPROVAL_REQUIRED" }; }
  if (!permitted) return { status: "needs_attention", code: "COHORT_AUTHORITY_REVOKED" };
  line = await readCohortTicket(tenantId, ticketId);
  const capture = line.captureIntentId ? await readIntent(tenantId, line.captureIntentId) : await prepareLine(tenantId, cohortId, ticketId, order.id);
  return reconcilePaymentIntent(tenantId, capture.id, signal, true);
}
export async function startIndividualCohortTicket(actor: Actor, cohortId: string, ticketId: string) {
  assertProducer(actor); const cohort = await readCohort(actor.tenantId, cohortId), line = await readCohortTicket(actor.tenantId, ticketId);
  assertCohortActive(cohort, ticketId);
  if (cohort.approvedBy !== actor.id || cohort.terms.mode !== "buyer_present" || line.cohortId !== cohort.id) throw new DomainError("COHORT_INDIVIDUAL_APPROVAL_REQUIRED", "Select an owned individual-approval ticket from this cohort.", 403);
  await enqueueJob(pool, { tenantId: actor.tenantId, kind: "cohort_ticket", semanticKey: ticketId, payload: { cohortId, ticketId } });
  return runCohortTicket(actor.tenantId, cohortId, ticketId, AbortSignal.timeout(50000));
}
export async function retryCohortTicket(actor: Actor, cohortId: string, ticketId: string) {
  assertProducer(actor); const cohort = await readCohort(actor.tenantId, cohortId), line = await readCohortTicket(actor.tenantId, ticketId);
  assertCohortActive(cohort, ticketId);
  if (cohort.approvedBy !== actor.id || line.cohortId !== cohort.id) throw new DomainError("COHORT_LINE_MISMATCH", "This ticket belongs to another approval.", 403);
  const intentId = line.captureIntentId ?? line.rootIntentId;
  if (!intentId) throw new DomainError("COHORT_RETRY_NOT_EXPECTED", "This ticket has no refused instruction to retry.");
  await handlePayment(actor, { type: "retry_refused", intentId }, cohort.origin);
  return runCohortTicket(actor.tenantId, cohortId, ticketId, AbortSignal.timeout(50000));
}
export async function finishCohortCheckout(actor: Actor, root: PaymentIntent) {
  await runCohortTicket(actor.tenantId, root.cohortId!, root.ticketId!, AbortSignal.timeout(50000));
  const line = await readCohortTicket(actor.tenantId, root.ticketId!);
  const latest = await (await paymentStore()).get(root.command.scope, line.captureIntentId ?? root.id);
  if (!latest) throw new DomainError("COHORT_RESULT_PENDING", "This ticket's original instruction is still awaiting its verified result.", 503);
  return latest;
}
export function publicLineState(operation: PaymentOperation | null, purpose: "ticket" | "remedy"): PublicCommerceLine["state"] {
  if (!operation) return "queued";
  if (operation.status === "refused" || operation.status === "not_sent") return "refused";
  if (operation.status === "pending_reconciliation") return "pending";
  if (operation.status === "claimed" || operation.status === "dispatching") return purpose === "remedy" ? "refunding" : operation.command.action.kind === "create_order" ? "creating" : "capturing";
  return purpose === "remedy" ? "refunding" : "approval_required";
}
export async function cohortOverview(tenantId: string, show: ShowSnapshot): Promise<PublicCohort | null> {
  const result = await pool.query<{ document: TicketCohortRecord }>("SELECT document FROM on_ticket_cohorts WHERE tenant_id=$1", [tenantId]); const cohort = result.rows[0]?.document; if (!cohort) return null;
  const lines = (await pool.query<{ document: CohortTicketRecord }>("SELECT document FROM on_cohort_tickets WHERE tenant_id=$1 AND cohort_id=$2 ORDER BY ordinal", [tenantId, cohort.id])).rows.map(row => row.document);
  const operations = new Map((await (await paymentStore()).list({ tenantId, projectId: "opening-night:venue" })).map(item => [item.command.intentId, item]));
  const currentIds = new Set(currentActual(show).filter(item => item.kind === "capture" && item.purpose === "ticket").map(item => item.id));
  const publicLines: PublicCommerceLine[] = lines.map(line => {
    const capture = verifiedCohortCapture(show, line); const root = line.rootIntentId ? operations.get(line.rootIntentId) ?? null : null;
    const operation = (line.captureIntentId ? operations.get(line.captureIntentId) : null) ?? root;
    const stopped = Boolean(cohort.revokedAt || cohort.expiresAt && Date.parse(cohort.expiresAt) <= Date.now());
    const rootState = root?.receipt?.resources.find(item => item.kind === "order")?.status;
    const rootPending = root?.receipt?.resources.some(item => item.kind === "capture" && !["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(item.status));
    const state = !line.captureIntentId && root?.status === "succeeded" ? rootPending ? "pending" : rootState === "APPROVED" ? "capturing" : rootState === "COMPLETED" ? "needs_attention" : "approval_required" : publicLineState(operation, "ticket");
    return { id: line.id, ordinal: line.ordinal, tier: line.tier, amountMinor: line.amountMinor,
      state: capture ? "captured" : !line.rootIntentId ? stopped ? "stopped" : cohort.state === "draft" ? "waiting" : "queued" : state,
      intentId: line.captureIntentId ?? line.rootIntentId, captureReference: capture ? "••••" + capture.providerResourceId.slice(-6) : null, refundReference: null,
      approvalUrl: capture || stopped || rootState === "APPROVED" || rootState === "COMPLETED" ? null : safeApprovalUrl(root?.receipt?.resources ?? []), lastCode: capture ? currentIds.has(capture.id) ? null : "CAPTURE_STATE_REVIEW_REQUIRED" : line.lastCode };
  });
  const captured = publicLines.filter(line => line.state === "captured");
  return { id: cohort.id, state: captured.length === 80 ? "complete" : cohort.revokedAt ? "revoked" : cohort.expiresAt && Date.parse(cohort.expiresAt) <= Date.now() ? "expired" : cohort.state,
    terms: cohort.terms, digest: cohort.digest, version: cohort.version, approvedAt: cohort.approvedAt, expiresAt: cohort.expiresAt, revokedAt: cohort.revokedAt, pauseCode: cohort.pauseCode,
    pauseTicketId: cohort.pauseTicketId, capturedCount: captured.length, capturedMinor: captured.reduce((sum, line) => sum + line.amountMinor, 0), reservedCount: lines.filter(line => line.rootIntentId).length,
    unresolvedCount: publicLines.filter(line => ["pending", "refused", "needs_attention"].includes(line.state)).length,
    currentVerifiedCount: captured.filter(line => !line.lastCode).length, captureReviewCount: captured.filter(line => line.lastCode).length, lines: publicLines };
}
