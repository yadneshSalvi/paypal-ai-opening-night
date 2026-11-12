import { randomUUID } from "node:crypto";
import { controlledPresentation } from "../judge/presentation";
import { DomainError } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { currentActual, uniqueActual } from "@/domain/finance";
import { closeoutEnvelopeSchema, rentalBelongsToCurrentPlan, rentalExecutionDigest, returnReference, supplierLabel } from "@/domain/rental-closeout";
import { openIntelligence, sealIntelligence } from "../intelligence/private-payload";
import { env } from "../env";
import { enqueueJob } from "../jobs";
import { preparePaymentIntent } from "../payment-intents";
import { paymentStore, readIntent } from "../payment-store";
import { saveRentalExecution, saveSupplierSnapshot } from "../supplier-storage";
import type { CloseoutAuthority, CloseoutEnvelope, CloseoutReceipt, CloseoutResult, CloseoutWorkspace, PublicCloseout, RentalCloseoutCard, RentalCloseoutGrant, RentalReturnRecord } from "./contracts";
import { acceptedDelivery, originalRental, prepareCloseout, reference, returnBlocker } from "./preview";
import { assertRentalCloseoutIntent } from "./payment-policy";
import { closeoutAccess, closeoutOriginalReceipt, closeoutTransaction, readCloseoutGrant, readReturn, requireCloseoutAuthority, saveCloseoutGrant, saveCloseoutReceipt, saveReturn, type CloseoutContext } from "./store";

