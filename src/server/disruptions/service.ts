import { randomUUID } from "node:crypto";
import { DomainError, type Candidate, type ShowSnapshot } from "@/domain/contracts";
import { recordRescueRun } from "@/domain/commands";
import { cancellationRemedies, disruptionDigest, operatingDigest, summarizeAssessment, type CancellationDecision, type DisruptionAssessment, type DisruptionEnvelope, type DisruptionMode, type SupplierDisruption } from "@/domain/disruptions";
import { currentActual } from "@/domain/finance";
import { digest } from "@/domain/hash";
import { planningDigest } from "@/domain/scheduling";
import { localTime } from "@/domain/time";
import { generateCandidates } from "../engine";
import { env } from "../env";
import { enqueueJob } from "../jobs";
import { paymentStore, readIntent } from "../payment-store";
import { saveRentalExecution, saveSupplierSnapshot } from "../supplier-storage";
import { prepareRentalCancellation } from "../supplier-cancellation";
import { sealIntelligence } from "../intelligence/private-payload";
import { cancellationPreview, retainedObligations } from "./preview";
import { allocationDigest, disruptionTransaction, originalReceipt, readDecision, readRecord, readRemedyItem, remedyItems, requireDisruptionAuthority, saveReceipt, saveRecord, saveRemedyItem, type Context } from "./store";
import type { CancellationRecord, DisruptionAuthority, DisruptionReceipt, DisruptionResult, DisruptionWorkspace, PublicEventRemedy } from "./contracts";

const assertRevision = (show: ShowSnapshot, expected: number) => { if (show.revision !== expected) throw new DomainError("STALE_REVISION", "This production changed. Refresh and review the exact current supplier and payment facts."); };
const assessmentSourceDigest = (show: ShowSnapshot) => digest({ planning: planningDigest(show), clock: show.clock, planVersion: show.planVersion });
const producer = (context: Context) => requireDisruptionAuthority(context.db, context.authority, true);
function operator(context: Context) { if (context.authority.actor.roles.includes("supplier")) throw new DomainError("DISRUPTION_OPERATOR_REQUIRED", "Only the production operator may assess the full production or review cancellation.", 403); }

