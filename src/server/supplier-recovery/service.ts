import { randomBytes, randomUUID } from "node:crypto";
import { DomainError } from "@/domain/contracts";
import { createFixture } from "@/domain/fixture";
import { disruptionDigest, latestSupplierDisruption } from "@/domain/disruptions";
import { currentActual } from "@/domain/finance";
import { digest } from "@/domain/hash";
import { currentRentalExecution, supplierIds, type SupplierId } from "@/domain/supplier-contracts";
import { supplierRecoveryBasis, supplierRecoveryEnvelopeSchema, type SupplierRecoveryEnvelope, type SupplierTermInput, type SupplierTermsRecord, type SupplierTermRef } from "@/domain/supplier-recovery";
import { enqueueJob } from "../jobs";
import { assertRevision, saveSupplierSnapshot } from "../supplier-storage";
import { sessionTokenHash } from "../session-records";
import { openIntelligence, sealIntelligence } from "../intelligence/private-payload";
import { collectSupplierRfq } from "../supplier-rfq";
import type { SupplierTransport } from "../supplier-protocol";
import { readRecoveryRfq, readSupplierTerms, requireSupplierRecoveryAuthority, saveRecoveryRfq, saveSupplierRecoveryReceipt, saveSupplierTerms, supplierRecoveryReceipt, supplierRecoveryTransaction, supplierTermsBlocker, supplierUnitCommitted, type RecoveryContext } from "./store";
import type { RecoveryRfqRecord, RetainedRentalSummary, SupplierInvitation, SupplierRecoveryAuthority, SupplierRecoveryPreview, SupplierRecoveryReceipt, SupplierRecoveryResult, SupplierRecoveryWorkspace, SupplierTermsCard } from "./contracts";

