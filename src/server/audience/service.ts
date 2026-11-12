import { randomBytes, randomUUID } from "node:crypto";
import { DomainError } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { AUDIENCE_MAX_RECIPIENTS, audienceEnvelopeSchema, type AudienceApproval, type AudienceCapabilityCard, type AudienceDelivery, type AudienceDeliveryPass, type AudienceDraft, type AudienceEnvelope, type AudienceMessageSummary, type AudienceMessageView, type AudienceReceipt, type AudienceResult, type AudienceWorkspace } from "@/domain/audience/contracts";
import { audienceCanDraft, audienceEvent, audienceMessageContent } from "@/domain/audience/policy";
import { env } from "../env";
import { pool } from "../store";
import { advanceAudience, audienceCommandReceipt, audienceFingerprint, audienceIssuer, audienceNow, audiencePassProof, audienceReceipts, audienceReceiptSource, audienceSeal, audienceTokenHash, audienceTransaction, readAudienceRecord, requireAudienceAuthority, sameAudienceIssuer, saveAudienceReceipt, type ApprovalRecord, type AudienceAuthority, type AudienceContext, type CapabilityRecord, type DeliveryRecord, type DraftRecord, type PassRecord, type Progress, type StopRecord } from "./store";

const receiptCache = new WeakMap<AudienceContext, ReturnType<typeof audienceReceipts>>();
function sourceReceipts(context: AudienceContext) {
  let value = receiptCache.get(context);
  if (!value) { value = audienceReceipts(context.db, context.show); receiptCache.set(context, value); }
  return value;
}
async function currentAudienceSource(context: AudienceContext) { return audienceReceiptSource(context.show, await sourceReceipts(context)); }