async function workspace(context: Context): Promise<DisruptionWorkspace> {
  const { show, authority, db } = context, supplier = authority.actor.roles.includes("supplier");
  const offers = show.offers.filter(offer => !supplier || offer.supplierId === authority.actor.supplierId).map(offer => { const execution = show.rentalExecutions?.findLast(item => item.offerId === offer.id && item.offerRevision === offer.revision); return { id: offer.id, revision: offer.revision, supplierId: offer.supplierId, supplier: offer.supplier, unitId: offer.unitId, deliveryAt: offer.deliveryAt, executionId: execution?.id ?? null, executionState: execution?.state ?? null }; });
  const remedies: PublicEventRemedy[] = [];
  const historicalDecisions: DisruptionWorkspace["historicalDecisions"] = [];
  const rentalCommitments: DisruptionWorkspace["rentalCommitments"] = [];
  if (!supplier) {
    const actual = currentActual(show);
    for (const execution of show.rentalExecutions ?? []) {
      const capturedMinor = show.financialEvidence.filter(entry => entry.source === "live_sandbox" && entry.verified && entry.status === "completed" && entry.kind === "capture" && entry.parentId === execution.authorizationId).reduce((sum, entry) => sum + entry.amountMinor, 0);
      const authorization = actual.find(entry => entry.kind === "authorization" && entry.purpose === "rental" && entry.providerResourceId === execution.authorizationId && entry.amountMinor === execution.feeMinor + execution.depositMinor);
      const feeInstruction = execution.paymentRootId && (await db.query("SELECT 1 FROM on_payment_intents WHERE tenant_id=$1 AND document->>'parentId'=$2 AND document->>'purpose'='rental_fee'", [show.tenantId, execution.paymentRootId])).rowCount;
      const eligibleState = ["held", "awaiting_payment", "authorized", "confirmed", "expired", "reconfirmation_required", "returned_unaccepted"].includes(execution.state);
      const canCancel = execution.supplierId === "brightline" && Boolean(execution.paymentRootId && authorization) && !capturedMinor && !execution.acceptedAt && !execution.captureIntentId && !feeInstruction && eligibleState && (execution.state !== "returned_unaccepted" || Boolean(execution.rejectedReturn));
      const blocker = canCancel ? null : capturedMinor || execution.acceptedAt ? "Accepted or captured rental: retain its fee and return obligations for separate supplier review." : execution.state === "compensation_pending" ? "Original authorization cancellation is pending provider reconciliation." : execution.state === "cancelled" ? "This original rental is already cancelled." : feeInstruction || execution.captureIntentId ? "Reconcile the existing original fee instruction before any compensation." : "A currently verified original uncaptured authorization is required.";
      rentalCommitments.push({ id: execution.id, supplier: show.offers.find(offer => offer.supplierId === execution.supplierId)?.supplier ?? execution.supplierId, unitId: execution.unitId, state: execution.state, authorizationMinor: execution.feeMinor + execution.depositMinor, capturedMinor, canCancel, blocker });
    }
    const decisions = (await db.query<{ id: string }>("SELECT id FROM on_disruption_records WHERE tenant_id=$1 AND kind='decision' ORDER BY created_at,id", [show.tenantId])).rows;
    for (const row of decisions) { const record = await readDecision(show.tenantId, row.id, db); const stopped = Boolean((await db.query("SELECT 1 FROM on_disruption_stops WHERE tenant_id=$1 AND decision_id=$2", [show.tenantId, row.id])).rowCount); historicalDecisions.push({ id: row.id, mode: record.decision.mode, approvedAt: record.decision.approvedAt, newRefundMinor: record.decision.newRefundMinor, stopped }); }
    if (show.cancellationDecision) {
      const core = await paymentStore(), actual = currentActual(show);
      const decisionRecord = await readDecision(show.tenantId, show.cancellationDecision.id, db);
      for (const { allocation, progress } of await remedyItems(show.tenantId, show.cancellationDecision.id, db)) {
        const operation = progress.intentId ? await core.get({ tenantId: show.tenantId, projectId: "opening-night:venue" }, progress.intentId) : null;
        const confirmed = actual.find(entry => entry.operationId === progress.intentId && entry.purpose === "event_remedy" && entry.parentId === allocation.captureId && entry.amountMinor === allocation.amountMinor && entry.allocation?.decisionId === allocation.decisionId);
        const stopped = Boolean(show.cancellationDecision.remediesStoppedAt) || Date.parse(show.cancellationDecision.expiresAt) <= Date.now();
        const state: PublicEventRemedy["state"] = confirmed ? "complete" : operation && ["claimed", "dispatching", "pending_reconciliation"].includes(operation.status) ? "pending" : stopped ? "stopped" : operation && ["refused", "not_sent"].includes(operation.status) || progress.lastCode ? "needs_attention" : progress.intentId ? "prepared" : "queued";
        remedies.push({ id: allocation.id, ticketId: allocation.ticketId, tier: allocation.tier, captureReference: "••••" + allocation.captureId.slice(-6), amountMinor: allocation.amountMinor, admissionMinor: allocation.admissionMinor, perkMinor: allocation.perkMinor, state, code: progress.lastCode ?? (operation && ["refused", "not_sent"].includes(operation.status) ? "EXPLICIT_RETRY_REQUIRED" : null), refundReference: confirmed ? "••••" + confirmed.providerResourceId.slice(-6) : null, canRetry: Boolean(!stopped && operation && ["refused", "not_sent"].includes(operation.status) && decisionRecord.actor.id === authority.actor.id && decisionRecord.sessionHash === authority.sessionHash) });
      }
    }
  }
  const latestAssessment = show.disruptionAssessments?.at(-1);
  const assessmentIsCurrent = !supplier && Boolean(latestAssessment && latestAssessment.sourceDigest === assessmentSourceDigest(show) && latestAssessment.disruptionDigest === disruptionDigest(show));
  return { tenantId: show.tenantId, revision: show.revision, actorId: authority.actor.id, sessionFingerprint: digest({ purpose: "disruption-client", sessionHash: authority.sessionHash }), access: supplier ? "supplier" : authority.actor.roles.includes("producer") ? "producer" : "operator", expiresAt: context.expiresAt, clock: show.clock, providerActionsEnabled: !env.controlledQa, offers, reports: (show.supplierDisruptions ?? []).filter(report => !supplier || report.supplierId === authority.actor.supplierId), assessments: supplier ? [] : show.disruptionAssessments ?? [], assessmentIsCurrent, decision: supplier ? null : show.cancellationDecision ?? null, remedies, historicalDecisions, rentalCommitments, obligations: supplier ? [] : retainedObligations(show) };
}
export async function readDisruptionWorkspace(authority: DisruptionAuthority) { await paymentStore(); return disruptionTransaction(authority, false, workspace); }
export async function previewCancellation(authority: DisruptionAuthority, mode: DisruptionMode, admissionRefundMinor: number) {
  await paymentStore(); return disruptionTransaction(authority, false, async context => { await producer(context); return (await cancellationPreview(context.db, context.show, mode, admissionRefundMinor)).preview; });
}
export async function recoverDisruptionCommand(authority: DisruptionAuthority, commandId: string): Promise<DisruptionResult> {
  await paymentStore(); return disruptionTransaction(authority, false, async context => {
    const receipt = await originalReceipt(context, commandId);
    if (!receipt) throw new DomainError("DISRUPTION_COMMAND_NOT_FOUND", "This exact command is not recorded for the current session. Review it before explicitly retrying the same instruction.", 404);
    return { workspace: await workspace(context), receipt, replayed: true };
  });
}

