import type { AuthorizationDecision, PaymentOperation } from "@fracture/paypal-core";
import type { PoolClient } from "pg";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { ticketCohort } from "@/domain/commerce-contracts";
import { digest } from "@/domain/hash";
import type { PaymentIntent } from "@/domain/payment-authority";
import { activeCommerceActor, readCohort, readCohortTicket, readRemedyBatch, readRemedyItem, saveCohort, saveCohortTicket, saveRemedyItem, type CohortTicketRecord, type DatabaseReader, type TicketCohortRecord, type RemedyItemRecord, type RemedyBatchRecord } from "./commerce-storage";
import { readSavedWallet } from "./wallet-storage";
import { verifySavedWallet } from "./wallet-service";
import { paymentStore, paymentTransaction } from "./payment-store";
import { getShow, pool } from "./store";

export function cohortConsentDigest(cohort: Pick<TicketCohortRecord, "id" | "tenantId" | "terms" | "version" | "ticketSetDigest" | "expiresAt">) {
  return digest({ id: cohort.id, tenantId: cohort.tenantId, terms: cohort.terms, version: cohort.version, ticketSetDigest: cohort.ticketSetDigest, expiresAt: cohort.expiresAt });
}
export function assertCohortActive(cohort: TicketCohortRecord, ticketId?: string) {
  if (!cohort.approvedBy || !cohort.approvedAt || !cohort.expiresAt || cohort.revokedAt || !["approved", "paused"].includes(cohort.state)) throw new DomainError("COHORT_AUTHORITY_REVOKED", "This cohort has no current permission to start another ticket instruction.", 403);
  if (Date.parse(cohort.expiresAt) <= Date.now()) throw new DomainError("COHORT_CONSENT_EXPIRED", "The cohort's charge consent expired. Existing results remain available for reconciliation.", 403);
  if (cohort.state === "paused" && (!ticketId || cohort.pauseTicketId !== ticketId)) throw new DomainError("COHORT_PAUSED", "Resolve the paused ticket and review the remaining cohort before continuing.", 409);
  if (cohort.digest !== cohortConsentDigest(cohort) || cohort.terms.maximumMinor !== ticketCohort.grossMinor || cohort.terms.maximumTickets !== ticketCohort.count || cohort.terms.standardCount !== ticketCohort.standard || cohort.terms.vipCount !== ticketCohort.vip || cohort.terms.currency !== "USD" || cohort.terms.seller !== "venue" || cohort.terms.admissionMinor !== 3500 || cohort.terms.perkMinor !== 1500) throw new DomainError("COHORT_TERMS_CHANGED", "The approved cohort terms changed.", 403);
}
export async function assertCohortInventory(cohort: TicketCohortRecord, client: DatabaseReader) {
  const rows = await client.query<{ id: string; ordinal: number; tier: string; amount_minor: number }>("SELECT id,ordinal,tier,amount_minor FROM on_cohort_tickets WHERE tenant_id=$1 AND cohort_id=$2 ORDER BY ordinal", [cohort.tenantId, cohort.id]);
  const identity = rows.rows.map(row => ({ id: row.id, ordinal: row.ordinal, tier: row.tier, amountMinor: row.amount_minor }));
  if (identity.length !== 80 || identity.reduce((sum, line) => sum + line.amountMinor, 0) !== 337000 || identity.filter(line => line.tier === "standard").length !== 42 || identity.filter(line => line.tier === "vip").length !== 38 || digest(identity) !== cohort.ticketSetDigest) throw new DomainError("COHORT_CAP_CHANGED", "The exact eighty-ticket allocation could not be verified.", 403);
}
function assertLine(intent: PaymentIntent, cohort: TicketCohortRecord, line: CohortTicketRecord, preparing: boolean) {
  assertCohortActive(cohort, intent.ticketId ?? undefined);
  if (line.cohortId !== cohort.id || line.id !== intent.ticketId || line.tenantId !== intent.tenantId || cohort.approvedBy !== intent.approvedBy || intent.seller !== "venue" || intent.tier !== line.tier || intent.command.action.money.minor !== line.amountMinor || intent.command.approval.expiresAt !== cohort.expiresAt) throw new DomainError("COHORT_LINE_MISMATCH", "This payment differs from its exact approved ticket line.", 403);
  if (intent.purpose === "ticket_order") {
    if (intent.parentId || line.rootIntentId && line.rootIntentId !== intent.id || !preparing && line.rootIntentId !== intent.id) throw new DomainError("COHORT_LINE_ALREADY_RESERVED", "The logical ticket already has its original checkout identity.", 403);
  } else if (intent.purpose === "ticket_capture") {
    if (intent.parentId !== line.rootIntentId || line.captureIntentId && line.captureIntentId !== intent.id || !preparing && line.captureIntentId !== intent.id) throw new DomainError("COHORT_LINE_ALREADY_RESERVED", "The ticket already has its original capture instruction.", 403);
  } else throw new DomainError("COHORT_PURPOSE_MISMATCH", "The cohort grants only its exact ticket purchases.", 403);
}
function savedConsent(cohort: TicketCohortRecord, tokenId: string): NonNullable<AuthorizationDecision["savedWalletConsent"]> {
  return { vaultId: tokenId, consentId: cohort.id, consentVersion: cohort.version, consentDigest: cohort.digest, paymentInitiator: "MERCHANT", usagePattern: "IMMEDIATE", usage: "DERIVED", expiresAt: cohort.expiresAt! };
}
function assertSavedAction(intent: PaymentIntent, cohort: TicketCohortRecord, tokenId: string | null) {
  const action = intent.command.action;
  if (action.kind !== "create_order") return;
  const expected = tokenId ? savedConsent(cohort, tokenId) : null;
  if (expected) { const { expiresAt: _expiry, ...fields } = expected; if (digest(action.savedWallet ?? null) !== digest(fields) || !intent.resourceIds.includes(tokenId!)) throw new DomainError("COHORT_WALLET_MISMATCH", "This instruction references different saved-wallet consent.", 403); }
  else if (action.savedWallet) throw new DomainError("COHORT_WALLET_MISMATCH", "This cohort requires individual buyer approval.", 403);
}
/** Runs inside the same transaction as the new immutable intent. No SDK call occurs here. */
export async function linkCommerceIntent(client: PoolClient, intent: PaymentIntent) {
  if (intent.cohortId) {
    const cohort = await readCohort(intent.tenantId, intent.cohortId, client, true);
    const line = await readCohortTicket(intent.tenantId, intent.ticketId!, client);
    assertLine(intent, cohort, line, true); await assertCohortInventory(cohort, client);
    const wallet = cohort.terms.walletId ? await readSavedWallet(intent.tenantId, cohort.terms.walletId, client) : null;
    if (cohort.terms.mode === "saved_wallet" && (!wallet?.active || wallet.actorId !== intent.approvedBy)) throw new DomainError("COHORT_WALLET_REQUIRED", "Save and verify the exact wallet before approving its bounded cohort.", 403);
    assertSavedAction(intent, cohort, wallet?.tokenId ?? null);
    if (intent.purpose === "ticket_order") { line.rootIntentId = intent.id; line.reservedAt ??= new Date().toISOString(); }
    else line.captureIntentId = intent.id;
    await saveCohortTicket(client, line);
  } else if (intent.ticketId && intent.purpose !== "vip_refund") {
    const reserved = await client.query("SELECT 1 FROM on_cohort_tickets WHERE tenant_id=$1 AND id=$2", [intent.tenantId, intent.ticketId]);
    if (reserved.rowCount) throw new DomainError("COHORT_TICKET_REQUIRES_APPROVAL", "This reserved ticket must use its recorded cohort approval.", 403);
  }
  if (intent.remedyBatchId) {
    const batch = await readRemedyBatch(intent.tenantId, intent.remedyBatchId, client, true);
    const item = await readRemedyItem(intent.tenantId, intent.remedyItemId!, client);
    assertRemedyIntent(intent, batch, item, true); await assertRemedyInventory(batch, client); item.intentId = intent.id; await saveRemedyItem(client, item);
  }
}
export type RemedyAllocation = Pick<RemedyItemRecord, "ticketId" | "rootIntentId" | "orderId" | "captureId" | "amountMinor">;
export function remedyAllocationDigest(tenantId: string, planVersion: number, planDigest: string | null, items: RemedyAllocation[]) {
  return digest({ purpose: "vip_soundcheck_remedy", tenantId, planVersion, planDigest, items: [...items].sort((a, b) => a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0).map(item => ({ ticketId: item.ticketId, rootIntentId: item.rootIntentId, orderId: item.orderId, captureId: item.captureId, amountMinor: item.amountMinor })) });
}
async function assertRemedyInventory(batch: RemedyBatchRecord, client: DatabaseReader) {
  const rows = await client.query<{ ticket_id: string; capture_id: string; amount_minor: number; document: RemedyItemRecord }>("SELECT ticket_id,capture_id,amount_minor,document FROM on_remedy_items WHERE tenant_id=$1 AND batch_id=$2", [batch.tenantId, batch.id]);
  if (rows.rows.length !== 38 || rows.rows.some(row => row.amount_minor !== 1500 || row.document.amountMinor !== 1500 || row.document.ticketId !== row.ticket_id || row.document.captureId !== row.capture_id || row.document.tenantId !== batch.tenantId || row.document.batchId !== batch.id) || remedyAllocationDigest(batch.tenantId, batch.planVersion, batch.planDigest, rows.rows.map(row => row.document)) !== batch.digest) throw new DomainError("REMEDY_BATCH_ALLOCATION_CHANGED", "The exact thirty-eight original captures could not be verified.", 403);
}
function assertRemedyIntent(intent: PaymentIntent, batch: RemedyBatchRecord, item: RemedyItemRecord, preparing: boolean) {
  if (batch.state !== "approved" || batch.revokedAt || Date.parse(batch.expiresAt) <= Date.now()) throw new DomainError("REMEDY_BATCH_AUTHORITY_EXPIRED", "This remedy batch has no current permission for a new refund.", 403);
  const action = intent.command.action;
  if (intent.purpose !== "vip_refund" || intent.seller !== "venue" || intent.planVersion !== batch.planVersion || intent.planDigest !== batch.planDigest || intent.approvedBy !== batch.approvedBy || intent.command.approval.expiresAt !== batch.expiresAt || item.batchId !== batch.id || item.ticketId !== intent.ticketId || item.rootIntentId !== intent.parentId || action.kind !== "refund_capture" || action.captureId !== item.captureId || action.orderId !== item.orderId || action.money.minor !== 1500 || item.intentId && item.intentId !== intent.id || !preparing && item.intentId !== intent.id) throw new DomainError("REMEDY_BATCH_LINE_MISMATCH", "This refund differs from its exact capture-specific batch approval.", 403);
}
/** Independently constructs the grant; never echoes a caller's saved-wallet authority. */
export async function authorizeCommerceIntent(intent: PaymentIntent, show: ShowSnapshot, signal: AbortSignal): Promise<{ savedWalletConsent?: NonNullable<AuthorizationDecision["savedWalletConsent"]> }> {
  if (intent.cohortId) {
    const initial = await readCohort(intent.tenantId, intent.cohortId); assertCohortActive(initial, intent.ticketId ?? undefined);
    const wallet = initial.terms.mode === "saved_wallet" && initial.terms.walletId ? await verifySavedWallet(intent.tenantId, initial.terms.walletId, intent.approvedBy, signal) : null;
    const operation = await (await paymentStore()).get(intent.command.scope, intent.id);
    return paymentTransaction(async client => {
      const cohort = await readCohort(intent.tenantId, intent.cohortId!, client, true);
      const line = await readCohortTicket(intent.tenantId, intent.ticketId!, client);
      assertLine(intent, cohort, line, false); await assertCohortInventory(cohort, client);
      if (cohort.terms.showId !== show.id) throw new DomainError("COHORT_SHOW_CHANGED", "The consent belongs to another show.", 403);
      await activeCommerceActor(intent.tenantId, intent.approvedBy, client);
      if (cohort.terms.mode === "saved_wallet") {
        const local = cohort.terms.walletId ? await readSavedWallet(intent.tenantId, cohort.terms.walletId, client) : null;
        if (!wallet || !local?.active || local.id !== wallet.id || local.tokenId !== wallet.tokenId) throw new DomainError("WALLET_AUTHORITY_REVOKED", "The saved wallet was disabled before dispatch.", 403);
      }
      assertSavedAction(intent, cohort, wallet?.tokenId ?? null);
      // The claimed phase is core's final authorization immediately before dispatch.
      // A later revocation stops subsequent instructions; this one may already be in flight.
      if (operation?.status === "claimed") { line.dispatchAuthorizedAt = new Date().toISOString(); await saveCohortTicket(client, line); }
      return wallet && intent.command.action.kind === "create_order" ? { savedWalletConsent: savedConsent(cohort, wallet.tokenId) } : {};
    });
  }
  if (intent.remedyBatchId) {
    const operation = await (await paymentStore()).get(intent.command.scope, intent.id);
    await paymentTransaction(async client => {
      const batch = await readRemedyBatch(intent.tenantId, intent.remedyBatchId!, client, true), item = await readRemedyItem(intent.tenantId, intent.remedyItemId!, client);
      assertRemedyIntent(intent, batch, item, false); await assertRemedyInventory(batch, client); await activeCommerceActor(intent.tenantId, batch.approvedBy, client);
      if (batch.planVersion !== show.planVersion || batch.planDigest !== show.approvedPlan?.digest) throw new DomainError("REMEDY_PLAN_CHANGED", "Review the remedy against the current production plan.", 403);
      if (operation?.status === "claimed") { item.dispatchAuthorizedAt = new Date().toISOString(); await saveRemedyItem(client, item); }
    });
  }
  return {};
}
/** Called while the cohort dispatch lock is still held, before another line can start. */
export async function recordCommerceOutcome(intent: PaymentIntent, operation: PaymentOperation | null, failure?: unknown) {
  if (!intent.cohortId || !intent.ticketId) return;
  const show = await getShow(intent.tenantId);
  if (show.tickets.some(ticket => ticket.id === intent.ticketId && ticket.captureId && ticket.source === "live_sandbox")) return;
  let code: string | null = failure instanceof DomainError ? failure.code : failure ? "COHORT_REVIEW_REQUIRED" : null;
  if (operation && ["refused", "not_sent"].includes(operation.status)) code = "COHORT_PAYMENT_REFUSED";
  if (operation && ["dispatching", "pending_reconciliation"].includes(operation.status)) code = "COHORT_PAYMENT_UNCERTAIN";
  if (operation?.status === "succeeded" && intent.purpose === "ticket_order") {
    const resources = operation.receipt?.resources ?? [], captures = resources.filter(item => item.kind === "capture");
    const order = resources.find(item => item.kind === "order");
    if (captures.some(item => !["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(item.status))) code = "COHORT_CAPTURE_PENDING";
    else if (!captures.length && order && !["APPROVED", "COMPLETED"].includes(order.status)) code = "COHORT_BUYER_APPROVAL_REQUIRED";
  }
  if (!code) return;
  await pauseCohortTicket(intent.tenantId, intent.cohortId, intent.ticketId, code);
}
export async function pauseCohortTicket(tenantId: string, cohortId: string, ticketId: string, code: string) {
  await paymentTransaction(async client => {
    const cohort = await readCohort(tenantId, cohortId, client, true);
    if (cohort.state !== "approved" && !(cohort.state === "paused" && cohort.pauseTicketId === ticketId)) return;
    cohort.state = "paused"; cohort.pauseCode = code; cohort.pauseTicketId = ticketId;
    await saveCohort(client, cohort);
    const line = await readCohortTicket(tenantId, ticketId, client); line.lastCode = code; await saveCohortTicket(client, line);
  });
}
