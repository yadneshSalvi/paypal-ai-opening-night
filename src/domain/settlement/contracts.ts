import { z } from "zod";

const id = z.string().min(1).max(120);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const detail = z.string().trim().min(12).max(1200);
export const reportedIntervalSchema = z.object({ start: instant, end: instant, unpaidMinutes: z.number().int().min(0).max(1439) }).strict();
export type ReportedInterval = z.infer<typeof reportedIntervalSchema>;
export const timeReportCommandSchema = z.object({
  type: z.literal("report_time"), serviceDay: z.iso.date(), replacesId: z.uuid().nullable(),
  sheetVersion: z.number().int().positive(), sheetDigest: hash,
  intervals: z.array(reportedIntervalSchema).min(1).max(8), detail,
  confirmed: z.literal(true),
}).strict();
export const rateApprovalCommandSchema = z.object({
  type: z.literal("approve_rate"), personId: id, previousRateId: z.uuid().nullable(), effectiveFrom: z.iso.date(),
  currency: z.literal("USD"), hourlyMinor: z.number().int().min(1).max(100000),
  overtimeHourlyMinor: z.number().int().min(1).max(200000), regularMinutes: z.number().int().min(1).max(1440),
  agreement: detail, confirmed: z.literal(true),
}).strict();
export const payableApprovalCommandSchema = z.object({
  type: z.literal("approve_payable"), reportId: z.uuid(), rateId: z.uuid(), reviewDigest: hash, detail,
  reviewedHours: z.literal(true), reviewedRate: z.literal(true), reviewedAdjustment: z.literal(true),
}).strict();
export const timeChangesCommandSchema = z.object({ type: z.literal("request_time_changes"), reportId: z.uuid(), detail }).strict();
export const producerSettlementCommandSchema = z.discriminatedUnion("type", [rateApprovalCommandSchema, payableApprovalCommandSchema, timeChangesCommandSchema]);
export const settlementCommandSchema = z.union([timeReportCommandSchema, producerSettlementCommandSchema]);
const envelope = { idempotencyKey: z.uuid(), expectedRevision: z.number().int().nonnegative(), expectedShowRevision: z.number().int().positive() };
export const personalSettlementEnvelopeSchema = z.object({ ...envelope, command: timeReportCommandSchema }).strict();
export const producerSettlementEnvelopeSchema = z.object({ ...envelope, command: producerSettlementCommandSchema }).strict();
export const settlementEnvelopeSchema = z.object({ ...envelope, command: settlementCommandSchema }).strict();
export type TimeReportCommand = z.infer<typeof timeReportCommandSchema>;
export type ProducerSettlementCommand = z.infer<typeof producerSettlementCommandSchema>;
export type SettlementCommand = z.infer<typeof settlementCommandSchema>;
export type SettlementEnvelope = z.infer<typeof settlementEnvelopeSchema>;

export interface SettlementRecordContext {
  id: string; commandId: string; requestDigest: string; personId: string; actorId: string; recordedAt: string;
  revision: number; productionRevision: number; source: "controlled_client";
}
export interface SettlementCall { id: string; name: string; start: string; end: string }
export interface TimeReport extends SettlementRecordContext {
  kind: "time_report"; personName: string; personDigest: string; serviceDay: string; version: number; replacesId: string | null;
  sheet: { version: number; digest: string; planVersion: number; calls: SettlementCall[] };
  intervals: ReportedInterval[]; minutes: number; unpaidMinutes: number; spanMinutes: number;
  detail: string; scenarioClock: string;
}
export interface ApprovedRate extends SettlementRecordContext {
  kind: "rate"; personName: string; personDigest: string; version: number; previousRateId: string | null;
  effectiveFrom: string; currency: "USD"; hourlyMinor: number; overtimeHourlyMinor: number;
  regularMinutes: number; agreement: string;
}
export interface PayCalculation {
  workedMinutes: number; regularMinutes: number; overtimeMinutes: number;
  regularMinor: number; overtimeMinor: number; totalMinor: number; currency: "USD";
  rounding: "half_up_per_component";
}
export interface Payable extends SettlementRecordContext {
  kind: "payable"; reportId: string; reportDigest: string; rateId: string; rateDigest: string;
  previousPayableId: string | null; previousLiabilityMinor: number; deltaMinor: number;
  calculation: PayCalculation; reviewDigest: string; detail: string;
}
export interface TimeChangeRequest extends SettlementRecordContext { kind: "changes_requested"; reportId: string; detail: string }
export type SettlementRecord = TimeReport | ApprovedRate | Payable | TimeChangeRequest;
export interface SettlementState { schemaVersion: 1; revision: number; records: SettlementRecord[] }
export interface PayableReview {
  reportId: string; rateId: string; rateVersion: number; calculation: PayCalculation;
  previousPayableId: string | null; previousLiabilityMinor: number; deltaMinor: number;
  warnings: string[]; digest: string;
}
export interface ReportView {
  report: TimeReport; current: boolean; status: "reported" | "approved" | "changes_requested" | "superseded";
  payable: Payable | null; changeRequest: TimeChangeRequest | null; preview: PayableReview | null; reviewBlockers: string[];
}
export interface SettlementReceipt { id: string; commandId: string; requestDigest: string; actorId: string; kind: SettlementRecord["kind"]; personId: string; revision: number; recordedAt: string; digest: string }
export interface PersonSettlement {
  person: { id: string; name: string; role: string; color: string };
  rates: ApprovedRate[]; reports: ReportView[]; payables: Payable[];
  approvedBalanceMinor: number; pendingReports: number; creditAdjustments: number;
}
export interface SettlementViewContext {
  schemaVersion: 1; actorId: string; revision: number; productionRevision: number; serverAt: string;
  production: { title: string; showDate: string; zone: "America/Chicago"; clock: string; allowedDays: string[]; sheet: { version: number; digest: string } | null };
  controlledQa: boolean; receipts: SettlementReceipt[];
  paymentCapability: "separate_payout_review_required";
}
export interface PersonalSettlementData extends SettlementViewContext { scope: "personal"; personal: PersonSettlement }
export interface ProductionSettlementData extends SettlementViewContext {
  scope: "production"; tenantId: string; people: PersonSettlement[];
  totals: { reportedMinutes: number; pendingReports: number; approvedBalanceMinor: number; creditAdjustments: number };
}
export type SettlementData = PersonalSettlementData | ProductionSettlementData;
export interface SettlementCommandResponse<T extends SettlementData = SettlementData> { data: T; receipt: SettlementReceipt; replayed: boolean }