async function reportDisruption(context: Context, command: Extract<DisruptionEnvelope["command"], { type: "report" }>) {
  const { show, authority, db } = context, actor = authority.actor;
  const offer = show.offers.find(item => item.id === command.offerId && item.revision === command.offerRevision);
  if (!offer) throw new DomainError("SUPPLIER_OFFER_CHANGED", "The original supplier quote changed. Refresh before attributing a new report.");
  const supplier = actor.roles.includes("supplier");
  if (supplier && actor.supplierId !== offer.supplierId) throw new DomainError("SUPPLIER_SCOPE_REQUIRED", "A supplier may report only its own enrolled equipment.", 403);
  if (command.availability === "available" && !supplier) throw new DomainError("SUPPLIER_RECONFIRMATION_REQUIRED", "Only this supplier's authenticated client can reconfirm its own availability.", 403);
  if (command.availability !== "unavailable" && !command.earliestAt || command.availability === "unavailable" && command.earliestAt) throw new DomainError("SUPPLIER_AVAILABILITY_TIME", "A delay or reconfirmation needs an exact earliest delivery; an unavailable unit has no promised delivery time.", 400);
  if (Date.parse(command.observedAt) > Date.now() + 30000 || Date.parse(command.observedAt) < Date.now() - 30 * 24 * 60 * 60 * 1000) throw new DomainError("SUPPLIER_SOURCE_TIME", "Use the actual recent time of the source report, with its time zone.", 400);
  if (command.earliestAt && (Date.parse(command.earliestAt) < Date.parse(show.clock) || Date.parse(command.earliestAt) > Date.parse(show.accessUntil) + 7 * 24 * 60 * 60 * 1000)) throw new DomainError("SUPPLIER_DELIVERY_TIME", "The reported earliest delivery must be at or after the scenario clock and inside the reviewed week.", 400);
  const execution = command.executionId ? show.rentalExecutions?.find(item => item.id === command.executionId && item.offerId === offer.id && item.offerRevision === offer.revision && item.supplierId === offer.supplierId) : null;
  if (command.executionId && !execution) throw new DomainError("SUPPLIER_EXECUTION_CHANGED", "This report does not match the exact original supplier execution.", 403);
  if ((show.supplierDisruptions?.length ?? 0) >= 100) throw new DomainError("DISRUPTION_HISTORY_LIMIT", "This production has reached its bounded report capacity. Retain its source history for review.");
  const now = new Date().toISOString();
  const report: SupplierDisruption = { id: randomUUID(), offerId: offer.id, offerRevision: offer.revision, supplierId: offer.supplierId, unitId: offer.unitId, executionId: execution?.id ?? null, availability: command.availability, earliestAt: command.earliestAt, observedAt: command.observedAt, recordedAt: now, reference: command.reference, detail: command.detail, actorId: actor.id, attribution: supplier ? "supplier_client" : "production_operator", source: "controlled_client", revision: show.revision + 1 };
  (show.supplierDisruptions ??= []).push(report);
  await saveRecord(db, show.tenantId, report.id, "report", report);
  if (execution && !["returned", "returned_unaccepted", "cancelled", "compensation_pending"].includes(execution.state)) {
    execution.state = execution.acceptedAt ? "needs_attention" : "reconfirmation_required"; execution.lastCode = "SUPPLIER_DISRUPTION";
    await saveRentalExecution(db, show, execution);
  }
  show.state = "standby"; show.goReportId = null;
  await saveSupplierSnapshot(db, show, actor.id, "supplier.disruption_reported", `${offer.supplier}: ${command.availability === "unavailable" ? "the unit is reported unavailable" : command.availability === "delayed" ? "a later delivery was reported" : "new availability was attributed"}. Current operating evidence needs a fresh review; original commitments remain recorded.`);
  return { id: report.id, message: "Supplier report saved. Current cue clearance was withdrawn; no payment instruction was created." };
}

