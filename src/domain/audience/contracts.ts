import { z } from "zod";
import type { Provenance } from "../contracts";

export const AUDIENCE_TEMPLATE_VERSION = "audience-v1" as const;
export const AUDIENCE_MAX_RECIPIENTS = 400;
export const AUDIENCE_DELIVERY_LIMIT = 10;
export const audienceHash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(120).regex(/^[A-Za-z0-9:_-]+$/);
const recipients = z.array(z.uuid()).min(1).max(AUDIENCE_MAX_RECIPIENTS).refine(value => new Set(value).size === value.length, "Select each inbox once.");
export const audienceCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_invite"), ticketId: identity, receiptDigest: audienceHash, validForMinutes: z.number().int().min(15).max(1440), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("revoke_invite"), capabilityId: z.uuid(), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("draft_message"), kind: z.enum(["event_update", "vip_remedy"]), recipientIds: recipients, sourceDigest: audienceHash, templateVersion: z.literal(AUDIENCE_TEMPLATE_VERSION), note: z.string().trim().max(1200), validForMinutes: z.number().int().min(5).max(30) }).strict(),
  z.object({ type: z.literal("approve_message"), draftId: z.uuid(), draftDigest: audienceHash, previewDigest: audienceHash, controlledInboxOnly: z.literal(true), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("deliver_message"), approvalId: z.uuid(), approvalDigest: audienceHash, limit: z.number().int().min(1).max(AUDIENCE_DELIVERY_LIMIT), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("stop_message"), approvalId: z.uuid(), approvalDigest: audienceHash, detail: z.string().trim().min(12).max(500), confirmed: z.literal(true) }).strict(),
]);
export const audienceEnvelopeSchema = z.object({ commandId: z.uuid(), expectedRevision: z.number().int().positive(), sessionFingerprint: audienceHash, sessionExpiresAt: z.iso.datetime({ offset: true }), command: audienceCommandSchema }).strict();
export const audienceWorkSchema = z.object({ commandId: z.uuid(), proof: audienceHash }).strict();
export type AudienceCommand = z.infer<typeof audienceCommandSchema>;
export type AudienceEnvelope = z.infer<typeof audienceEnvelopeSchema>;
export type AudienceWork = z.infer<typeof audienceWorkSchema>;

