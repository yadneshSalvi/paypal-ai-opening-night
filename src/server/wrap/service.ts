import { randomUUID } from "node:crypto";
import { controlledPresentation } from "../judge/presentation";
import type { PoolClient } from "pg";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { uniqueActual } from "@/domain/finance";
import { wrapEnvelopeSchema, type ReportEdition, type WrapData, type WrapEnvelope, type WrapReceipt, type WrapRecord, type WrapResponse, type WrapState } from "@/domain/wrap/contracts";
import { currentEntries, INVOICE_AUTHORITY_MS, invoiceDraft, invoiceReview, invoiceView, ownedInvoiceId, wrapRecords } from "@/domain/wrap/invoices";
import { buildWrapReport } from "@/domain/wrap/report";
import { env } from "../env";
import { enqueueJob } from "../jobs";
import { readPayoutState } from "../payouts/store";
import { readState, type SettlementAuthority } from "../settlement/service";
import { wrapCapability } from "./provider";
import { appendWrapRecord, assertWrapAuthority, readWrapState, wrapRequestHash, wrapShow, wrapTransaction, type WrapPayload } from "./store";

export const wrapReceipt = (record: WrapRecord): WrapReceipt => ({ id: record.id, commandId: record.commandId, kind: record.kind, recordedAt: record.recordedAt, actorId: record.actorId, digest: digest(record) });
export async function reportEditions(db: PoolClient, tenantId: string): Promise<ReportEdition[]> {
  const rows = (await db.query<{ id: string; edition: number; title: string; as_of: Date; report_digest: string; pdf_hash: string; json_hash: string; pages: number; created_by: string; created_at: Date }>("SELECT id,edition,title,as_of,report_digest,pdf_hash,json_hash,pages,created_by,created_at FROM on_wrap_reports WHERE tenant_id=$1 ORDER BY edition DESC", [tenantId])).rows;
  return rows.map(row => ({ id: row.id, edition: row.edition, title: row.title, asOf: row.as_of.toISOString(), reportDigest: row.report_digest, pdfHash: row.pdf_hash, jsonHash: row.json_hash, pages: row.pages, createdBy: row.created_by, createdAt: row.created_at.toISOString() }));
}
export function toolkitResources(show: ShowSnapshot, state: WrapState): WrapData["toolkit"] {
  const entries = new Map<string, WrapData["toolkit"][number]>();
  for (const draft of wrapRecords(state, "invoice_draft")) if (ownedInvoiceId(state, draft.id)) entries.set(`invoice:${draft.id}`, { key: `invoice:${draft.id}`, tool: "get_invoice", label: draft.request.itemName, lineId: `entry:${draft.entryId}` });
  for (const item of uniqueActual(show)) {
    if (item.kind === "capture" && item.purpose === "ticket" && item.parentId) entries.set(`order:${item.parentId}`, { key: `order:${item.parentId}`, tool: "get_order", label: `Original ticket order · ${item.ticketId ?? item.id}`, lineId: `ticket:${item.providerResourceId}` });
    if (item.kind === "refund" && item.purpose === "vip_remedy" && item.parentId) entries.set(`refund:${item.providerResourceId}`, { key: `refund:${item.providerResourceId}`, tool: "get_refund", label: `Original ticket refund · ${item.ticketId ?? item.id}`, lineId: `ticket:${item.parentId}` });
  }
  return [...entries.values()];
}
export async function wrapData(db: PoolClient, show: ShowSnapshot, state: WrapState, authority: SettlementAuthority): Promise<WrapData> {
  const settlement = await readState(db, show), payouts = await readPayoutState(db, show), { capability, admissions } = wrapCapability(show);
  return { schemaVersion: 1, tenantId: show.tenantId, actorId: authority.actor.id, revision: state.revision, productionRevision: show.revision, serverAt: new Date().toISOString(), controlledQa: controlledPresentation(show), report: buildWrapReport(show, settlement, payouts, state, controlledPresentation(show)), entries: currentEntries(state), adjustments: wrapRecords(state, "entry_adjustment"), cashReports: wrapRecords(state, "cash_report"), invoices: wrapRecords(state, "invoice_draft").map(draft => invoiceView(state, draft)), proposals: wrapRecords(state, "proposal"), editions: await reportEditions(db, show.tenantId), receipts: state.records.filter(record => record.actorId !== null).map(wrapReceipt), capability, admissions, toolkit: toolkitResources(show, state) };
}
export async function readWrap(authority: SettlementAuthority) { return wrapTransaction(async db => { const show = await wrapShow(db, authority.actor.tenantId); await assertWrapAuthority(db, authority, show); return wrapData(db, show, await readWrapState(db, show), authority); }); }
export async function readInvoiceReview(authority: SettlementAuthority, id: string, operation: "create" | "send" | "cancel") { return wrapTransaction(async db => { const show = await wrapShow(db, authority.actor.tenantId); await assertWrapAuthority(db, authority, show); const state = await readWrapState(db, show), data = await wrapData(db, show, state, authority); return { data, review: invoiceReview(show, state, invoiceDraft(state, id), operation, data.admissions, data.capability.merchantFingerprint) }; }); }
export async function executeWrap(authority: SettlementAuthority, raw: WrapEnvelope): Promise<WrapResponse> {
  const envelope = wrapEnvelopeSchema.parse(raw), hash = wrapRequestHash(authority, envelope);
  return wrapTransaction(async db => {
    const show = await wrapShow(db, authority.actor.tenantId, true); await assertWrapAuthority(db, authority, show); const state = await readWrapState(db, show);
    const previous = (await db.query<{ payload_hash: string }>("SELECT payload_hash FROM on_commands WHERE tenant_id=$1 AND command_id=$2", [show.tenantId, envelope.idempotencyKey])).rows[0];
    if (previous) {
      if (previous.payload_hash !== hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This saved request identity belongs to different instructions or access.");
      const record = state.records.find(value => value.commandId === envelope.idempotencyKey); if (!record) throw new DomainError("WRAP_RECEIPT_UNAVAILABLE", "The original receipt cannot be verified. No replacement instruction was created.", 503);
      return { data: await wrapData(db, show, state, authority), receipt: wrapReceipt(record), replayed: true };
    }
    if (envelope.expectedRevision !== state.revision || envelope.expectedShowRevision !== show.revision) throw new DomainError("WRAP_REVIEW_STALE", "The production account changed. Refresh and review its current exact sources.");
    const command = envelope.command, entries = currentEntries(state), id = randomUUID(); let payload: WrapPayload, job: { invoiceId: string; grantId: string | null; refreshId: string | null } | null = null;
    switch (command.type) {
      case "save_entry": {
        const input = command.entry, prior = entries.find(record => record.entry.entryId === input.entryId);
        if ((prior?.id ?? null) !== input.previousId || prior && prior.entry.kind !== input.kind) throw new DomainError("WRAP_ENTRY_CHANGED", "Review the exact preceding version and keep the entry's accounting class.");
        if (wrapRecords(state, "invoice_draft").some(draft => draft.entryId === input.entryId)) throw new DomainError("WRAP_INVOICED_ENTRY_LOCKED", "An original invoice binds this approved revenue entry. Keep its amount and purpose intact and reconcile that invoice.");
        if (wrapRecords(state, "entry_adjustment").some(record => record.entryId === input.entryId)) throw new DomainError("WRAP_ADJUSTED_ENTRY_LOCKED", "This approved entry has retained adjustments. Record a new signed adjustment to preserve its original amount.");
        if (entries.some(record => record.entry.entryId !== input.entryId && record.entry.kind === input.kind && record.entry.reference.toLocaleLowerCase("en-US") === input.reference.toLocaleLowerCase("en-US"))) throw new DomainError("WRAP_REFERENCE_DUPLICATE", "That source reference already belongs to an entry in this class. Revise the retained original instead.");
        if (input.sourceIds.some(sourceId => !show.sources.some(source => source.id === sourceId)) || new Set(input.sourceIds).size !== input.sourceIds.length) throw new DomainError("WRAP_SOURCE_CHANGED", "A selected source is not part of this exact production.");
        if (Math.abs(Date.parse(input.serviceDay) - Date.parse(show.showDate)) > 366 * 86_400_000) throw new DomainError("WRAP_SERVICE_PERIOD", "The service day must be within one year of this production's show date.");
        payload = { kind: "entry", entry: input, version: (prior?.version ?? 0) + 1, previousDigest: prior ? digest(prior) : null }; break;
      }
      case "adjust_entry": {
        const entry = entries.find(record => record.entry.entryId === command.entryId && record.id === command.entryRecordId), adjustments = wrapRecords(state, "entry_adjustment").filter(record => record.entryId === command.entryId);
        if (!entry || !["expense", "revenue"].includes(entry.entry.kind) || (adjustments.at(-1)?.id ?? null) !== command.previousAdjustmentId) throw new DomainError("WRAP_ADJUSTMENT_STALE", "Review the exact approved entry and its current adjustment chain.");
        const total = entry.entry.amountMinor + adjustments.reduce((sum, record) => sum + record.deltaMinor, 0) + command.deltaMinor;
        if (!Number.isSafeInteger(total) || total < 0 || total > 1_000_000_000) throw new DomainError("WRAP_ADJUSTMENT_CONSERVATION", "The approved balance must remain a nonnegative safe integer amount.");
        payload = { kind: "entry_adjustment", entryId: command.entryId, entryRecordId: command.entryRecordId, previousAdjustmentId: command.previousAdjustmentId, deltaMinor: command.deltaMinor, reference: command.reference, detail: command.detail }; break;
      }
      case "report_cash": {
        const entry = entries.find(record => record.entry.entryId === command.entryId && record.id === command.entryRecordId), prior = wrapRecords(state, "cash_report").findLast(record => record.cashId === command.cashId);
        if (!entry || !["expense", "revenue"].includes(entry.entry.kind) || (prior?.id ?? null) !== command.previousId || prior && prior.entryId !== command.entryId) throw new DomainError("WRAP_CASH_REVIEW_CHANGED", "Choose the exact current approved entry and prior report.");
        if (wrapRecords(state, "invoice_draft").some(draft => draft.entryId === command.entryId)) throw new DomainError("WRAP_INVOICE_CASH_SCOPE", "This entry is collected through its original invoice. An external report cannot duplicate its collection.");
        const latest = new Map<string, number>(); for (const cash of wrapRecords(state, "cash_report").filter(record => record.entryId === command.entryId)) latest.set(cash.cashId, cash.amountMinor); latest.set(command.cashId, command.amountMinor);
        const net = [...latest.values()].reduce((a, b) => a + b, 0); if (!Number.isSafeInteger(net) || net < 0) throw new DomainError("WRAP_CASH_CONSERVATION", "Reported returns cannot exceed this entry's retained reported payments.");
        if (Date.parse(command.occurredOn) > Date.now() || Math.abs(Date.parse(command.occurredOn) - Date.parse(show.showDate)) > 366 * 86_400_000) throw new DomainError("WRAP_CASH_DATE", "Use an already occurred date within this production's accounting period.");
        payload = { kind: "cash_report", cashId: command.cashId, previousId: command.previousId, previousDigest: prior ? digest(prior) : null, entryId: command.entryId, entryRecordId: command.entryRecordId, amountMinor: command.amountMinor, occurredOn: command.occurredOn, reference: command.reference, detail: command.detail }; break;
      }
      case "prepare_invoice": {
        const entry = entries.find(record => record.entry.entryId === command.entryId && record.id === command.entryRecordId), capability = wrapCapability(show), admission = capability.admissions.find(item => item.id === command.admissionId && item.digest === command.admissionDigest && Date.parse(item.expiresAt) > Date.now());
        if (!entry || entry.entry.kind !== "revenue" || entry.entry.amountMinor <= 0 || !admission || entry.entry.amountMinor > admission.maxInvoiceMinor) throw new DomainError("INVOICE_REVIEW_SCOPE", "A positive current approved revenue entry and matching owned-party admission are required.");
        if (wrapRecords(state, "invoice_draft").some(draft => draft.entryId === entry.entry.entryId) || wrapRecords(state, "cash_report").some(cash => cash.entryId === entry.entry.entryId)) throw new DomainError("INVOICE_ORIGINAL_EXISTS", "This entry already has an original invoice or reported collection. Continue that original accounting identity.");
        if (wrapRecords(state, "entry_adjustment").some(record => record.entryId === entry.entry.entryId)) throw new DomainError("INVOICE_ADJUSTED_ENTRY", "This entry already has separately approved adjustments. Reconcile that account before preparing an invoice.");
        const itemName = `${admission.purposePrefix}: ${entry.entry.label}`;
        if (itemName.length > 200) throw new DomainError("INVOICE_PURPOSE_TOO_LONG", "Shorten the approved entry label before preparing the single-item invoice.");
        payload = { kind: "invoice_draft", entryId: entry.entry.entryId, entryRecordId: entry.id, entryDigest: digest(entry), admission, serviceDay: entry.entry.serviceDay, detail: command.detail, request: { invoiceNumber: `ON-${id.replaceAll("-", "").slice(0, 22)}`, reference: `opening-night:${show.tenantId}:${id}`, merchantEmail: admission.issuerEmail.toLowerCase(), recipientEmail: admission.recipientEmail.toLowerCase(), itemName, money: { currency: "USD", minor: entry.entry.amountMinor } } }; break;
      }
      case "approve_invoice": {
        const draft = invoiceDraft(state, command.invoiceId), capability = wrapCapability(show), review = invoiceReview(show, state, draft, command.operation, capability.admissions, capability.capability.merchantFingerprint);
        if (review.blockers.length || review.digest !== command.reviewDigest) throw new DomainError("INVOICE_REVIEW_CHANGED", "The exact parties, amount, item, dates, terms, original state or admission changed. Refresh this review.");
        payload = { kind: "invoice_grant", invoiceId: draft.id, operation: command.operation, reviewDigest: review.digest, expectedEnvelope: review.envelope, reviewedRawDigest: review.rawDigest, expiresAt: new Date(Date.now() + INVOICE_AUTHORITY_MS).toISOString(), detail: command.detail, authority: { actor: authority.actor, sessionHash: authority.sessionHash } }; job = { invoiceId: draft.id, grantId: id, refreshId: null }; break;
      }
      case "revoke_invoice": {
        const grant = wrapRecords(state, "invoice_grant").find(record => record.id === command.grantId);
        if (!grant || wrapRecords(state, "invoice_revoked").some(record => record.grantId === grant.id) || wrapRecords(state, "invoice_dispatch").some(record => record.grantId === grant.id)) throw new DomainError("INVOICE_ALREADY_CLAIMED", "The instruction is absent, revoked or already claimed. Reconcile its original outcome.");
        payload = { kind: "invoice_revoked", grantId: grant.id, detail: command.detail }; break;
      }
      case "refresh_invoice": {
        const draft = invoiceDraft(state, command.invoiceId);
        if (!wrapRecords(state, "invoice_dispatch").some(record => record.invoiceId === draft.id)) throw new DomainError("INVOICE_NOT_DISPATCHED", "This is a local draft. Review its creation before a provider read is available.");
        payload = { kind: "invoice_refresh", invoiceId: draft.id, authority: { actor: authority.actor, sessionHash: authority.sessionHash } }; job = { invoiceId: draft.id, grantId: null, refreshId: id }; break;
      }
      case "save_proposal": {
        const data = await wrapData(db, show, state, authority);
        if (data.report.contentDigest !== command.reportDigest || new Set(command.lineIds).size !== command.lineIds.length || command.lineIds.some(lineId => !data.report.lines.some(line => line.id === lineId))) throw new DomainError("WRAP_PROPOSAL_STALE", "The selected report rows changed. Refresh the account before saving this proposal.");
        payload = { kind: "proposal", title: command.title, detail: command.detail, lineIds: command.lineIds, reportDigest: command.reportDigest, source: "producer", assistantRunId: null }; break;
      }
    }
    const next = await appendWrapRecord(db, show, state, payload, { request: envelope, authority, commandId: envelope.idempotencyKey, id });
    if (job) await enqueueJob(db, { tenantId: show.tenantId, kind: "invoice_operation", semanticKey: id, payload: { ...job } });
    return { data: await wrapData(db, next.show, next.state, authority), receipt: wrapReceipt(next.record), replayed: false };
  });
}