async function decide(context: Context, command: Extract<DisruptionEnvelope["command"], { type: "decide" }>) {
  await producer(context); const { db, show, authority } = context;
  const assessment = await readRecord<DisruptionAssessment>(db, show.tenantId, command.assessmentId, "assessment");
  if (assessment.disruptionDigest !== disruptionDigest(show) || !show.disruptionAssessments?.some(item => item.id === assessment.id) || assessment.sourceDigest !== assessmentSourceDigest(show)) throw new DomainError("STALE_DISRUPTION_ASSESSMENT", "Reassess the current supplier and production facts before deciding.");
  const prepared = await cancellationPreview(db, show, command.mode, command.admissionRefundMinor);
  if (!prepared.preview.ready || prepared.preview.digest !== command.previewDigest) throw new DomainError("CANCELLATION_PREVIEW_CHANGED", "Review the current original-capture allocation and all outstanding obligations before approving it.");
  const now = new Date().toISOString(), id = randomUUID(), previousSheet = show.sheets.at(-1)!;
  const cancelledTaskIds = (command.mode === "cancel_show" ? ["vip", "doors", "support", "support-check", "headliner", "headliner-check", "headliner-arrival", "quiet-prep", "changeover"] : ["vip", "headliner", "headliner-check", "headliner-arrival", "quiet-prep", "changeover"]).filter(taskId => show.tasks.some(task => task.id === taskId));
  const basis = { id, mode: command.mode, detail: command.detail, actorId: authority.actor.id, approvedAt: now, expiresAt: new Date(Math.min(Date.now() + 24 * 60 * 60 * 1000, Date.parse(context.expiresAt))).toISOString(), assessmentId: assessment.id, disruptionDigest: disruptionDigest(show), admissionRefundMinor: command.admissionRefundMinor, targets: prepared.targets, newRefundMinor: prepared.preview.newRefundMinor, newRefundCount: prepared.items.length, cancelledTaskIds, noticeSheetVersion: previousSheet.version + 1, remediesStoppedAt: null };
  const decision: CancellationDecision = { ...basis, digest: digest(basis) };
  const record: CancellationRecord = { decision, tenantId: show.tenantId, sessionHash: authority.sessionHash, actor: authority.actor, planVersion: show.planVersion, planDigest: show.approvedPlan?.digest ?? null, allocationDigest: allocationDigest(prepared.items) };
  await saveRecord(db, show.tenantId, id, "decision", record);
  for (const allocation of prepared.items) {
    const item = { ...allocation, id: randomUUID(), decisionId: id };
    await saveRemedyItem(db, item);
    await enqueueJob(db, { tenantId: show.tenantId, kind: "event_remedy", semanticKey: item.id, payload: { decisionId: id, itemId: item.id } });
  }
  show.cancellationDecision = decision;
  const people = show.resources.filter(person => person.kind === "person" && person.critical && !person.reserve).map(person => person.id);
  for (const task of show.tasks) if (cancelledTaskIds.includes(task.id)) task.cancellation = { decisionId: id, reason: command.detail };
  const changes = cancelledTaskIds.map(taskId => { const task = show.tasks.find(item => item.id === taskId)!; return { taskId, name: task.name, before: `${localTime(task.start)}–${localTime(task.end)}`, after: "Cancelled · prior work retained", reason: command.detail.slice(0, 500), resourceIds: task.resources }; });
  changes.push({ taskId: "cancellation-notice", name: command.mode === "cancel_show" ? "Show cancellation notice" : "Support-only running order", before: "Previous program", after: command.mode === "cancel_show" ? "Remaining performances cancelled" : "Headliner cancelled; support requires its own clearance", reason: "Read the current operating notice. Crew calls, earned work, strike, supplier return and all original financial obligations remain in force until separately reviewed.", resourceIds: people });
  const operating = operatingDigest(show);
  show.sheets.push({ id: randomUUID(), version: decision.noticeSheetVersion, planRevision: show.planVersion, candidateId: show.approvedPlan?.candidateId ?? null, digest: digest({ tasks: show.tasks, changes, operating, decisionId: id, version: decision.noticeSheetVersion }), publishedAt: now, tasks: structuredClone(show.tasks), changes, operatingDigest: operating });
  show.state = "standby"; show.goReportId = null;
  await saveSupplierSnapshot(db, show, authority.actor.id, "production.cancellation_approved", `${command.mode === "cancel_show" ? "Show cancellation" : "Support-only program"} approved with ${prepared.items.length} exact remaining original-capture allocations. Internal notice v${decision.noticeSheetVersion} published; provider outcomes and crew obligations remain separate.`);
  return { id, message: `${command.mode === "cancel_show" ? "Show cancellation" : "Support-only decision"} saved. The internal notice is published; ${prepared.items.length} original-capture instructions await their own verified results.` };
}