function owned(context: AudienceContext, issuer: DraftRecord["issuer"]) {
  if (!sameAudienceIssuer(audienceIssuer(context), issuer)) throw new DomainError("AUDIENCE_ORIGINAL_SESSION_REQUIRED", "Only the exact original producer access may recover or continue this reviewed audience instruction.", 403);
}
function verifiedDraft(record: DraftRecord, context: AudienceContext) {
  const { digest: storedDigest, ...body } = record.draft;
  if (record.tenantId !== context.show.tenantId || digest(body) !== storedDigest || record.draft.recipientDigest !== digest(record.draft.recipients.map(item => ({ capabilityId: item.capabilityId, ticketId: item.ticketId, expiresAt: item.expiresAt, receipt: item.receipt }))) || record.draft.contentDigest !== digest(record.draft.recipients.map(item => ({ capabilityId: item.capabilityId, content: item.content })))) throw new DomainError("AUDIENCE_DRAFT_INTEGRITY", "The exact original content and recipient snapshot could not be verified.", 503);
  return record;
}
async function draftFor(context: AudienceContext, id: string) {
  const record = await readAudienceRecord<DraftRecord>(context.db, context.show.tenantId, "draft", id);
  if (!record || record.draft.id !== id) throw new DomainError("AUDIENCE_DRAFT_NOT_FOUND", "This message is not in the current production.", 404);
  owned(context, record.issuer); return verifiedDraft(record, context);
}
async function approvalFor(context: AudienceContext, id: string) {
  const record = await readAudienceRecord<ApprovalRecord>(context.db, context.show.tenantId, "approval", id);
  if (!record || record.tenantId !== context.show.tenantId || record.approval.id !== id) throw new DomainError("AUDIENCE_APPROVAL_NOT_FOUND", "This reviewed delivery approval is not in the current production.", 404);
  owned(context, record.issuer);
  const { digest: saved, ...body } = record.approval;
  if (digest(body) !== saved) throw new DomainError("AUDIENCE_APPROVAL_INTEGRITY", "The exact message approval could not be verified.", 503);
  return record;
}
export async function audienceCapability(context: AudienceContext, id: string) {
  const record = await readAudienceRecord<CapabilityRecord>(context.db, context.show.tenantId, "capability", id);
  if (!record || record.id !== id || record.tenantId !== context.show.tenantId || record.invitation.capabilityId !== id || record.invitation.ticketId !== record.ticketId || record.invitation.expiresAt !== record.expiresAt) throw new DomainError("AUDIENCE_CAPABILITY_NOT_FOUND", "This attendee access is not in the current production.", 404);
  return record;
}
export async function capabilityState(context: AudienceContext, record: CapabilityRecord): Promise<AudienceCapabilityCard["state"]> {
  const revoked = await readAudienceRecord(context.db, context.show.tenantId, "revocation", record.id);
  if (revoked) return "revoked";
  if (Date.parse(record.expiresAt) <= (await audienceNow(context.db)).getTime()) return "expired";
  try { await requireAudienceAuthority(context.db, record.issuer, record.issuer.expiresAt); }
  catch (error) { if (error instanceof DomainError && ["AUDIENCE_SESSION_ENDED", "AUDIENCE_PRODUCER_REQUIRED"].includes(error.code)) return "issuer_ended"; throw error; }
  const ticket = context.show.tickets.find(item => item.id === record.ticketId);
  const receipt = (await sourceReceipts(context)).get(record.ticketId);
  return !ticket || ticket.captureId !== record.captureId || receipt?.originalDigest !== record.receiptDigest || receipt.verification === "unpaid" ? "receipt_changed" : "active";
}
async function recipientCapability(context: AudienceContext, id: string) {
  const record = await audienceCapability(context, id); owned(context, record.issuer);
  if (await capabilityState(context, record) !== "active") throw new DomainError("AUDIENCE_RECIPIENT_ENDED", "One exact reviewed attendee inbox expired, was revoked, or changed. Review a new recipient snapshot.");
  const receipt = (await sourceReceipts(context)).get(record.ticketId);
  if (!receipt || receipt.verification !== "verified") throw new DomainError("AUDIENCE_RECEIPT_UNVERIFIED", "The original capture needs current verification before this inbox can receive a new message.");
  return { record, receipt };
}
async function deliveries(context: AudienceContext, approvalId: string) {
  const rows = (await context.db.query<{ id: string }>("SELECT id FROM on_audience_deliveries WHERE tenant_id=$1 AND approval_id=$2 ORDER BY created_at,id LIMIT 401", [context.show.tenantId, approvalId])).rows;
  if (rows.length > AUDIENCE_MAX_RECIPIENTS) throw new DomainError("AUDIENCE_DELIVERY_BOUND", "The retained inbox inventory exceeds its reviewed bound.", 503);
  return Promise.all(rows.map(async row => {
    const record = await readAudienceRecord<DeliveryRecord>(context.db, context.show.tenantId, "delivery", row.id);
    if (!record || record.tenantId !== context.show.tenantId || record.delivery.id !== row.id || record.delivery.approvalId !== approvalId) throw new DomainError("AUDIENCE_DELIVERY_INTEGRITY", "An original inbox receipt could not be verified.", 503);
    const { digest: storedDigest, ...body } = record.delivery;
    if (digest(body) !== storedDigest || digest({ subject: body.subject, body: body.body }) !== body.contentDigest) throw new DomainError("AUDIENCE_DELIVERY_INTEGRITY", "The delivered content does not match its immutable receipt.", 503);
    return record.delivery;
  }));
}
async function passFor(context: AudienceContext, id: string) {
  const record = await readAudienceRecord<PassRecord>(context.db, context.show.tenantId, "pass", id);
  if (!record || record.id !== id || record.tenantId !== context.show.tenantId) throw new DomainError("AUDIENCE_PASS_NOT_FOUND", "This original delivery pass is not in the current production.", 404);
  owned(context, record.issuer);
  const row = (await context.db.query<{ state: Progress["state"]; processed: number; error_code: string | null; updated_at: string }>(`SELECT state,processed,error_code,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at FROM on_audience_delivery_progress WHERE tenant_id=$1 AND pass_id=$2`, [context.show.tenantId, id])).rows[0];
  if (!row || row.processed > record.limit) throw new DomainError("AUDIENCE_PASS_INTEGRITY", "The original bounded delivery progress could not be verified.", 503);
  return { record, progress: { state: row.state, processed: row.processed, errorCode: row.error_code, updatedAt: row.updated_at } };
}
async function messagePreview(context: AudienceContext, record: DraftRecord) {
  const blockers: string[] = [], draft = record.draft;
  const currentSourceDigest = await currentAudienceSource(context), current = audienceCanDraft(context.show), now = (await audienceNow(context.db)).getTime();
  if (!sameAudienceIssuer(record.issuer, audienceIssuer(context))) blockers.push("This message belongs to different exact producer access.");
  if (Date.parse(draft.expiresAt) <= now) blockers.push("This immutable draft reached its fixed expiry. Create and review a fresh draft.");
  if (draft.sourceDigest !== currentSourceDigest) blockers.push("The event, original receipt or remedy source changed after this message was drafted.");
  blockers.push(...current.blockers);
  for (const recipient of draft.recipients) {
    try {
      const currentRecipient = await recipientCapability(context, recipient.capabilityId);
      if (currentRecipient.record.ticketId !== recipient.ticketId || currentRecipient.record.expiresAt !== recipient.expiresAt || digest(currentRecipient.receipt) !== digest(recipient.receipt)) blockers.push("An original recipient receipt or expiry changed after review.");
    } catch (error) { if (error instanceof DomainError && error.status !== 503) blockers.push(error.message); else throw error; }
  }
  const distinct = [...new Set(blockers)];
  const body = { draftDigest: draft.digest, currentSourceDigest, sessionFingerprint: audienceFingerprint(context.authority.sessionHash), expiresAt: context.expiresAt, revision: context.revision, blockers: distinct };
  return { digest: digest(body), ready: !distinct.length, blockers: distinct, currentSourceDigest };
}
async function messageView(context: AudienceContext, id: string): Promise<AudienceMessageView> {
  const record = await draftFor(context, id), approvalRow = (await context.db.query<{ id: string }>("SELECT id FROM on_audience_approvals WHERE tenant_id=$1 AND draft_id=$2", [context.show.tenantId, id])).rows[0];
  const approval = approvalRow ? (await approvalFor(context, approvalRow.id)).approval : null;
  const stopped = approval ? await readAudienceRecord<StopRecord>(context.db, context.show.tenantId, "stop", approval.id) : null;
  const passes: AudienceDeliveryPass[] = [], currentSourceDigest = await currentAudienceSource(context);
  if (approval) for (const row of (await context.db.query<{ id: string }>("SELECT id FROM on_audience_delivery_passes WHERE tenant_id=$1 AND approval_id=$2 ORDER BY created_at DESC,id LIMIT 40", [context.show.tenantId, approval.id])).rows) {
    const { record: pass, progress } = await passFor(context, row.id);
    passes.push({ id: pass.id, approvalId: pass.approvalId, createdAt: pass.createdAt, limit: pass.limit, ...progress, proof: audiencePassProof(context, pass, progress, currentSourceDigest) });
  }
  return { tenantId: context.show.tenantId, actorId: context.authority.actor.id, sessionFingerprint: audienceFingerprint(context.authority.sessionHash), revision: context.revision, expiresAt: context.expiresAt,
    draft: record.draft, approval, preview: await messagePreview(context, record), deliveries: approval ? await deliveries(context, approval.id) : [], passes, stoppedAt: stopped?.at ?? null, stoppedReason: stopped?.detail ?? null };
}
export async function readAudienceMessage(authority: AudienceAuthority, id: string) { return audienceTransaction(authority, false, context => messageView(context, id)); }