async function workspace(context: CloseoutContext): Promise<CloseoutWorkspace> {
  const { show, authority, db } = context, access = closeoutAccess(authority)!;
  const rentals: RentalCloseoutCard[] = [], actual = currentActual(show), historical = uniqueActual(show), core = await paymentStore();
  const selected = [...(show.rentalExecutions ?? [])].filter(value => access !== "supplier" || value.supplierId === authority.actor.supplierId).sort((a, b) => b.planVersion - a.planVersion || a.id.localeCompare(b.id));
  for (const current of selected) {
    const prepared = await prepareCloseout(context, current.id), { execution } = prepared;
    const { delivery } = await originalRental(context, current.id);
    const returnRows = (await db.query<{ id: string }>("SELECT id FROM on_rental_return_records WHERE tenant_id=$1 AND execution_id=$2 ORDER BY created_at,id", [show.tenantId, execution.id])).rows;
    const returns = await Promise.all(returnRows.map(async row => { const record = await readReturn(show.tenantId, row.id, db); return { id: record.id, previousId: record.previousInspectionId, condition: record.condition, detail: record.detail, actorLabel: supplierLabel(record.supplierId) + " · " + record.actor.id.slice(-8), observedAt: record.observedAt, recordedAt: record.recordedAt, fixtureAt: record.fixtureAt, planVersion: record.originalPlanVersion, source: record.source, current: execution.returnInspection?.id === record.id }; }));
    const grantId = (await db.query<{ id: string }>("SELECT id FROM on_rental_closeout_grants WHERE tenant_id=$1 AND execution_id=$2", [show.tenantId, execution.id])).rows[0]?.id;
    const fee = actual.find(value => value.kind === "capture" && value.purpose === "rental" && value.operationId === execution.captureIntentId && value.parentId === execution.authorizationId);
    const oldFee = historical.find(value => value.kind === "capture" && value.purpose === "rental" && value.operationId === execution.captureIntentId && value.parentId === execution.authorizationId);
    const released = actual.find(value => value.kind === "void" && value.purpose === "deposit" && value.parentId === execution.authorizationId && value.planVersion === execution.planVersion);
    const oldRelease = historical.find(value => value.kind === "void" && value.purpose === "deposit" && value.parentId === execution.authorizationId && value.planVersion === execution.planVersion);
    let closeout: PublicCloseout | null = null;
    if (grantId) {
      const { grant, progress, stoppedAt } = await readCloseoutGrant(show.tenantId, grantId, db), intent = progress.intentId ? await readIntent(show.tenantId, progress.intentId, db) : null;
      const operation = intent ? await core.get(intent.command.scope, intent.id) : null;
      const sessionMatches = grant.actor.id === authority.actor.id && grant.sessionHash === authority.sessionHash;
      let currentApproval = sessionMatches && access === "producer" && !stoppedAt && Date.parse(grant.expiresAt) > Date.now();
      if (currentApproval && intent) { try { await assertRentalCloseoutIntent(db, show, intent); } catch (error) { if (!(error instanceof DomainError)) throw error; currentApproval = false; } }
      const complete = Boolean(released && released.operationId === intent?.id && released.amountMinor === grant.residualMinor);
      const state = complete ? "complete" : operation?.status === "succeeded" ? "needs_attention" : stoppedAt && (!operation || ["refused", "not_sent", "claimed"].includes(operation.status)) ? "stopped" : !intent ? "queued" : !operation ? "prepared" : ["refused", "not_sent"].includes(operation.status) ? "needs_attention" : "pending";
      closeout = { id: grant.id, intentId: intent?.id ?? null, state, code: complete ? null : operation?.status === "succeeded" ? "CLOSURE_CURRENT_READ_REQUIRED" : progress.lastCode ?? operation?.error?.kind ?? (env.controlledQa ? "PROVIDER_QA_DISABLED" : null), approvedAt: grant.approvedAt, expiresAt: grant.expiresAt, stoppedAt, historical: false, canRetry: currentApproval && Boolean(operation && ["refused", "not_sent"].includes(operation.status)), canStop: access === "producer" && !stoppedAt && !complete, sessionMatches, residualMinor: grant.residualMinor };
    } else if (prepared.existingIntent) {
      const intent = prepared.existingIntent, operation = await core.get(intent.command.scope, intent.id);
      closeout = { id: intent.id, intentId: intent.id, state: released?.operationId === intent.id ? "complete" : operation && ["dispatching", "pending_reconciliation", "claimed"].includes(operation.status) ? "pending" : "needs_attention", code: released?.operationId === intent.id ? null : "ORIGINAL_LEGACY_INSTRUCTION", approvedAt: intent.createdAt, expiresAt: intent.command.approval.expiresAt, stoppedAt: null, historical: true, canRetry: false, canStop: false, sessionMatches: false, residualMinor: intent.depositMinor };
    }
    const cannotReturn = returnBlocker(context, execution, delivery);
    const feeIntent = execution.captureIntentId ? await readIntent(show.tenantId, execution.captureIntentId, db) : null;
    const feeOperation = feeIntent ? await core.get(feeIntent.command.scope, feeIntent.id) : null;
    rentals.push({ id: execution.id, executionDigest: rentalExecutionDigest(execution), supplierId: execution.supplierId, supplier: supplierLabel(execution.supplierId), unitId: execution.unitId, originalPlanVersion: execution.planVersion, currentPlan: rentalBelongsToCurrentPlan(show, execution), state: execution.state, acceptedAt: execution.acceptedAt, originalDeliveryAt: execution.deliveryAt, feeMinor: execution.feeMinor, depositMinor: execution.depositMinor, verifiedFeeMinor: fee?.amountMinor ?? 0, historicalFeeMinor: oldFee?.amountMinor ?? 0, releasedMinor: released?.amountMinor ?? 0, historicalReleasedMinor: oldRelease?.amountMinor ?? 0, feeReference: reference(oldFee?.providerResourceId), authorizationReference: reference(execution.authorizationId), originalFeeIntentId: feeIntent?.id ?? null, originalFeeState: feeIntent ? feeOperation?.status ?? "prepared" : null, canRecordReturn: access === "supplier" && !cannotReturn, returnBlocker: cannotReturn, latestReturnId: execution.returnInspection?.id ?? null, returns, canReviewClosure: access === "producer" && prepared.preview.ready, closureBlockers: prepared.preview.blockers, closeout, evidenceBoundary: controlledPresentation(show) ? "controlled_fixture" : "sandbox_with_controlled_supplier" });
  }
  const receipts = (await db.query<{ command_id: string; receipt_cipher: string }>("SELECT command_id,receipt_cipher FROM on_rental_closeout_commands WHERE tenant_id=$1 AND actor_id=$2 AND session_hash=$3 ORDER BY created_at DESC,command_id LIMIT 40", [show.tenantId, authority.actor.id, authority.sessionHash])).rows;
  return { tenantId: show.tenantId, actorId: authority.actor.id, sessionFingerprint: digest(authority.sessionHash), expiresAt: context.expiresAt, revision: show.revision, clock: show.clock, access, supplierId: access === "supplier" ? authority.actor.supplierId! : null, providerActionsEnabled: !env.controlledQa, rentals, history: receipts.map(row => openIntelligence<CloseoutReceipt>(show.tenantId, `rental-closeout-command:${row.command_id}`, row.receipt_cipher)) };
}
export async function readCloseoutWorkspace(authority: CloseoutAuthority) { await paymentStore(); return closeoutTransaction(authority, false, workspace); }
export async function previewRentalCloseout(authority: CloseoutAuthority, executionId: string, expectedRevision: number) {
  await paymentStore();
  return closeoutTransaction(authority, false, async context => {
    await requireCloseoutAuthority(context.db, authority, "producer");
    if (context.show.revision !== expectedRevision) throw new DomainError("STALE_REVISION", "The production changed. Refresh the exact original rental before reviewing its hold.");
    return (await prepareCloseout(context, executionId)).preview;
  });
}
async function recordReturn(context: CloseoutContext, command: Extract<CloseoutEnvelope["command"], { type: "record_return" }>) {
  await requireCloseoutAuthority(context.db, context.authority, "supplier");
  const { execution, delivery } = await originalRental(context, command.executionId), blocker = returnBlocker(context, execution, delivery);
  if (blocker || !acceptedDelivery(execution, delivery)) throw new DomainError("ORIGINAL_RETURN_NOT_READY", blocker ?? "The original accepted handoff is required.");
  if (command.executionDigest !== rentalExecutionDigest(execution) || command.previousInspectionId !== (execution.returnInspection?.id ?? null)) throw new DomainError("RENTAL_RETURN_CHANGED", "The original unit or latest inspection changed. Review its retained history before recording another observation.");
  const now = (await context.db.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0]!.at;
  const observed = Date.parse(command.observedAt);
  if (observed < Date.parse(execution.acceptedAt!) || observed > now.getTime() + 30000 || execution.returnInspection && observed < Date.parse(execution.returnInspection.observedAt)) throw new DomainError("RETURN_OBSERVATION_TIME", "Use the actual observation time after the original acceptance and any preceding inspection, without a future claim.", 400);
  const record: RentalReturnRecord = { id: randomUUID(), tenantId: context.show.tenantId, executionId: execution.id, executionDigest: command.executionDigest, previousInspectionId: command.previousInspectionId, originalPlanVersion: execution.planVersion, originalPlanDigest: execution.planDigest, supplierId: execution.supplierId, unitId: execution.unitId, quoteId: execution.quoteId, quoteDigest: execution.quoteDigest, deliveryId: delivery!.id, deliveryVersion: delivery!.version, deliveryDigest: digest(delivery), acceptedAt: execution.acceptedAt!, condition: command.condition, detail: command.detail, observedAt: command.observedAt, recordedAt: now.toISOString(), fixtureAt: context.show.clock, actor: context.authority.actor, sessionHash: context.authority.sessionHash, source: "attributed_controlled_supplier" };
  await saveReturn(context.db, record);
  execution.returnInspection = returnReference(record); execution.state = "returned"; execution.lastCode = record.condition === "damage_reported" ? "RETURN_DAMAGE_REPORTED" : null;
  await saveRentalExecution(context.db, context.show, execution);
  await context.db.query("UPDATE on_resource_holds SET status='returned',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [context.show.tenantId, execution.id]);
  if (record.condition === "undamaged" && !context.show.facts.some(fact => fact.kind === "return_accepted" && fact.planVersion === execution.planVersion)) context.show.facts.push({ id: randomUUID(), kind: "return_accepted", planVersion: execution.planVersion, actorId: context.authority.actor.id, role: "supplier", recordedAt: record.recordedAt, fixtureAt: record.fixtureAt, source: "sample", detail: `Original ${execution.unitId} / plan v${execution.planVersion} attributed controlled return: ${record.detail}` });
  await saveSupplierSnapshot(context.db, context.show, context.authority.actor.id, "rental.original_return", `Supplier recorded ${record.condition === "undamaged" ? "an undamaged return" : "a return with reported damage"} for original ${execution.unitId}, plan v${execution.planVersion}. Its accepted fee and replacement-plan evidence remain separate.`);
  return { recordId: record.id, message: record.condition === "undamaged" ? "Original return saved. Its accepted fee is retained; hold closure still requires a separate producer review and provider confirmation." : "Damage report saved. The original remaining hold is blocked for separate resolution; no money was changed." };
}
export async function executeCloseoutCommand(authority: CloseoutAuthority, raw: CloseoutEnvelope): Promise<CloseoutResult> {
  const parsed = closeoutEnvelopeSchema.safeParse(raw); if (!parsed.success) throw new DomainError("INVALID_RENTAL_CLOSEOUT_COMMAND", "Review the exact original rental instruction.", 400);
  const envelope = parsed.data, requestDigest = digest(envelope); await paymentStore();
  return closeoutTransaction(authority, true, async context => {
    const previous = await closeoutOriginalReceipt(context, envelope.commandId, requestDigest);
    if (previous) return { workspace: await workspace(context), receipt: previous, replayed: true };
    if (context.show.revision !== envelope.expectedRevision) throw new DomainError("STALE_REVISION", "The production changed. Refresh before reviewing this exact original rental.");
    const command = envelope.command; let outcome: { recordId: string; message: string };
    if (command.type === "record_return") outcome = await recordReturn(context, command);
    else if (command.type === "approve_closeout") {
      await requireCloseoutAuthority(context.db, authority, "producer");
      const prepared = await prepareCloseout(context, command.executionId);
      if (prepared.preview.digest !== command.previewDigest) throw new DomainError("RENTAL_CLOSEOUT_PREVIEW_CHANGED", "The original money, return or production changed. Review a fresh exact preview.");
      if (!prepared.grant || !prepared.preview.ready) throw new DomainError("RENTAL_CLOSEOUT_BLOCKED", prepared.preview.blockers[0] ?? "The original rental is not cleared for hold closure.");
      const now = (await context.db.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0]!.at;
      const grant: RentalCloseoutGrant = { ...prepared.grant, id: randomUUID(), actor: authority.actor, sessionHash: authority.sessionHash, approvedAt: now.toISOString(), expiresAt: new Date(Math.min(Date.parse(context.expiresAt), now.getTime() + 86400000)).toISOString(), detail: command.detail };
      await saveCloseoutGrant(context.db, grant);
      await preparePaymentIntent(context.db, authority.actor, { purpose: "rental_release", semanticKey: grant.rootIntentId + ":release", seller: "brightline", parentId: grant.rootIntentId, resourceIds: [grant.orderId, grant.authorizationId, grant.captureId], approvedExecution: prepared.execution, approvedSessionHash: authority.sessionHash, approvalExpiresAt: grant.expiresAt, rentalCloseoutId: grant.id, rentalReturnId: grant.returnId, rentalExecutionDigest: grant.executionDigest, runAfter: new Date(), build: () => ({ kind: "void_authorization", money: { currency: "USD", minor: grant.authorizationMinor }, orderId: grant.orderId, authorizationId: grant.authorizationId }) }, context.show);
      await saveSupplierSnapshot(context.db, context.show, authority.actor.id, "rental.closeout_approved", `Producer approved the original remaining hold for ${prepared.execution.unitId}, plan v${grant.originalPlanVersion}. The accepted fee is retained; provider confirmation is pending.`);
      outcome = { recordId: grant.id, message: "Original hold-closure instruction saved. Its exact identity, approval session and expiry are retained; the accepted fee is not refunded." };
    } else if (command.type === "stop_closeout") {
      await requireCloseoutAuthority(context.db, authority, "producer");
      const { grant, stoppedAt } = await readCloseoutGrant(context.show.tenantId, command.grantId, context.db);
      if (stoppedAt) throw new DomainError("RENTAL_CLOSEOUT_ALREADY_STOPPED", "The original stop is already saved. Read the existing result.");
      await context.db.query("INSERT INTO on_rental_closeout_stops(tenant_id,grant_id,actor_id,detail_cipher) VALUES($1,$2,$3,$4)", [context.show.tenantId, grant.id, authority.actor.id, sealIntelligence(context.show.tenantId, `rental-closeout-stop:${grant.id}`, { detail: command.detail, actor: authority.actor, sessionHash: authority.sessionHash })]);
      await saveSupplierSnapshot(context.db, context.show, authority.actor.id, "rental.closeout_stopped", "Stopped unused original hold-closure authority. Any already-dispatched outcome remains attached to its original operation and must be read back.");
      outcome = { recordId: grant.id, message: "Unused closure authority stopped. Existing provider outcomes remain available for original-only readback." };
    } else if (command.type === "reconcile_closeout") {
      const { execution } = await originalRental(context, command.executionId), intent = await readIntent(context.show.tenantId, command.intentId, context.db);
      if (intent.executionId !== execution.id || intent.parentId !== execution.paymentRootId || !["rental_release", "rental_fee"].includes(intent.purpose)) throw new DomainError("ORIGINAL_RENTAL_INSTRUCTION_REQUIRED", "Select this rental's exact original fee or hold-closure instruction.", 403);
      await enqueueJob(context.db, { tenantId: context.show.tenantId, kind: "rental_closeout_readback", semanticKey: intent.id + ":" + envelope.commandId, payload: { intentId: intent.id } });
      await saveSupplierSnapshot(context.db, context.show, authority.actor.id, "rental.original_readback", "Queued readback of the original rental instruction. This request cannot start a new provider write.");
      outcome = { recordId: intent.id, message: "Original-only readback saved. It creates no replacement payment identity and sends no new financial instruction." };
    } else {
      await requireCloseoutAuthority(context.db, authority, "producer");
      const { grant, progress } = await readCloseoutGrant(context.show.tenantId, command.grantId, context.db);
      if (grant.actor.id !== authority.actor.id || grant.sessionHash !== authority.sessionHash || progress.intentId !== command.intentId) throw new DomainError("EXACT_RENTAL_APPROVER_REQUIRED", "Only this original approving capability may review a retry of the same instruction.", 403);
      const intent = await readIntent(context.show.tenantId, command.intentId, context.db); await assertRentalCloseoutIntent(context.db, context.show, intent);
      const operation = await (await paymentStore()).get(intent.command.scope, intent.id);
      if (!operation || !["refused", "not_sent"].includes(operation.status)) throw new DomainError("ORIGINAL_RENTAL_RETRY_UNPROVEN", "Only a proved refused or undispatched original instruction can be explicitly retried. Unknown writes use readback.");
      await enqueueJob(context.db, { tenantId: context.show.tenantId, kind: "rental_closeout_retry", semanticKey: intent.id + ":" + envelope.commandId, payload: { intentId: intent.id, grantId: grant.id } });
      await saveSupplierSnapshot(context.db, context.show, authority.actor.id, "rental.original_retry", "The original exact approving capability reviewed one explicit retry of a proved refused or undispatched hold closure. Provider confirmation remains pending.");
      outcome = { recordId: intent.id, message: "Explicit retry retained against the same original instruction. Current original authority will be checked again before dispatch." };
    }
    const receipt: CloseoutReceipt = { commandId: envelope.commandId, action: command.type, requestDigest, recordId: outcome.recordId, revision: context.show.revision, at: new Date().toISOString(), message: outcome.message };
    await saveCloseoutReceipt(context, receipt);
    return { workspace: await workspace(context), receipt, replayed: false };
  });
}
export async function findCloseoutReceipt(authority: CloseoutAuthority, commandId: string) {
  return closeoutTransaction(authority, false, async context => {
    const receipt = await closeoutOriginalReceipt(context, commandId);
    if (!receipt) throw new DomainError("RENTAL_CLOSEOUT_RECEIPT_NOT_FOUND", "No saved receipt exists for this exact original command and capability.", 404);
    return receipt;
  });
}
export async function recoverCloseoutCommand(authority: CloseoutAuthority, commandId: string): Promise<CloseoutResult> {
  await paymentStore();
  return closeoutTransaction(authority, false, async context => {
    const receipt = await closeoutOriginalReceipt(context, commandId);
    if (!receipt) throw new DomainError("RENTAL_CLOSEOUT_RECEIPT_NOT_FOUND", "No saved receipt exists for this exact original command and capability.", 404);
    return { workspace: await workspace(context), receipt, replayed: true };
  });
}
