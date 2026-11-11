import { z } from "zod";
import type { CreatePayout, PayoutBatchObservation, PayoutItemObservation, PayoutRequestItem } from "@fracture/paypal-core";
import type { Actor } from "../contracts";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/), hash = z.string().regex(/^[a-f0-9]{64}$/), note = z.string().trim().min(12).max(1200);
const uuid = z.uuid().transform(value => value.toLowerCase());
export const providerPayoutId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
export const payoutCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve_recipient"), personId: id, previousId: uuid.nullable(), admissionId: id, admissionDigest: hash, detail: note, reviewedRecipient: z.literal(true) }).strict(),
  z.object({ type: z.literal("revoke_recipient"), recipientId: uuid, detail: note, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("approve_payout"), personIds: z.array(id).min(1).max(20), reviewDigest: hash, detail: note, reviewedAmounts: z.literal(true), reviewedRecipients: z.literal(true), reviewedCredits: z.literal(true), reviewedFees: z.literal(true) }).strict(),
  z.object({ type: z.literal("revoke_payout"), grantId: uuid, detail: note, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("refresh_payout"), grantId: uuid }).strict(),
  z.object({ type: z.literal("locate_original"), grantId: uuid, batchId: providerPayoutId, detail: note, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("cancel_unclaimed"), grantId: uuid, senderItemId: uuid, reviewDigest: hash, detail: note, confirmed: z.literal(true) }).strict(),
]);
export const payoutEnvelopeSchema = z.object({ idempotencyKey: uuid, expectedRevision: z.number().int().min(0), expectedSettlementRevision: z.number().int().min(0), expectedShowRevision: z.number().int().positive(), command: payoutCommandSchema }).strict();
export type PayoutCommand = z.infer<typeof payoutCommandSchema>;
export type PayoutEnvelope = z.infer<typeof payoutEnvelopeSchema>;
/** Operator-admitted configuration. A browser cannot supply a receiver. */
export interface RecipientAdmission {
  id: string; tenantId: string; personId: string; label: string; recipientType: "EMAIL" | "PAYPAL_ID"; receiver: string;
  merchantFingerprint: string; expiresAt: string; maxPayoutMinor: number; controlledSandbox: true; digest: string;
}
export interface PayoutContext { id: string; commandId: string; requestDigest: string; actorId: string | null; recordedAt: string; revision: number; productionRevision: number }
export interface RecipientApproval extends PayoutContext { kind: "recipient"; personId: string; personName: string; personDigest: string; version: number; previousId: string | null; admission: RecipientAdmission; detail: string }
export interface PayoutAllocation extends PayoutRequestItem {
  personId: string; personName: string; personDigest: string; recipientId: string; recipientDigest: string;
  liabilityMinor: number; alreadyAllocatedMinor: number; payables: { id: string; digest: string; deltaMinor: number }[];
}
export interface PayoutGrant extends PayoutContext {
  kind: "grant"; merchantFingerprint: string; expiresAt: string; settlementRevision: number; reviewDigest: string; detail: string;
  authority: { actor: Actor; sessionHash: string }; items: PayoutAllocation[]; request: CreatePayout;
}
export type PayoutTransport = "paypal_https" | "local_fixture";
export type PayoutResult<T> = { httpStatus: number | null; debugId: string | null; observedAt: string; source: "live_sandbox" | "sample"; transport: PayoutTransport }
  & ({ outcome: "succeeded"; value: T; recovered: boolean } | { outcome: "refused" | "not_sent" | "unknown"; code: string; originalPayoutBatchId: string | null });
