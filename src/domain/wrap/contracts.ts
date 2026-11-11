import { z } from "zod";
import type { DraftInvoice, InvoiceObservation } from "@fracture/paypal-core";
import type { Actor } from "../contracts";

export const wrapCategories = ["crew", "artist", "venue", "rental", "travel", "production", "tickets", "sponsorship", "other"] as const;
export type WrapCategory = typeof wrapCategories[number];
export const categoryLabels: Record<WrapCategory, string> = { crew: "Crew", artist: "Artists", venue: "Venue", rental: "Equipment", travel: "Travel", production: "Production", tickets: "Tickets", sponsorship: "Sponsorship", other: "Other" };
const uuid = z.uuid().transform(value => value.toLowerCase()), hash = z.string().regex(/^[a-f0-9]{64}$/), day = z.iso.date();
const note = z.string().trim().min(12).max(2400), label = z.string().trim().min(3).max(160), reference = z.string().trim().min(3).max(240);
const minor = z.number().int().min(0).max(1_000_000_000), sourceId = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/);
export const entryInputSchema = z.object({ entryId: uuid, previousId: uuid.nullable(), kind: z.enum(["baseline_cost", "baseline_revenue", "expense", "revenue"]), category: z.enum(wrapCategories), label, amountMinor: minor, currency: z.literal("USD"), serviceDay: day, reference, detail: note, sourceIds: z.array(sourceId).max(20), reviewedScope: z.literal(true) }).strict();
export type EntryInput = z.infer<typeof entryInputSchema>;
export const wrapCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("save_entry"), entry: entryInputSchema }).strict(),
  z.object({ type: z.literal("adjust_entry"), entryId: uuid, entryRecordId: uuid, previousAdjustmentId: uuid.nullable(), deltaMinor: z.number().int().min(-1_000_000_000).max(1_000_000_000).refine(value => value !== 0), reference, detail: note, reviewedOriginal: z.literal(true) }).strict(),
  z.object({ type: z.literal("report_cash"), cashId: uuid, previousId: uuid.nullable(), entryId: uuid, entryRecordId: uuid, amountMinor: z.number().int().min(-1_000_000_000).max(1_000_000_000).refine(value => value !== 0), occurredOn: day, reference, detail: note, reportedOnly: z.literal(true) }).strict(),
  z.object({ type: z.literal("prepare_invoice"), entryId: uuid, entryRecordId: uuid, admissionId: sourceId, admissionDigest: hash, detail: note }).strict(),
  z.object({ type: z.literal("approve_invoice"), invoiceId: uuid, operation: z.enum(["create", "send", "cancel"]), reviewDigest: hash, detail: note, reviewedParties: z.literal(true), reviewedAmount: z.literal(true), reviewedTerms: z.literal(true), reviewedDelivery: z.literal(true) }).strict(),
  z.object({ type: z.literal("revoke_invoice"), grantId: uuid, detail: note, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("refresh_invoice"), invoiceId: uuid }).strict(),
  z.object({ type: z.literal("save_proposal"), title: label, detail: note, lineIds: z.array(z.string().min(1).max(180)).min(1).max(40), reportDigest: hash }).strict(),
]);
export const wrapEnvelopeSchema = z.object({ idempotencyKey: uuid, expectedRevision: z.number().int().min(0), expectedShowRevision: z.number().int().positive(), command: wrapCommandSchema }).strict();
export type WrapCommand = z.infer<typeof wrapCommandSchema>;
export type WrapEnvelope = z.infer<typeof wrapEnvelopeSchema>;
export interface WrapContext { id: string; commandId: string; requestDigest: string; actorId: string | null; revision: number; productionRevision: number; recordedAt: string }
export interface EntryRecord extends WrapContext { kind: "entry"; entry: EntryInput; version: number; previousDigest: string | null }
export interface CashRecord extends WrapContext { kind: "cash_report"; cashId: string; previousId: string | null; previousDigest: string | null; entryId: string; entryRecordId: string; amountMinor: number; occurredOn: string; reference: string; detail: string }
export interface EntryAdjustment extends WrapContext { kind: "entry_adjustment"; entryId: string; entryRecordId: string; previousAdjustmentId: string | null; deltaMinor: number; reference: string; detail: string }
export interface InvoiceAdmission { id: string; tenantId: string; label: string; issuerEmail: string; recipientEmail: string; purposePrefix: string; currency: "USD"; maxInvoiceMinor: number; merchantFingerprint: string; expiresAt: string; controlledSandbox: true; digest: string }
export interface InvoiceDraft extends WrapContext { kind: "invoice_draft"; entryId: string; entryRecordId: string; entryDigest: string; admission: InvoiceAdmission; serviceDay: string; detail: string; request: DraftInvoice }
/** All economically relevant invoice fields are explicit; null is an observed absence, never a guessed default. */
export interface InvoiceEnvelope {
  id: string; invoiceNumber: string; reference: string; issuerEmail: string; recipientEmail: string; issuerIdentityDigest: string; recipientIdentityDigest: string; currency: "USD"; amountMinor: number;
  item: { name: string; quantity: string; unitMinor: number; description: string | null; unitOfMeasure: string | null; tax: unknown | null; discount: unknown | null };
  invoiceDate: string; dueDate: string | null; paymentTerm: string | null; terms: string | null; note: string | null; memo: string | null;
  configuration: { allowTip: false; allowPartialPayment: false; taxCalculatedAfterDiscount: boolean | null; taxInclusive: boolean | null };
  adjustments: { discount: unknown | null; shipping: unknown | null; custom: unknown | null; tax: unknown | null; tip: unknown | null };
}
export type InvoiceOperation = "create" | "send" | "cancel";
export interface InvoiceGrant extends WrapContext { kind: "invoice_grant"; invoiceId: string; operation: InvoiceOperation; reviewDigest: string; expectedEnvelope: InvoiceEnvelope | null; reviewedRawDigest: string | null; expiresAt: string; detail: string; authority: { actor: Actor; sessionHash: string } }
export interface InvoiceWireProof { method: "GET" | "POST"; path: string; at: string; status: number | null; requestDigest: string | null; responseDigest: string | null; envelope: InvoiceEnvelope | null; mutation: boolean; problem: string | null }
export interface InvoiceResult { outcome: "succeeded" | "refused" | "not_sent" | "unknown"; code: string | null; value: InvoiceObservation | null; raw: unknown | null; rawDigest: string | null; envelope: InvoiceEnvelope | null; verified: boolean; problem: string | null; transport: "paypal_https" | "local_fixture"; observedAt: string; httpStatus: number | null; debugId: string | null; mutationAttempted: boolean; proofs: InvoiceWireProof[] }
export interface InvoiceRead extends WrapContext { kind: "invoice_read"; invoiceId: string; grantId: string | null; refreshId?: string | null; result: InvoiceResult }
export interface ToolkitReceipt extends WrapContext { kind: "toolkit_read"; requestId: string; tool: "get_invoice" | "get_order" | "get_refund"; resourceKey: string; providerId: string; inputDigest: string; reportDigest: string; outcome: "verified_read" | "unverified"; transport: "paypal_https" | "local_fixture"; responseDigest: string | null; data: unknown | null; summary: string; evidence: { path: string; status: number; rawDigest: string; observedAt: string }[] }
export interface WrapProposal extends WrapContext { kind: "proposal"; title: string; detail: string; lineIds: string[]; reportDigest: string; source: "producer" | "assistant"; assistantRunId: string | null }
export type WrapRecord = EntryRecord | EntryAdjustment | CashRecord | InvoiceDraft | InvoiceGrant | InvoiceRead | ToolkitReceipt | WrapProposal
  | WrapContext & { kind: "invoice_revoked"; grantId: string; detail: string }
  | WrapContext & { kind: "invoice_refresh"; invoiceId: string; authority: { actor: Actor; sessionHash: string } }
  | WrapContext & { kind: "invoice_dispatch"; invoiceId: string; grantId: string; operation: InvoiceOperation; requestDigestAtDispatch: string }
  | WrapContext & { kind: "invoice_preflight"; invoiceId: string; grantId: string; operation: InvoiceOperation; proof: InvoiceWireProof; raw: unknown | null }
  | WrapContext & { kind: "invoice_held"; invoiceId: string; grantId: string; code: string }
  | WrapContext & { kind: "toolkit_request"; tool: ToolkitReceipt["tool"]; resourceKey: string; providerId: string; inputDigest: string; reportDigest: string; merchantFingerprint: string; authority: { actor: Actor; sessionHash: string } }
  | WrapContext & { kind: "report_sealed"; reportId: string; reportDigest: string; edition: number; pdfHash: string; jsonHash: string; pages: number };