async function workspace(context: AudienceContext): Promise<AudienceWorkspace> {
  const { db, show, authority } = context, receipts = await sourceReceipts(context), capabilities: AudienceCapabilityCard[] = [], messages: AudienceMessageSummary[] = [];
  if (show.tickets.length > 1000) throw new DomainError("AUDIENCE_TICKET_BOUND", "Select a production with at most 1,000 retained ticket records for this audience view.", 422);
  const caps = (await db.query<{ id: string }>("SELECT id FROM on_audience_capabilities WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 401", [show.tenantId])).rows;
  if (caps.length > 400) throw new DomainError("AUDIENCE_CAPABILITY_BOUND", "This audience workspace exceeds its retained access bound.", 503);
  for (const row of caps) {
    const record = await audienceCapability(context, row.id), receipt = receipts.get(record.ticketId);
    capabilities.push({ id: record.id, ticketId: record.ticketId, tier: receipt?.tier ?? "standard", captureReference: receipt?.captureReference ?? "Unverified", expiresAt: record.expiresAt, createdAt: record.createdAt, sessionMatches: sameAudienceIssuer(record.issuer, audienceIssuer(context)), state: await capabilityState(context, record) });
  }
  const now = (await audienceNow(db)).getTime(), sourceDigest = await currentAudienceSource(context);
  for (const row of (await db.query<{ id: string }>("SELECT id FROM on_audience_drafts WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 20", [show.tenantId])).rows) {
    const record = await readAudienceRecord<DraftRecord>(db, show.tenantId, "draft", row.id);
    if (!record) throw new DomainError("AUDIENCE_DRAFT_INTEGRITY", "An original audience message is unavailable.", 503);
    verifiedDraft(record, context);
    const own = sameAudienceIssuer(record.issuer, audienceIssuer(context)), approvalRow = (await db.query<{ id: string }>("SELECT id FROM on_audience_approvals WHERE tenant_id=$1 AND draft_id=$2", [show.tenantId, row.id])).rows[0];
    const approvalRecord = approvalRow ? await readAudienceRecord<ApprovalRecord>(db, show.tenantId, "approval", approvalRow.id) : null, approval = approvalRecord?.approval ?? null;
    const stopped = approval ? Boolean((await db.query("SELECT 1 FROM on_audience_stops WHERE tenant_id=$1 AND approval_id=$2", [show.tenantId, approval.id])).rowCount) : false;
    const delivered = approval ? Number((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM on_audience_deliveries WHERE tenant_id=$1 AND approval_id=$2", [show.tenantId, approval.id])).rows[0]!.count) : 0;
    const pending = approval ? Boolean((await db.query("SELECT 1 FROM on_audience_delivery_passes p JOIN on_audience_delivery_progress s ON s.tenant_id=p.tenant_id AND s.pass_id=p.id WHERE p.tenant_id=$1 AND p.approval_id=$2 AND s.state='pending'", [show.tenantId, approval.id])).rowCount) : false;
    const state = delivered === record.draft.recipients.length ? "complete" : stopped ? "stopped" : Date.parse(approval?.expiresAt ?? record.draft.expiresAt) <= now ? "expired" : record.draft.sourceDigest !== sourceDigest ? "stale" : pending ? "delivering" : approval ? "approved" : "draft";
    messages.push({ id: row.id, kind: record.draft.kind, createdAt: record.draft.createdAt, expiresAt: record.draft.expiresAt, digest: record.draft.digest, sourceRevision: record.draft.sourceRevision, recipientCount: record.draft.recipients.length, sessionMatches: own, approval, delivered, remaining: record.draft.recipients.length - delivered, state });
  }
  const history: AudienceReceipt[] = [];
  for (const row of (await db.query<{ command_id: string }>("SELECT command_id FROM on_audience_commands WHERE tenant_id=$1 AND actor_id=$2 AND session_hash=$3 AND session_expires_at=$4::timestamptz ORDER BY created_at DESC,command_id LIMIT 20", [show.tenantId, authority.actor.id, authority.sessionHash, context.expiresAt])).rows) { const receipt = await audienceCommandReceipt(context, row.command_id); if (receipt) history.push(receipt); }
  const availability = audienceCanDraft(show);
  return { tenantId: show.tenantId, actorId: authority.actor.id, sessionFingerprint: audienceFingerprint(authority.sessionHash), revision: context.revision, showRevision: show.revision, expiresAt: context.expiresAt, serverAt: new Date().toISOString(), sourceDigest, event: audienceEvent(show), canDraft: availability.ready, blockers: availability.blockers, tickets: [...receipts.values()], capabilities, messages, history, controlledQa: env.controlledQa || !process.env.VERCEL && process.env.OPENING_NIGHT_AUDIENCE_CONTROLLED_WIRE === "1" };
}
export async function readAudienceWorkspace(authority: AudienceAuthority) { return audienceTransaction(authority, false, workspace); }

async function invitation(context: AudienceContext, receipt: AudienceReceipt) {
  if (receipt.action !== "create_invite") return undefined;
  const record = await audienceCapability(context, receipt.recordId); owned(context, record.issuer);
  if (await capabilityState(context, record) !== "active") return undefined;
  return record.invitation;
}
async function result(context: AudienceContext, receipt: AudienceReceipt, replayed: boolean): Promise<AudienceResult> {
  const invite = await invitation(context, receipt);
  return { workspace: await workspace(context), receipt, replayed, ...(invite ? { invitation: invite } : {}) };
}
export async function recoverAudienceCommand(authority: AudienceAuthority, id: string) {
  return audienceTransaction(authority, false, async context => {
    const receipt = await audienceCommandReceipt(context, id);
    if (!receipt) throw new DomainError("AUDIENCE_RECEIPT_NOT_FOUND", "No original receipt is recorded for this exact instruction and producer session.", 404);
    return result(context, receipt, true);
  });
}
export async function recoverAudienceInvitation(authority: AudienceAuthority, id: string) {
  return audienceTransaction(authority, false, async context => {
    const record = await audienceCapability(context, id); owned(context, record.issuer);
    if (await capabilityState(context, record) !== "active") throw new DomainError("AUDIENCE_INVITATION_ENDED", "This original invitation expired, was revoked, or changed. It was not renewed.", 410);
    return record.invitation;
  });
}

async function apply(context: AudienceContext, envelope: AudienceEnvelope) {
  const { db, show } = context, command = envelope.command, issuer = audienceIssuer(context), now = await audienceNow(db);
  if (command.type === "create_invite") {
    const receipt = (await sourceReceipts(context)).get(command.ticketId), ticket = show.tickets.find(item => item.id === command.ticketId);
    if (!ticket?.captureId || receipt?.verification !== "verified" || receipt.originalDigest !== command.receiptDigest || receipt.admission === "unverified") throw new DomainError("AUDIENCE_ORIGINAL_CAPTURE_REQUIRED", "Review this ticket's exact currently verified original capture and itemized amounts before opening attendee access.");
    if (Number((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM on_audience_capabilities WHERE tenant_id=$1", [show.tenantId])).rows[0]!.count) >= 400) throw new DomainError("AUDIENCE_CAPABILITY_LIMIT", "This production reached its 400 retained attendee links. Existing invitations and receipts remain available.", 422);
    const id = randomUUID(), token = "att_" + randomBytes(32).toString("base64url"), expiresAt = new Date(Math.min(now.getTime() + command.validForMinutes * 60000, Date.parse(context.expiresAt))).toISOString();
    if (Date.parse(expiresAt) - now.getTime() < 1000) throw new DomainError("AUDIENCE_SESSION_ENDED", "This original producer access has insufficient remaining time to issue a fixed invitation.", 401);
    const record: CapabilityRecord = { id, tenantId: show.tenantId, ticketId: ticket.id, captureId: ticket.captureId, receiptDigest: receipt.originalDigest, issuer, createdAt: now.toISOString(), expiresAt, invitation: { capabilityId: id, ticketId: ticket.id, url: "/attendee#" + token, expiresAt } };
    await db.query("INSERT INTO on_audience_capabilities(tenant_id,id,ticket_id,capture_id,token_hash,issuer_actor_id,issuer_session_hash,issuer_expires_at,expires_at,digest,document_cipher) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [show.tenantId, id, ticket.id, ticket.captureId, audienceTokenHash(token), issuer.actor.id, issuer.sessionHash, issuer.expiresAt, expiresAt, digest(record), audienceSeal(show.tenantId, "capability", id, record)]);
    return { id, message: "Original attendee access saved with a fixed expiry. Only this ticket's event information, original receipt, remedies and controlled inbox are readable. No invitation was sent externally." };
  }
  if (command.type === "revoke_invite") {
    const capability = await audienceCapability(context, command.capabilityId); owned(context, capability.issuer);
    const prior = await readAudienceRecord(db, show.tenantId, "revocation", capability.id);
    if (prior) throw new DomainError("AUDIENCE_ALREADY_REVOKED", "This exact attendee access is already revoked. Its original history remains retained.");
    const record = { tenantId: show.tenantId, capabilityId: capability.id, issuer, at: now.toISOString() };
    await db.query("INSERT INTO on_audience_revocations(tenant_id,capability_id,digest,document_cipher) VALUES($1,$2,$3,$4)", [show.tenantId, capability.id, digest(record), audienceSeal(show.tenantId, "revocation", capability.id, record)]);
    return { id: capability.id, message: "This exact attendee capability is revoked. Previously delivered inbox records remain historical; new reads and deliveries are blocked." };
  }
  if (command.type === "draft_message") {
    const sourceDigest = await currentAudienceSource(context), readiness = audienceCanDraft(show);
    if (!readiness.ready || command.sourceDigest !== sourceDigest) throw new DomainError("AUDIENCE_SOURCE_CHANGED", "Review the current approved event and original remedy sources before creating this immutable draft.");
    const recipients: AudienceDraft["recipients"] = [], event = audienceEvent(show), ticketIds = new Set<string>();
    for (const id of [...command.recipientIds].sort()) {
      const { record, receipt } = await recipientCapability(context, id);
      if (ticketIds.has(record.ticketId)) throw new DomainError("AUDIENCE_DUPLICATE_TICKET", "Select one exact controlled inbox for each original ticket.", 400);
      if (command.kind === "vip_remedy" && (receipt.tier !== "vip" || !receipt.perkMinor || event.vip !== "cancelled")) throw new DomainError("AUDIENCE_VIP_SCOPE", "A VIP remedy message requires a ticket containing the explicitly cancelled soundcheck perk.", 400);
      ticketIds.add(record.ticketId);
      recipients.push({ capabilityId: id, ticketId: record.ticketId, label: "Controlled ticket · " + record.ticketId.slice(-8), expiresAt: record.expiresAt, receipt, content: audienceMessageContent(command.kind, event, receipt, command.note) });
    }
    const id = randomUUID(), expiresAt = new Date(Math.min(now.getTime() + command.validForMinutes * 60000, Date.parse(context.expiresAt), ...recipients.map(item => Date.parse(item.expiresAt)))).toISOString();
    const body = { id, version: 1 as const, templateVersion: command.templateVersion, kind: command.kind, createdAt: now.toISOString(), expiresAt, sourceDigest, sourceRevision: show.revision, event, note: command.note, recipients,
      recipientDigest: digest(recipients.map(item => ({ capabilityId: item.capabilityId, ticketId: item.ticketId, expiresAt: item.expiresAt, receipt: item.receipt }))), contentDigest: digest(recipients.map(item => ({ capabilityId: item.capabilityId, content: item.content }))) };
    const record: DraftRecord = { tenantId: show.tenantId, issuer, draft: { ...body, digest: digest(body) } };
    await db.query("INSERT INTO on_audience_drafts(tenant_id,id,issuer_actor_id,issuer_session_hash,digest,source_digest,document_cipher,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [show.tenantId, id, issuer.actor.id, issuer.sessionHash, digest(record), sourceDigest, audienceSeal(show.tenantId, "draft", id, record), expiresAt]);
    return { id, message: "Exact event, itemized remedy, recipient and message snapshots saved. This draft is unapproved and nothing was delivered." };
  }
  if (command.type === "approve_message") {
    const record = await draftFor(context, command.draftId), preview = await messagePreview(context, record);
    if (!preview.ready || record.draft.digest !== command.draftDigest || preview.digest !== command.previewDigest) throw new DomainError("AUDIENCE_PREVIEW_CHANGED", "Review the exact current source, recipients and message content before approving this controlled-inbox delivery.");
    if ((await db.query("SELECT 1 FROM on_audience_approvals WHERE tenant_id=$1 AND draft_id=$2", [show.tenantId, record.draft.id])).rowCount) throw new DomainError("AUDIENCE_ALREADY_APPROVED", "This original message already has its one exact approval. Read that approval before delivery.");
    const id = randomUUID(), body = { id, draftId: record.draft.id, draftDigest: record.draft.digest, approvedAt: now.toISOString(), expiresAt: record.draft.expiresAt, recipientCount: record.draft.recipients.length, transport: "controlled_inbox" as const };
    const approval: AudienceApproval = { ...body, digest: digest(body) }, saved: ApprovalRecord = { tenantId: show.tenantId, issuer, approval };
    await db.query("INSERT INTO on_audience_approvals(tenant_id,id,draft_id,digest,document_cipher,expires_at) VALUES($1,$2,$3,$4,$5,$6)", [show.tenantId, id, record.draft.id, digest(saved), audienceSeal(show.tenantId, "approval", id, saved), approval.expiresAt]);
    return { id, message: "The producer separately approved this exact content and recipient snapshot for controlled in-app inboxes only. No email was sent and no inbox delivery is claimed yet." };
  }
  const approval = (await approvalFor(context, command.approvalId)).approval;
  if (approval.digest !== command.approvalDigest) throw new DomainError("AUDIENCE_APPROVAL_CHANGED", "Use the exact original approved message and recipient digest.");
  if (command.type === "stop_message") {
    if (await readAudienceRecord(db, show.tenantId, "stop", approval.id)) throw new DomainError("AUDIENCE_ALREADY_STOPPED", "Future delivery under this exact approval is already stopped.");
    const stopped: StopRecord = { tenantId: show.tenantId, approvalId: approval.id, issuer, at: now.toISOString(), detail: command.detail };
    await db.query("INSERT INTO on_audience_stops(tenant_id,approval_id,digest,document_cipher) VALUES($1,$2,$3,$4)", [show.tenantId, approval.id, digest(stopped), audienceSeal(show.tenantId, "stop", approval.id, stopped)]);
    await db.query("UPDATE on_audience_delivery_progress p SET state='interrupted',error_code='AUDIENCE_DELIVERY_STOPPED',updated_at=clock_timestamp() FROM on_audience_delivery_passes r WHERE p.tenant_id=r.tenant_id AND p.pass_id=r.id AND r.tenant_id=$1 AND r.approval_id=$2 AND p.state='pending'", [show.tenantId, approval.id]);
    return { id: approval.id, message: "Remaining controlled-inbox delivery is stopped. Every already committed recipient receipt remains intact; nothing was recalled or resent." };
  }
  const view = await messageView(context, approval.draftId);
  if (!view.preview.ready || view.stoppedAt || Date.parse(approval.expiresAt) <= now.getTime()) throw new DomainError("AUDIENCE_DELIVERY_NOT_CURRENT", "This exact source, recipient approval or fixed expiry no longer permits new delivery.");
  if (view.deliveries.length === view.draft.recipients.length) throw new DomainError("AUDIENCE_DELIVERY_COMPLETE", "Every approved controlled inbox already has its immutable receipt.");
  if ((await db.query("SELECT 1 FROM on_audience_delivery_passes p JOIN on_audience_delivery_progress s ON s.tenant_id=p.tenant_id AND s.pass_id=p.id WHERE p.tenant_id=$1 AND p.approval_id=$2 AND s.state='pending'", [show.tenantId, approval.id])).rowCount) throw new DomainError("AUDIENCE_ORIGINAL_PASS_PENDING", "A saved delivery pass is incomplete. Read and explicitly continue that exact bounded pass before creating another.");
  const id = envelope.commandId, record: PassRecord = { tenantId: show.tenantId, id, approvalId: approval.id, issuer, limit: command.limit, createdAt: now.toISOString() };
  await db.query("INSERT INTO on_audience_delivery_passes(tenant_id,id,approval_id,actor_id,session_hash,limit_count,digest,document_cipher) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [show.tenantId, id, approval.id, issuer.actor.id, issuer.sessionHash, command.limit, digest(record), audienceSeal(show.tenantId, "pass", id, record)]);
  await db.query("INSERT INTO on_audience_delivery_progress(tenant_id,pass_id) VALUES($1,$2)", [show.tenantId, id]);
  return { id, message: `One bounded pass of at most ${command.limit} controlled inboxes is retained. Read this saved pass before running it. Individual recipient receipts, not the pass reservation, establish delivery.` };
}

export async function executeAudienceCommand(authority: AudienceAuthority, instruction: AudienceEnvelope): Promise<AudienceResult> {
  const parsed = audienceEnvelopeSchema.safeParse(instruction);
  if (!parsed.success) throw new DomainError("AUDIENCE_COMMAND_INVALID", "These instructions do not match the exact audience command contract.", 400);
  const envelope = parsed.data, requestDigest = digest(envelope);
  return audienceTransaction(authority, true, async context => {
    if (envelope.sessionFingerprint !== audienceFingerprint(context.authority.sessionHash) || envelope.sessionExpiresAt !== context.expiresAt) throw new DomainError("AUDIENCE_ORIGINAL_SESSION_REQUIRED", "This reviewed instruction belongs to different exact producer access or its fixed expiry. Read the original result; it was not adopted or renewed.", 403);
    const prior = await audienceCommandReceipt(context, envelope.commandId, requestDigest);
    if (prior) return result(context, prior, true);
    if (context.revision !== envelope.expectedRevision) throw new DomainError("AUDIENCE_STALE_REVISION", "Audience access or message state changed. Refresh and review the current facts before continuing.");
    const saved = await apply(context, envelope); await advanceAudience(context);
    const receipt: AudienceReceipt = { commandId: envelope.commandId, action: envelope.command.type, requestDigest, recordId: saved.id, revision: context.revision, at: new Date().toISOString(), message: saved.message };
    await saveAudienceReceipt(context, receipt); return result(context, receipt, false);
  });
}

/** Only failure bookkeeping: no access is granted, content delivered, expiry extended or money changed. */
async function interruptPass(authority: AudienceAuthority, id: string, code: string) {
  await pool.query("UPDATE on_audience_delivery_progress s SET state='interrupted',error_code=$4,updated_at=clock_timestamp() FROM on_audience_delivery_passes p WHERE p.tenant_id=$1 AND p.id=$2 AND p.session_hash=$3 AND s.tenant_id=p.tenant_id AND s.pass_id=p.id AND s.state='pending'", [authority.actor.tenantId, id, authority.sessionHash, code]);
}
export async function runAudienceDelivery(authority: AudienceAuthority, id: string, proof: string, signal: AbortSignal): Promise<AudienceResult> {
  // A proof comes from a current read of the exact original pass. A stale proof never starts work.
  await audienceTransaction(authority, false, async context => {
    const { record, progress } = await passFor(context, id);
    if (audiencePassProof(context, record, progress, await currentAudienceSource(context)) !== proof) throw new DomainError("AUDIENCE_PASS_READ_REQUIRED", "Read this exact original delivery pass again before explicitly continuing it.");
  });
  for (let index = 0; index < 10 && !signal.aborted; index++) {
    let finished = false;
    try {
      finished = await audienceTransaction(authority, true, async context => {
        const { record: pass, progress } = await passFor(context, id);
        if (progress.state !== "pending") return true;
        const approval = (await approvalFor(context, pass.approvalId)).approval, view = await messageView(context, approval.draftId);
        if (view.stoppedAt) throw new DomainError("AUDIENCE_DELIVERY_STOPPED", "The producer stopped remaining delivery under this exact approval.");
        if (!view.preview.ready || Date.parse(approval.expiresAt) <= (await audienceNow(context.db)).getTime()) throw new DomainError("AUDIENCE_DELIVERY_SOURCE_ENDED", "The original source, recipient scope or fixed approval expiry changed. Previously delivered receipts remain intact.");
        const delivered = new Set(view.deliveries.map(item => item.capabilityId)), recipient = view.draft.recipients.find(item => !delivered.has(item.capabilityId));
        if (!recipient || progress.processed >= pass.limit) {
          await context.db.query("UPDATE on_audience_delivery_progress SET state='complete',updated_at=clock_timestamp() WHERE tenant_id=$1 AND pass_id=$2", [context.show.tenantId, id]); await advanceAudience(context); return true;
        }
        const current = await recipientCapability(context, recipient.capabilityId);
        const body = { id: randomUUID(), approvalId: approval.id, draftId: view.draft.id, capabilityId: recipient.capabilityId, ticketId: recipient.ticketId, receivedAt: (await audienceNow(context.db)).toISOString(), transport: "controlled_inbox" as const, contentDigest: recipient.content.digest, sourceDigest: view.draft.sourceDigest, subject: recipient.content.subject, body: recipient.content.body };
        const delivery: AudienceDelivery = { ...body, digest: digest(body) }, saved: DeliveryRecord = { tenantId: context.show.tenantId, delivery, captureId: current.record.captureId, passId: id };
        await requireAudienceAuthority(context.db, pass.issuer, pass.issuer.expiresAt);
        await context.db.query("INSERT INTO on_audience_deliveries(tenant_id,id,approval_id,capability_id,ticket_id,digest,document_cipher) VALUES($1,$2,$3,$4,$5,$6,$7)", [context.show.tenantId, delivery.id, approval.id, recipient.capabilityId, recipient.ticketId, digest(saved), audienceSeal(context.show.tenantId, "delivery", delivery.id, saved)]);
        // Check again after real work, before the recipient transaction commits.
        await recipientCapability(context, recipient.capabilityId);
        const complete = progress.processed + 1 >= pass.limit || view.deliveries.length + 1 >= view.draft.recipients.length;
        await context.db.query("UPDATE on_audience_delivery_progress SET processed=processed+1,state=$3,error_code=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND pass_id=$2", [context.show.tenantId, id, complete ? "complete" : "pending"]);
        await advanceAudience(context); return complete;
      });
    } catch (error) {
      if (error instanceof DomainError && error.status !== 503) { await interruptPass(authority, id, error.code); throw error; }
      throw error;
    }
    if (finished) break;
  }
  return recoverAudienceCommand(authority, id);
}
