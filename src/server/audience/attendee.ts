import { DomainError } from "@/domain/contracts";
import { controlledPresentation } from "../judge/presentation";
import { digest } from "@/domain/hash";
import type { AttendeeView } from "@/domain/audience/contracts";
import { audienceEvent } from "@/domain/audience/policy";
import { env } from "../env";
import { migrate, pool } from "../store";
import { audienceCapability, capabilityState } from "./service";
import { audienceReceiptSource, audienceReceipts, audienceTokenHash, audienceTransaction, readAudienceRecord, type CapabilityRecord, type DeliveryRecord } from "./store";

/** This identity cannot be passed to producer, crew, finance or generic console services. */
export interface AttendeeReader { capabilityId: string; tenantId: string; tokenHash: string }
export async function requireAttendeeReader(request: Request): Promise<AttendeeReader> {
  const authorization = request.headers.get("authorization");
  // Cookies and producer Actor/session tokens are deliberately not alternatives.
  if (!authorization || !/^Bearer att_[A-Za-z0-9_-]{43}$/.test(authorization)) throw new DomainError("ATTENDEE_CAPABILITY_REQUIRED", "Open your private attendee invitation to read this ticket.", 401);
  await migrate();
  const tokenHash = audienceTokenHash(authorization.slice(7));
  const row = (await pool.query<{ id: string; tenant_id: string }>("SELECT id,tenant_id FROM on_audience_capabilities WHERE token_hash=$1", [tokenHash])).rows[0];
  if (!row) throw new DomainError("ATTENDEE_ACCESS_ENDED", "This attendee access is unavailable, expired or revoked.", 401);
  return { capabilityId: row.id, tenantId: row.tenant_id, tokenHash };
}
export async function readAttendee(reader: AttendeeReader, before: string | null = null): Promise<AttendeeView> {
  await migrate();
  const original = await readAudienceRecord<CapabilityRecord>(pool, reader.tenantId, "capability", reader.capabilityId);
  if (!original || audienceTokenHash(original.invitation.url.split("#")[1] ?? "") !== reader.tokenHash) throw new DomainError("ATTENDEE_ACCESS_ENDED", "This private attendee access could not be verified.", 401);
  try {
    return await audienceTransaction(original.issuer, false, async context => {
      const capability = await audienceCapability(context, reader.capabilityId);
      if (capability.tenantId !== reader.tenantId || await capabilityState(context, capability) !== "active") throw new DomainError("ATTENDEE_ACCESS_ENDED", "This attendee access expired, was revoked, or no longer matches its original ticket. It was not renewed.", 401);
      const receipts = await audienceReceipts(context.db, context.show), receipt = receipts.get(capability.ticketId);
      if (!receipt || receipt.originalDigest !== capability.receiptDigest) throw new DomainError("ATTENDEE_ACCESS_ENDED", "The original private ticket binding could not be verified.", 401);
      let cursorAt: string | null = null;
      if (before) {
        const cursor = (await context.db.query<{ created_at: string }>("SELECT created_at::text FROM on_audience_deliveries WHERE tenant_id=$1 AND capability_id=$2 AND id=$3", [reader.tenantId, reader.capabilityId, before])).rows[0];
        if (!cursor) throw new DomainError("ATTENDEE_INBOX_CURSOR", "This inbox position does not belong to your ticket.", 404);
        cursorAt = cursor.created_at;
      }
      const rows = (await context.db.query<{ id: string }>(`SELECT id FROM on_audience_deliveries WHERE tenant_id=$1 AND capability_id=$2 ${before ? "AND (created_at,id)<($3::timestamptz,$4::uuid)" : ""} ORDER BY created_at DESC,id DESC LIMIT 21`, [reader.tenantId, reader.capabilityId, ...(before ? [cursorAt, before] : [])])).rows;
      const inbox: AttendeeView["inbox"] = [], sourceDigest = audienceReceiptSource(context.show, receipts);
      for (const row of rows.slice(0, 20)) {
        const record = await readAudienceRecord<DeliveryRecord>(context.db, reader.tenantId, "delivery", row.id);
        if (!record || record.tenantId !== reader.tenantId || record.captureId !== capability.captureId || record.delivery.capabilityId !== reader.capabilityId || record.delivery.ticketId !== capability.ticketId || record.delivery.id !== row.id) throw new DomainError("AUDIENCE_DELIVERY_INTEGRITY", "An original private inbox receipt could not be verified.", 503);
        const { digest: storedDigest, ...body } = record.delivery;
        if (digest(body) !== storedDigest || digest({ subject: body.subject, body: body.body }) !== body.contentDigest) throw new DomainError("AUDIENCE_DELIVERY_INTEGRITY", "The original delivered message could not be verified.", 503);
        inbox.push({ ...record.delivery, sourceIsCurrent: record.delivery.sourceDigest === sourceDigest });
      }
      // Recheck the fixed reader expiry after all reads and private decoding.
      if (await capabilityState(context, capability) !== "active") throw new DomainError("ATTENDEE_ACCESS_ENDED", "This attendee access ended before the private response could be accepted.", 401);
      return { capabilityId: capability.id, expiresAt: capability.expiresAt, observedAt: new Date().toISOString(), sourceDigest, event: audienceEvent(context.show), receipt, originalDoorsAt: [...context.show.sheets].sort((a, b) => a.version - b.version)[0]?.tasks.find(task => task.id === "doors")?.baselineStart ?? null, inbox, inboxPage: { hasMore: rows.length > 20, cursor: rows.length > 20 ? inbox.at(-1)?.id ?? null : null }, transport: "controlled_inbox", controlledQa: controlledPresentation(context.show) || !process.env.VERCEL && process.env.OPENING_NIGHT_AUDIENCE_CONTROLLED_WIRE === "1" };
    });
  } catch (error) {
    if (error instanceof DomainError && ["AUDIENCE_SESSION_ENDED", "AUDIENCE_PRODUCER_REQUIRED", "SHOW_NOT_FOUND"].includes(error.code)) throw new DomainError("ATTENDEE_ACCESS_ENDED", "This attendee access expired or its issuing producer access ended. It was not renewed.", 401);
    throw error;
  }
}