async function cards(context: RecoveryContext): Promise<SupplierTermsCard[]> {
  const { db, show, authority } = context, supplier = authority.actor.roles.includes("supplier");
  const result: SupplierTermsCard[] = [];
  for (const base of createFixture(show.tenantId).offers.filter(offer => !supplier || offer.supplierId === authority.actor.supplierId)) {
    const supplierId = base.supplierId as SupplierId, reference = show.supplierTermRevisions?.find(item => item.supplierId === supplierId) ?? null;
    const source = reference ? await readSupplierTerms(db, show.tenantId, reference.id) : null;
    const report = latestSupplierDisruption(show, base), blocker = source ? await supplierTermsBlocker(db, show, source.record, source.digest) : null;
    const committed = await supplierUnitCommitted(db, show.tenantId, supplierId, base.unitId, source?.record.input.deliveryAt ?? show.clock, show.accessUntil);
    const blockers: string[] = [];
    if (report?.availability === "unavailable") blockers.push("This supplier must record available-again capacity before new terms can be quoted.");
    if (blocker) blockers.push(blocker.message);
    if (!reference && Date.parse(base.expiresAt) <= Date.parse(show.clock)) blockers.push("The initial scenario quote expired. This supplier must publish a new edition with current delivery and expiry times.");
    if (committed) blockers.push("This exact unit is still committed on an original rental. Its return or release remains separate.");
    result.push({ supplierId, supplier: base.supplier, offerId: base.id, unitId: base.unitId, feeMinor: source?.record.input.feeMinor ?? base.feeMinor, depositMinor: source?.record.input.depositMinor ?? base.depositMinor, deliveryAt: source?.record.input.deliveryAt ?? base.deliveryAt, scenarioDeadline: source?.record.input.expiresAt ?? base.expiresAt, reference, input: source?.record.input ?? null,
      actorLabel: source ? `${base.supplier} · scoped supplier access` : null, scenarioAt: source?.record.scenarioAt ?? null,
      report: report ? { id: report.id, availability: report.availability, earliestAt: report.earliestAt, reference: report.reference } : null,
      usable: !blockers.length, blockers, inventoryCommitted: committed });
  }
  return result;
}
function retained(context: RecoveryContext): RetainedRentalSummary[] {
  const { show } = context, actual = currentActual(show), active = currentRentalExecution(show), bases = createFixture(show.tenantId).offers;
  return (show.rentalExecutions ?? []).map(execution => {
    const verifiedFeeMinor = actual.filter(item => item.kind === "capture" && item.purpose === "rental" && item.parentId === execution.authorizationId).reduce((sum, item) => sum + item.amountMinor, 0);
    return { id: execution.id, supplierId: execution.supplierId, supplier: bases.find(item => item.supplierId === execution.supplierId)?.supplier ?? execution.supplierId,
      unitId: execution.unitId, originalPlanVersion: execution.planVersion, state: execution.state, feeMinor: execution.feeMinor, depositMinor: execution.depositMinor,
      verifiedFeeMinor, feeInstructionPending: Boolean(execution.captureIntentId && !verifiedFeeMinor), accepted: Boolean(execution.acceptedAt), current: active?.id === execution.id };
  });
}
async function preview(context: RecoveryContext): Promise<SupplierRecoveryPreview> {
  const { show, db, authority } = context; const blockers: string[] = [], active = currentRentalExecution(show);
  if (show.commercialProtocol !== 2) blockers.push("This original rehearsal retains its legacy commercial workflow.");
  if (show.cancellationDecision?.mode === "cancel_show") blockers.push("The producer cancelled this show. Supplier terms cannot reopen its program.");
  if (active && !["cancelled", "returned", "returned_unaccepted"].includes(active.state)) {
    const report = latestSupplierDisruption(show, active);
    if (!report || report.offerRevision < active.offerRevision || Date.parse(report.recordedAt) < Date.parse(active.createdAt)) blockers.push("Record the current change affecting the committed unit before reviewing replacement quotes.");
  }
  if ((await db.query("SELECT 1 FROM on_supplier_rfqs WHERE tenant_id=$1 AND status='collecting' LIMIT 1", [show.tenantId])).rowCount) blockers.push("An original quote collection is still pending. Read or continue that collection before creating another.");
  const retainedRentals = retained(context), supplierTerms = supplierIds.map(supplierId => {
    const reference = show.supplierTermRevisions?.find(item => item.supplierId === supplierId);
    const base = createFixture(show.tenantId).offers.find(item => item.supplierId === supplierId)!;
    return { supplierId, termsId: reference?.id ?? null, termsDigest: reference?.digest ?? null, sourceReportId: latestSupplierDisruption(show, base)?.id ?? null };
  });
  const content = { revision: show.revision, ready: !blockers.length, blockers, retained: retainedRentals, supplierTerms,
    disruptionDigest: disruptionDigest(show), currentPlanVersion: show.planVersion, replacesApprovedPlan: Boolean(show.approvedPlan),
    program: show.cancellationDecision?.mode === "cancel_show" ? "cancelled" as const : show.cancellationDecision?.mode === "support_only" ? "support_only" as const : "full" as const };
  return { ...content, digest: digest({ content, basis: supplierRecoveryBasis(show), sessionHash: authority.sessionHash, expiresAt: context.expiresAt }) };
}
async function workspace(context: RecoveryContext): Promise<SupplierRecoveryWorkspace> {
  const { authority, db, show } = context, supplier = authority.actor.roles.includes("supplier");
  const historyRows = (await db.query<{ command_id: string }>("SELECT command_id FROM on_supplier_recovery_commands WHERE tenant_id=$1 AND actor_id=$2 AND session_hash=$3 ORDER BY created_at DESC,command_id LIMIT 12", [show.tenantId, authority.actor.id, authority.sessionHash])).rows;
  const history = (await Promise.all(historyRows.map(row => supplierRecoveryReceipt(context, row.command_id)))).filter((item): item is SupplierRecoveryReceipt => Boolean(item));
  const requests: SupplierRecoveryWorkspace["requests"] = [];
  if (!supplier) {
    const rows = (await db.query<{ id: string; status: "collecting" | "applied" | "needs_review"; last_code: string | null; outcomes: SupplierRecoveryWorkspace["requests"][number]["outcomes"]; created_at: Date }>("SELECT id,status,last_code,outcomes,created_at FROM on_supplier_rfqs WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 8", [show.tenantId])).rows;
    for (const row of rows) {
      const record = await readRecoveryRfq(db, show.tenantId, row.id);
      requests.push({ id: row.id, status: row.status, lastCode: row.last_code, outcomes: row.outcomes, sessionMatches: Boolean(record && record.sessionHash === authority.sessionHash && digest(record.actor) === digest(authority.actor)), expiresAt: record?.expiresAt ?? null, createdAt: row.created_at.toISOString() });
    }
  }
  return { tenantId: show.tenantId, actorId: authority.actor.id, sessionFingerprint: digest({ purpose: "supplier-recovery-client", sessionHash: authority.sessionHash }),
    expiresAt: context.expiresAt, serverAt: new Date().toISOString(), revision: show.revision, clock: show.clock, accessUntil: show.accessUntil,
    access: supplier ? "supplier" : authority.actor.roles.includes("producer") ? "producer" : "operator", supplierId: supplier ? authority.actor.supplierId as SupplierId : null,
    cards: await cards(context), preview: supplier ? null : await preview(context), history, requests };
}
export async function readSupplierRecoveryWorkspace(authority: SupplierRecoveryAuthority) { return supplierRecoveryTransaction(authority, false, workspace); }
async function invitationFor(context: RecoveryContext, receipt: SupplierRecoveryReceipt): Promise<SupplierInvitation | undefined> {
  if (receipt.action !== "open_supplier") return undefined;
  const row = (await context.db.query<{ document_cipher: string }>("SELECT document_cipher FROM on_supplier_recovery_invites WHERE tenant_id=$1 AND id=$2 AND producer_session_hash=$3", [context.show.tenantId, receipt.recordId, context.authority.sessionHash])).rows[0];
  if (!row) throw new DomainError("SUPPLIER_INVITATION_INTEGRITY", "The original controlled supplier access could not be recovered.", 503);
  return openIntelligence<SupplierInvitation>(context.show.tenantId, `supplier-recovery-invite:${receipt.recordId}`, row.document_cipher);
}
export async function recoverSupplierRecoveryCommand(authority: SupplierRecoveryAuthority, commandId: string): Promise<SupplierRecoveryResult> {
  return supplierRecoveryTransaction(authority, false, async context => {
    const receipt = await supplierRecoveryReceipt(context, commandId);
    if (!receipt) throw new DomainError("SUPPLIER_RECOVERY_RECEIPT_NOT_FOUND", "No receipt is recorded for this exact instruction and session. Review before explicitly retrying the same bytes.", 404);
    return { workspace: await workspace(context), receipt, replayed: true, invitation: await invitationFor(context, receipt) };
  });
}
async function openSupplier(context: RecoveryContext, supplierId: SupplierId) {
  await requireSupplierRecoveryAuthority(context.db, context.authority, "producer", context.expiresAt);
  if (context.show.commercialProtocol !== 2) throw new DomainError("LEGACY_RENTAL_PRESERVED", "This original rehearsal retains its legacy supplier access.");
  const base = createFixture(context.show.tenantId).offers.find(item => item.supplierId === supplierId)!;
  const id = randomUUID(), token = randomBytes(32).toString("base64url"), now = (await context.db.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
  const actor = { id: `supplier:${supplierId}:${randomUUID()}`, tenantId: context.show.tenantId, roles: ["supplier"], personId: null, supplierId };
  const expiresAt = new Date(Math.min(now.getTime() + 24 * 60 * 60000, Date.parse(context.expiresAt))).toISOString().replace("Z", "000Z");
  const invitation: SupplierInvitation = { url: "/supplier/access#" + token, supplierId, expiresAt };
  await context.db.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,$4)", [sessionTokenHash(token), context.show.tenantId, actor, expiresAt]);
  await context.db.query("INSERT INTO on_supplier_recovery_invites(tenant_id,id,producer_session_hash,document_cipher) VALUES($1,$2,$3,$4)", [context.show.tenantId, id, context.authority.sessionHash, sealIntelligence(context.show.tenantId, `supplier-recovery-invite:${id}`, invitation)]);
  await saveSupplierSnapshot(context.db, context.show, context.authority.actor.id, "supplier.scoped_access_opened", `The producer opened controlled ${base.supplier} access to its own enrolled unit and retained rentals. No external invitation was sent and no commercial approval was created.`);
  return { id, message: `Controlled ${base.supplier} access is ready with a fixed expiry. It can publish only that supplier's terms and review its own original rentals.` };
}
async function publish(context: RecoveryContext, input: SupplierTermInput) {
  const { db, show, authority } = context; await requireSupplierRecoveryAuthority(db, authority, "supplier", context.expiresAt);
  const base = createFixture(show.tenantId).offers.find(offer => offer.id === input.offerId && offer.supplierId === authority.actor.supplierId);
  if (!base) throw new DomainError("SUPPLIER_TERMS_SCOPE", "Publish terms only for this supplier's enrolled unit.", 403);
  const latest = show.supplierTermRevisions?.find(item => item.supplierId === base.supplierId);
  if ((latest?.id ?? null) !== input.previousTermId) throw new DomainError("SUPPLIER_TERMS_CHANGED", "A new edition was published while this form was open. Review that exact source first.");
  const report = latestSupplierDisruption(show, base);
  if ((report?.id ?? null) !== input.sourceReportId) throw new DomainError("SUPPLIER_TERMS_REPORT_CHANGED", "Review the latest attributed availability report before publishing terms.");
  if (report?.availability === "unavailable") throw new DomainError("SUPPLIER_TERMS_WITHDRAWN", "Record available-again capacity through your scoped availability report before publishing replacement terms.");
  if (Date.parse(input.deliveryAt) < Date.parse(show.clock) || Date.parse(input.deliveryAt) >= Date.parse(show.accessUntil) || report?.earliestAt && Date.parse(input.deliveryAt) < Date.parse(report.earliestAt)) throw new DomainError("SUPPLIER_TERMS_DELIVERY", "Delivery must be at or after the current scenario clock and attributed earliest arrival, before venue access closes.", 400);
  if (Date.parse(input.expiresAt) <= Date.parse(show.clock) || Date.parse(input.expiresAt) > Date.parse(input.deliveryAt)) throw new DomainError("SUPPLIER_TERMS_DEADLINE", "The scenario acceptance deadline must be after the current clock and no later than delivery.", 400);
  if ((input.qualifiedDriver === true) !== (input.driverEvidence !== null) || (input.conditionVerified === true) !== (input.conditionEvidence !== null)) throw new DomainError("SUPPLIER_TERMS_EVIDENCE", "A verified controlled driver or condition requires its attributed source. Unknown or negative answers cannot carry a positive evidence claim.", 400);
  const now = (await db.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
  const validUntil = new Date(Math.min(now.getTime() + input.validForMinutes * 60000, Date.parse(context.expiresAt))).toISOString();
  if (Date.parse(validUntil) - now.getTime() < 1000) throw new DomainError("SUPPLIER_RECOVERY_SESSION_ENDED", "This exact supplier access has insufficient remaining time to publish new terms.", 401);
  const record: SupplierTermsRecord = { id: randomUUID(), tenantId: show.tenantId, supplierId: base.supplierId as SupplierId, unitId: base.unitId,
    revision: (latest?.revision ?? 0) + 1, input, actor: authority.actor, sessionHash: authority.sessionHash, sessionExpiresAt: context.expiresAt,
    publishedAt: now.toISOString(), validUntil, scenarioAt: show.clock, source: "controlled_supplier_terms" };
  await saveSupplierTerms(db, record);
  const reference: SupplierTermRef = { id: record.id, digest: digest(record), supplierId: record.supplierId, revision: record.revision, publishedAt: record.publishedAt, validUntil,
    sourceReportId: input.sourceReportId, source: record.source };
  show.supplierTermRevisions = [...(show.supplierTermRevisions ?? []).filter(item => item.supplierId !== record.supplierId), reference];
  show.sources.push({ id: record.id, title: `${base.supplier} controlled current terms · edition ${record.revision}`, source: "sample", recordedAt: record.publishedAt,
    detail: `${input.reference}. ${input.detail} Attributed to this supplier's exact access. Delivery ${input.deliveryAt}; scenario deadline ${input.expiresAt}; real expiry ${validUntil}. Original commitments are retained. Source digest ${reference.digest}.` });
  await saveSupplierSnapshot(db, show, authority.actor.id, "supplier.current_terms_published", `${base.supplier} published controlled current terms for ${base.unitId}. Producer quote collection, scheduling, plan approval and any new commitment remain separate.`);
  return { id: record.id, message: "Current supplier terms saved as a new immutable edition. Original quotes and rentals are retained; nothing was ordered or paid." };
}
async function requestQuotes(context: RecoveryContext, input: Extract<SupplierRecoveryEnvelope["command"], { type: "request_quotes" }>) {
  const { db, show, authority } = context; await requireSupplierRecoveryAuthority(db, authority, "producer", context.expiresAt);
  const reviewed = await preview(context);
  if (!reviewed.ready || reviewed.digest !== input.previewDigest) throw new DomainError("SUPPLIER_RECOVERY_PREVIEW_CHANGED", "Review the current disruption, supplier sources and retained original obligations before requesting quotes.");
  const now = (await db.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now, id = randomUUID();
  const requestIds = Object.fromEntries(supplierIds.map(supplierId => [supplierId, randomUUID()])) as Record<SupplierId, string>;
  await saveSupplierSnapshot(db, show, authority.actor.id, "supplier.replacement_quotes_reviewed", "The producer reviewed current supplier changes and every retained original rental before requesting new quotes. No original payment, return obligation or approved plan was replaced by this review.");
  const record: RecoveryRfqRecord = { id, tenantId: show.tenantId, actor: authority.actor, sessionHash: authority.sessionHash, sessionExpiresAt: context.expiresAt,
    approvedAt: now.toISOString(), expiresAt: new Date(Math.min(now.getTime() + 15 * 60000, Date.parse(context.expiresAt))).toISOString(),
    reviewedRevision: reviewed.revision, expectedRevision: show.revision, previewDigest: reviewed.digest, basisDigest: supplierRecoveryBasis(show), detail: input.detail,
    requestIds, terms: reviewed.supplierTerms, retained: reviewed.retained };
  await db.query("INSERT INTO on_supplier_rfqs(id,tenant_id,actor_id,expected_revision,payload_hash,status,request_ids) VALUES($1,$2,$3,$4,$5,'collecting',$6)", [id, show.tenantId, authority.actor.id, show.revision, digest(record), requestIds]);
  await saveRecoveryRfq(db, record);
  await enqueueJob(db, { tenantId: show.tenantId, kind: "supplier_rfq", semanticKey: id, payload: { rfqId: id }, runAfter: new Date(now.getTime() + 30000) });
  return { id, message: "One exact quote collection is saved with a fixed 15-minute limit, bounded by this session. Continue its original requests; a recovery plan still needs real validation and separate approval." };
}
export async function executeSupplierRecoveryCommand(authority: SupplierRecoveryAuthority, instruction: SupplierRecoveryEnvelope): Promise<SupplierRecoveryResult> {
  const parsed = supplierRecoveryEnvelopeSchema.safeParse(instruction);
  if (!parsed.success) throw new DomainError("SUPPLIER_RECOVERY_COMMAND_INVALID", "The reviewed instruction does not match the supplier recovery contract.", 400);
  const envelope = parsed.data, requestDigest = digest(envelope);
  return supplierRecoveryTransaction(authority, true, async context => {
    const prior = await supplierRecoveryReceipt(context, envelope.commandId, requestDigest);
    if (prior) return { workspace: await workspace(context), receipt: prior, replayed: true, invitation: await invitationFor(context, prior) };
    assertRevision(context.show, envelope.expectedRevision);
    const result = envelope.command.type === "publish_terms" ? await publish(context, envelope.command) : envelope.command.type === "request_quotes" ? await requestQuotes(context, envelope.command) : await openSupplier(context, envelope.command.supplierId);
    const receipt: SupplierRecoveryReceipt = { commandId: envelope.commandId, action: envelope.command.type, requestDigest, recordId: result.id, revision: context.show.revision, at: new Date().toISOString(), message: result.message };
    await saveSupplierRecoveryReceipt(context, receipt);
    return { workspace: await workspace(context), receipt, replayed: false, invitation: await invitationFor(context, receipt) };
  });
}
export async function continueSupplierRecoveryRfq(authority: SupplierRecoveryAuthority, id: string, signal: AbortSignal, transport?: SupplierTransport) {
  await supplierRecoveryTransaction(authority, false, async context => {
    await requireSupplierRecoveryAuthority(context.db, authority, "producer", context.expiresAt);
    const original = await readRecoveryRfq(context.db, authority.actor.tenantId, id);
    if (!original || original.sessionHash !== authority.sessionHash || digest(original.actor) !== digest(authority.actor)) throw new DomainError("SUPPLIER_RFQ_OWNER", "Only the exact producer access that reviewed this request may continue it.", 403);
  });
  const work = await collectSupplierRfq(authority.actor.tenantId, id, signal, transport);
  return { work, workspace: await readSupplierRecoveryWorkspace(authority) };
}