export interface BatchRead extends PayoutContext { kind: "batch_read"; grantId: string; result: PayoutResult<PayoutBatchObservation>; verified: boolean; problem: string | null }
export interface ItemRead extends PayoutContext { kind: "item_read"; grantId: string; senderItemId: string; result: PayoutResult<PayoutItemObservation>; verified: boolean; problem: string | null }
export interface PayoutCancellation extends PayoutContext { kind: "cancel_request"; grantId: string; senderItemId: string; itemId: string; reviewDigest: string; detail: string; expiresAt: string; authority: { actor: Actor; sessionHash: string } }
export type PayoutRecord = RecipientApproval | PayoutGrant | BatchRead | ItemRead | PayoutCancellation
  | PayoutContext & { kind: "recipient_revoked"; recipientId: string; detail: string }
  | PayoutContext & { kind: "grant_revoked"; grantId: string; detail: string }
  | PayoutContext & { kind: "refresh"; grantId: string }
  | PayoutContext & { kind: "locate"; grantId: string; batchId: string; detail: string }
  | PayoutContext & { kind: "dispatch"; grantId: string; providerRequestDigest: string }
  | PayoutContext & { kind: "dispatch_result"; grantId: string; result: PayoutResult<PayoutBatchObservation> }
  | PayoutContext & { kind: "dispatch_held"; grantId: string; code: string }
  | PayoutContext & { kind: "cancel_dispatch"; grantId: string; cancellationId: string }
  | PayoutContext & { kind: "cancel_result"; grantId: string; senderItemId: string; cancellationId: string; result: PayoutResult<PayoutItemObservation>; verified: boolean; problem: string | null };
export interface PayoutState { schemaVersion: 1; revision: number; records: PayoutRecord[] }
export type ItemStatus = "RESERVED" | "UNKNOWN" | "SUCCESS" | "FAILED" | "PENDING" | "UNCLAIMED" | "RETURNED" | "ONHOLD" | "BLOCKED" | "REFUNDED" | "REVERSED" | "REVOKED" | "NOT_SENT";
export interface PayoutItemView {
  senderItemId: string; personId: string; personName: string; recipientId: string; recipientLabel: string; receiver: string; recipientType: "EMAIL" | "PAYPAL_ID";
  amountMinor: number; status: ItemStatus; providerItemId: string | null; historicalSuccess: boolean; historicalSuccessAt: string | null; currentVerified: boolean;
  feeMinor: number | null; observedAt: string | null; problem: string | null; transport: PayoutTransport | null; reservedMinor: number;
  cancellation: { id: string; state: "queued" | "checking" | "returned" | "held" | "not_sent" } | null; cancelReviewDigest: string | null;
}
export interface PayoutGrantView {
  id: string; createdAt: string; expiresAt: string; detail: string; reviewDigest: string; status: "queued" | "revoked" | "held" | "checking" | "resolved";
  providerBatchId: string | null; batchStatus: string | null; batchVerified: boolean; amountMinor: number; items: PayoutItemView[]; canRevoke: boolean; canLocate: boolean; problem: string | null;
}
export interface PayoutPerson {
  person: { id: string; name: string; role: string; color: string }; recipients: RecipientApproval[]; currentRecipient: RecipientApproval | null;
  liabilityMinor: number; allocatedMinor: number; availableMinor: number; pendingReports: number; payables: { id: string; digest: string; deltaMinor: number }[];
  blockers: string[]; preview: Omit<PayoutAllocation, "senderItemId"> | null;
}
export interface PayoutReview { personIds: string[]; items: Omit<PayoutAllocation, "senderItemId">[]; amountMinor: number; merchantFingerprint: string; digest: string; blockers: string[] }
export interface PayoutReceipt { id: string; commandId: string; requestDigest: string; actorId: string; kind: PayoutRecord["kind"]; recordedAt: string; digest: string }
export interface PayoutData {
  schemaVersion: 1; scope: "production"; actorId: string; tenantId: string; revision: number; settlementRevision: number; productionRevision: number; serverAt: string;
  capability: { configured: boolean; mode: "controlled_fixture" | "live_sandbox"; message: string; merchantFingerprint: string | null };
  admissions: RecipientAdmission[]; people: PayoutPerson[]; grants: PayoutGrantView[]; receipts: PayoutReceipt[];
  totals: { approvedLiabilityMinor: number; reservedMinor: number; currentPaidMinor: number; historicalPaidMinor: number; observedFeeMinor: number; feesUnknown: number };
}
export interface PersonalPayoutData { schemaVersion: 1; scope: "personal"; actorId: string; personId: string; serverAt: string; items: (PayoutItemView & { grantId: string; createdAt: string })[] }
export interface PayoutCommandResponse { data: PayoutData; receipt: PayoutReceipt; replayed: boolean }