export async function executeDisruptionCommand(authority: DisruptionAuthority, envelope: DisruptionEnvelope, engine: typeof generateCandidates = generateCandidates): Promise<DisruptionResult> {
  await paymentStore(); const payloadHash = digest(envelope);
  let computed: { candidates: Candidate[]; sourceDigest: string } | null = null;
  if (envelope.command.type === "assess") {
    const initial = await disruptionTransaction(authority, false, async context => { operator(context); const receipt = await originalReceipt(context, envelope.idempotencyKey, payloadHash); if (receipt) return { receipt, workspace: await workspace(context) }; assertRevision(context.show, envelope.expectedRevision); if (!context.show.supplierDisruptions?.length) throw new DomainError("DISRUPTION_REPORT_REQUIRED", "Record an attributed supplier change before reassessing the production."); return { show: context.show }; });
    if ("receipt" in initial && initial.receipt) return { receipt: initial.receipt, workspace: initial.workspace!, replayed: true };
    const show = initial.show!; computed = { candidates: await engine(show), sourceDigest: assessmentSourceDigest(show) };
  }
  return disruptionTransaction(authority, true, async context => {
    const receipt = await originalReceipt(context, envelope.idempotencyKey, payloadHash);
    if (receipt) return { workspace: await workspace(context), receipt, replayed: true };
    assertRevision(context.show, envelope.expectedRevision);
    const command = envelope.command; let result: { id: string | null; message: string };
    if (command.type === "report") result = await reportDisruption(context, command);
    else if (command.type === "assess") {
      operator(context); if (!computed || computed.sourceDigest !== assessmentSourceDigest(context.show)) throw new DomainError("STALE_DISRUPTION_ASSESSMENT", "The production changed while alternatives were being tested. Reassess the current facts.");
      const next = recordRescueRun(context.show, authority.actor, computed.candidates);
      const run = next.runs.at(-1)!;
      const assessment: DisruptionAssessment = { id: randomUUID(), createdAt: new Date().toISOString(), sourceDigest: computed.sourceDigest, disruptionDigest: disruptionDigest(context.show), baseRevision: context.show.revision, runId: run.id, candidateIds: computed.candidates.map(candidate => candidate.id), ...summarizeAssessment(computed.candidates), scope: `${context.show.offers.length} currently enrolled offers × four deterministic running-order families. This is a bounded search, not a proof that every possible production is infeasible.`, source: "deterministic_enumerator" };
      // Save one revision/event for the assessment; the full real engine reports remain on its rescue run.
      context.show.runs.push(run); (context.show.disruptionAssessments ??= []).push(assessment);
      await saveRecord(context.db, context.show.tenantId, assessment.id, "assessment", assessment);
      await saveSupplierSnapshot(context.db, context.show, authority.actor.id, "supplier.disruption_assessed", `Tested ${assessment.generated} bounded alternatives: ${assessment.feasible} approvable, ${assessment.pending} pending evidence, ${assessment.infeasible} infeasible. No commitment or physical sign-off was created.`);
      result = { id: assessment.id, message: assessment.conclusion === "no_feasible_candidate" ? "No feasible candidate in the tested set. Review the source constraints and cancellation options." : assessment.conclusion === "evidence_pending" ? "Current alternatives remain pending evidence. Missing evidence is not an infeasibility proof." : "Current alternatives are available for a new production review." };
    } else if (command.type === "decide") result = await decide(context, command);
    else if (command.type === "cancel_rental") {
      await producer(context);
      const intent = await prepareRentalCancellation(context.db, context.show, authority.actor, command.executionId, command.detail, { sessionHash: authority.sessionHash, expiresAt: new Date(Math.min(Date.now() + 24 * 60 * 60 * 1000, Date.parse(context.expiresAt))).toISOString() });
      result = { id: intent.id, message: "Approved cancellation of the exact original uncaptured authorization. Its provider result remains pending; no captured fee was reversed." };
    }
    else {
      await producer(context);
      const decision = await readDecision(context.show.tenantId, command.decisionId, context.db);
      if (command.type === "stop_remedies") {
        if (context.show.cancellationDecision?.id !== command.decisionId) throw new DomainError("CANCELLATION_CHANGED", "Review the current cancellation before stopping its unstarted refunds.");
        await context.db.query("INSERT INTO on_disruption_stops(tenant_id,decision_id,actor_id,detail_cipher) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [context.show.tenantId, command.decisionId, authority.actor.id, sealIntelligence(context.show.tenantId, `cancellation-stop:${command.decisionId}`, { detail: command.detail, commandId: envelope.idempotencyKey })]);
        context.show.cancellationDecision.remediesStoppedAt ??= new Date().toISOString();
        await saveSupplierSnapshot(context.db, context.show, authority.actor.id, "production.remedies_stopped", "Stopped unstarted cancellation refunds. In-flight original instructions still require reconciliation; the operating cancellation remains in force.");
        result = { id: command.decisionId, message: "Unstarted refunds stopped. Any already authorized or uncertain instruction keeps its original identity for reconciliation." };
      } else if (command.type === "retry_remedy") {
        if (decision.sessionHash !== authority.sessionHash || decision.actor.id !== authority.actor.id || context.show.cancellationDecision?.id !== decision.decision.id || context.show.cancellationDecision.remediesStoppedAt || Date.parse(decision.decision.expiresAt) <= Date.now()) throw new DomainError("EVENT_REMEDY_AUTHORITY_ENDED", "Only the exact still-active approving session may retry its original refused instruction.", 403);
        const item = await readRemedyItem(context.show.tenantId, command.itemId, context.db);
        if (item.allocation.decisionId !== command.decisionId || !item.progress.intentId) throw new DomainError("ORIGINAL_INTENT_REQUIRED", "This allocation has no original prepared instruction to retry.");
        const intent = await readIntent(context.show.tenantId, item.progress.intentId, context.db), operation = await (await paymentStore()).get(intent.command.scope, intent.id);
        if (!operation || !["refused", "not_sent"].includes(operation.status)) throw new DomainError("RECONCILE_ORIGINAL_FIRST", "An unknown, pending or completed instruction cannot be resent. Reconcile its original identity.");
        await enqueueJob(context.db, { tenantId: context.show.tenantId, kind: "event_remedy_retry", semanticKey: envelope.idempotencyKey, payload: { decisionId: command.decisionId, itemId: command.itemId, intentId: intent.id } });
        await saveSupplierSnapshot(context.db, context.show, authority.actor.id, "production.remedy_retry_reviewed", "Recorded an explicit retry of the same refused original-capture instruction. Current provider budget and exact session authority must still pass.");
        result = { id: command.itemId, message: "Explicit retry recorded for the same original instruction. No replacement payment identity was created." };
      } else {
        for (const { allocation } of await remedyItems(context.show.tenantId, command.decisionId, context.db)) await enqueueJob(context.db, { tenantId: context.show.tenantId, kind: "event_remedy", semanticKey: `${envelope.idempotencyKey}:${allocation.id}`, payload: { decisionId: command.decisionId, itemId: allocation.id } });
        await saveSupplierSnapshot(context.db, context.show, authority.actor.id, "production.remedies_reconciliation_requested", "Queued original cancellation instructions for readback. Uncertain writes cannot be resent and ended authority cannot start a new refund.");
        result = { id: command.decisionId, message: cancellationRemedies(context.show)?.complete ? "All current allocations are already confirmed. Their original receipt history is retained." : "Original instructions queued for reconciliation. Unknown outcomes will be read, never recreated." };
      }
    }
    const saved: DisruptionReceipt = { commandId: envelope.idempotencyKey, action: command.type, requestDigest: payloadHash, recordId: result.id, revision: context.show.revision, message: result.message, at: new Date().toISOString() };
    await saveReceipt(context, payloadHash, saved);
    return { workspace: await workspace(context), receipt: saved, replayed: false };
  });
}