export interface WrapState { schemaVersion: 1; revision: number; records: WrapRecord[] }
export interface InvoiceView {
  id: string; entryId: string; entryRecordId: string; label: string; serviceDay: string; amountMinor: number; invoiceNumber: string; reference: string; issuer: string; recipient: string; admissionLabel: string;
  providerId: string | null; status: string; verified: boolean; observedAt: string | null; payerUrl: string | null; envelope: InvoiceEnvelope | null; rawDigest: string | null;
  currentCollectedMinor: number; historicalCollectedMinor: number; currentRefundedMinor: number; historicalRefundedMinor: number; outstandingClaimMinor: number; collectionComplete: boolean;
  problem: string | null; transport: "paypal_https" | "local_fixture" | null; grants: { id: string; operation: InvoiceOperation; expiresAt: string; state: "queued" | "dispatched" | "revoked" | "held"; canRevoke: boolean }[];
}
export interface InvoiceReview { invoiceId: string; operation: InvoiceOperation; digest: string; envelope: InvoiceEnvelope | null; rawDigest: string | null; expiresInMinutes: number; blockers: string[]; delivery: "share_link_only"; datePolicy: string; termsPolicy: string }
export interface SourceManifest { productionRevision: number; productionDigest: string; planVersion: number; settlementRevision: number; settlementDigest: string; payoutRevision: number; payoutDigest: string; wrapRevision: number; wrapDigest: string; sourceRefs: { id: string; digest: string; title: string; provenance: string }[] }
export interface LedgerEvidence { id: string; kind: string; digest: string; recordedAt: string; actorId: string | null; providerId: string | null; parentId: string | null; note: string; source: "producer_reported" | "personal_reported" | "approved_liability" | "live_sandbox" | "controlled_fixture" | "modelled" }
export interface LedgerLine {
  id: string; label: string; category: WrapCategory; direction: "income" | "expense" | "hold"; origin: "entry" | "tickets" | "rental" | "crew" | "invoice" | "hold";
  baselineMinor: number | null; approvedMinor: number | null; historicalCashMinor: number; currentCashMinor: number; reportedCashMinor: number; returnedMinor: number;
  reservedMinor: number; currentFeeMinor: number | null; historicalFeeMinor: number | null; feesComplete: boolean; outstandingMinor: number; creditMinor: number; claimMinor: number; holdMinor: number; releasedHoldMinor: number;
  source: string; status: "reconciled" | "reported" | "open" | "uncertain" | "estimate"; serviceDay: string | null; evidence: LedgerEvidence[]; issues: string[];
}
export interface WrapTotals {
  baselineCostMinor: number; baselineRevenueMinor: number; approvedCostMinor: number; approvedRevenueMinor: number; historicalCashInMinor: number; historicalCashOutMinor: number;
  currentCashInMinor: number; currentCashOutMinor: number; reportedCashInMinor: number; reportedCashOutMinor: number; currentFeeMinor: number; historicalFeeMinor: number; unknownFeeCount: number;
  currentNetMovementMinor: number; historicalNetMovementMinor: number; outstandingCostMinor: number; outstandingRevenueMinor: number; creditMinor: number; reservedMinor: number;
  holdsMinor: number; releasedHoldsMinor: number; returnedMinor: number; invoiceClaimsMinor: number; unresolvedCount: number;
  ticketGrossCollectedMinor: number; ticketRefundedMinor: number; invoiceGrossCollectedMinor: number; invoiceRefundedMinor: number;
}
export interface WrapReport {
  schemaVersion: 1; definition: "opening-night.wrap.v1"; id: string; edition: number | null; title: string; tenantId: string; asOf: string; zone: string; period: { from: string; through: string; basis: "production_lifetime" }; currency: "USD"; amountUnit: "minor";
  boundary: "controlled_fixture" | "sandbox_records"; denominator: { kind: "one_production_all_retained_sources"; entries: number; ticketCaptures: number; invoiceDrafts: number; payoutItems: number; ledgerLines: number };
  manifest: SourceManifest; lines: LedgerLine[]; totals: WrapTotals; categories: { id: WrapCategory; label: string; baselineMinor: number; approvedMinor: number; currentCashMinor: number; reportedCashMinor: number; feeMinor: number; outstandingMinor: number; lineIds: string[] }[];
  rescueComparison: { approvedPlanId: string | null; rentalMinor: number; projectedOvertimeMinor: number; remedyMinor: number; totalMinor: number; meaning: string } | null;
  unresolved: { lineId: string; reason: string }[]; limitations: string[]; contentDigest: string;
}
export interface ReportEdition { id: string; edition: number; title: string; asOf: string; reportDigest: string; pdfHash: string; jsonHash: string; pages: number; createdBy: string; createdAt: string }
export interface WrapReceipt { id: string; commandId: string; kind: WrapRecord["kind"]; recordedAt: string; actorId: string | null; digest: string }
export interface ToolkitReadView extends WrapReceipt { tool: ToolkitReceipt["tool"]; providerId: string; transport: ToolkitReceipt["transport"]; outcome: ToolkitReceipt["outcome"]; summary: string; responseDigest: string | null }
export interface WrapData {
  schemaVersion: 1; tenantId: string; actorId: string; revision: number; productionRevision: number; serverAt: string; controlledQa: boolean; report: WrapReport;
  entries: EntryRecord[]; adjustments: EntryAdjustment[]; cashReports: CashRecord[]; invoices: InvoiceView[]; proposals: WrapProposal[]; editions: ReportEdition[]; receipts: WrapReceipt[];
  capability: { configured: boolean; mode: "controlled_fixture" | "live_sandbox"; merchantFingerprint: string | null; message: string; toolkitVersion: "1.11.0" };
  admissions: InvoiceAdmission[]; toolkit: { key: string; tool: ToolkitReceipt["tool"]; label: string; lineId: string }[];
}
export interface WrapResponse { data: WrapData; receipt: WrapReceipt; replayed: boolean }
export const reportRequestSchema = z.object({ idempotencyKey: uuid, expectedRevision: z.number().int().min(0), expectedShowRevision: z.number().int().positive(), title: label, reportDigest: hash }).strict();
export const toolkitRequestSchema = z.object({ idempotencyKey: uuid, expectedRevision: z.number().int().min(0), expectedShowRevision: z.number().int().positive(), resourceKey: z.string().min(1).max(220), tool: z.enum(["get_invoice", "get_order", "get_refund"]), reportDigest: hash }).strict();