export interface AudienceIdentity { tenantId: string; actorId: string; sessionFingerprint: string }
export interface AudienceEvent {
  title: string; support: string; venue: string; showDate: string; zone: string;
  program: "full" | "support_only" | "cancelled";
  scheduleStatus: "current" | "under_review";
  label: string; notice: string; doorsAt: string | null;
  performances: { id: "support" | "headliner"; title: string; startsAt: string; endsAt: string; cancelled: boolean }[];
  vip: "scheduled" | "cancelled" | "under_review";
  admission: "eligible" | "not_open" | "suspended" | "cancelled" | "unverified";
  admissionLabel: string;
  source: { planVersion: number; sheetVersion: number | null; publishedAt: string | null; digest: string; provenance: Provenance };
}
export interface AudienceRefund {
  id: string; reference: string; amountMinor: number; admissionMinor: number | null; perkMinor: number | null;
  recordedAt: string; status: "confirmed" | "pending" | "failed" | "unknown";
  historicallyConfirmed: boolean;
  source: Provenance; decision: "vip_perk" | "event_remedy" | "unallocated";
}
export interface AudienceRefundInstruction {
  id: string; createdAt: string; amountMinor: number; admissionMinor: number | null; perkMinor: number | null;
  status: "prepared" | "pending" | "unknown" | "refused" | "not_sent" | "confirmed";
}
export interface AudienceTicketReceipt {
  ticketId: string; tier: "standard" | "vip"; captureReference: string | null; capturedAt: string | null;
  currency: "USD"; admissionMinor: number; perkMinor: number; grossMinor: number;
  originalDigest: string; provenance: Provenance; verification: "verified" | "unknown" | "unpaid";
  refunds: AudienceRefund[]; instructions: AudienceRefundInstruction[]; confirmedRefundMinor: number; currentlyVerifiedRefundMinor: number;
  unallocatedRefundMinor: number; remainingAdmissionMinor: number | null; remainingPerkMinor: number | null;
  remedy: { admissionMinor: number; perkMinor: number; confirmedMinor: number; remainingMinor: number; status: "not_applicable" | "pending" | "partial" | "complete" | "unknown" | "stopped" };
  admission: "eligible" | "refunded" | "unverified";
  notice: string;
}
export interface AudienceInvitation { capabilityId: string; ticketId: string; url: string; expiresAt: string }
export interface AudienceCapabilityCard {
  id: string; ticketId: string; tier: "standard" | "vip"; captureReference: string;
  expiresAt: string; createdAt: string; sessionMatches: boolean;
  state: "active" | "expired" | "revoked" | "issuer_ended" | "receipt_changed";
}
export interface AudienceRecipient {
  capabilityId: string; ticketId: string; label: string; expiresAt: string;
  receipt: AudienceTicketReceipt;
  content: { subject: string; body: string; digest: string };
}
export interface AudienceDraft {
  id: string; version: 1; templateVersion: typeof AUDIENCE_TEMPLATE_VERSION;
  kind: "event_update" | "vip_remedy"; createdAt: string; expiresAt: string;
  sourceDigest: string; sourceRevision: number; event: AudienceEvent; note: string;
  recipients: AudienceRecipient[]; recipientDigest: string; contentDigest: string; digest: string;
}
export interface AudienceApproval {
  id: string; draftId: string; draftDigest: string; digest: string;
  approvedAt: string; expiresAt: string; recipientCount: number; transport: "controlled_inbox";
}
export interface AudienceDelivery {
  id: string; approvalId: string; draftId: string; capabilityId: string; ticketId: string;
  receivedAt: string; transport: "controlled_inbox"; contentDigest: string; sourceDigest: string;
  subject: string; body: string; digest: string;
}
export interface AudienceDeliveryPass {
  id: string; approvalId: string; createdAt: string; updatedAt: string; limit: number; processed: number;
  state: "pending" | "complete" | "interrupted"; errorCode: string | null; proof: string;
}
export interface AudienceMessageSummary {
  id: string; kind: AudienceDraft["kind"]; createdAt: string; expiresAt: string; digest: string;
  sourceRevision: number; recipientCount: number; sessionMatches: boolean;
  approval: AudienceApproval | null; delivered: number; remaining: number;
  state: "draft" | "approved" | "delivering" | "complete" | "stopped" | "stale" | "expired";
}
export interface AudienceMessageView extends AudienceIdentity {
  revision: number; expiresAt: string; draft: AudienceDraft; approval: AudienceApproval | null;
  preview: { digest: string; ready: boolean; blockers: string[]; currentSourceDigest: string };
  deliveries: AudienceDelivery[]; passes: AudienceDeliveryPass[];
  stoppedAt: string | null; stoppedReason: string | null;
}
export interface AudienceReceipt {
  commandId: string; action: AudienceCommand["type"]; requestDigest: string; recordId: string;
  revision: number; at: string; message: string;
}
export interface AudienceWorkspace extends AudienceIdentity {
  revision: number; showRevision: number; expiresAt: string; serverAt: string;
  sourceDigest: string; event: AudienceEvent; canDraft: boolean; blockers: string[];
  tickets: AudienceTicketReceipt[]; capabilities: AudienceCapabilityCard[];
  messages: AudienceMessageSummary[]; history: AudienceReceipt[];
  controlledQa: boolean;
}
export interface AudienceResult {
  workspace: AudienceWorkspace; receipt: AudienceReceipt; replayed: boolean;
  invitation?: AudienceInvitation;
}
export interface AttendeeView {
  capabilityId: string; expiresAt: string; observedAt: string;
  sourceDigest: string;
  event: AudienceEvent; receipt: AudienceTicketReceipt;
  inbox: (AudienceDelivery & { sourceIsCurrent: boolean })[];
  inboxPage: { hasMore: boolean; cursor: string | null };
  transport: "controlled_inbox"; controlledQa: boolean;
}
