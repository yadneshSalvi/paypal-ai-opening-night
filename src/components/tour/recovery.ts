import { z } from "zod";
import { canonical } from "@/domain/canonical";
import { tourCommandSchema, type TourCommand } from "@/domain/tour/contracts";
export interface TourIdentity { tenantId: string; actorId: string; sessionFingerprint: string }
const savedSchema = z.object({ version: z.literal(1), tenantId: z.string().min(1), actorId: z.string().min(1), sessionFingerprint: z.string().regex(/^[a-f0-9]{64}$/), at: z.iso.datetime(), hash: z.string().regex(/^[a-f0-9]{64}$/), command: z.unknown() }).strict();
export type PendingTour = TourIdentity & { version: 1; at: string; hash: string; command: TourCommand };
export const recoveryKey = (identity: TourIdentity) => `opening-night:tour:v1:${identity.tenantId}:${identity.actorId}:${identity.sessionFingerprint}`;
export async function wireHash(value: unknown) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))))].map(value => value.toString(16).padStart(2, "0")).join(""); }
export async function preparePending(identity: TourIdentity, raw: TourCommand): Promise<PendingTour> { const command = tourCommandSchema.parse(raw); return { tenantId: identity.tenantId, actorId: identity.actorId, sessionFingerprint: identity.sessionFingerprint, version: 1, at: new Date().toISOString(), command, hash: await wireHash(command) }; }
export async function readPending(raw: string, identity: TourIdentity): Promise<PendingTour> {
  if (raw.length > 1500000) throw new Error("The saved instruction exceeds its recovery limit. It was not sent.");
  const saved = savedSchema.parse(JSON.parse(raw));
  if (saved.tenantId !== identity.tenantId || saved.actorId !== identity.actorId || saved.sessionFingerprint !== identity.sessionFingerprint) throw new Error("The saved instruction belongs to a different session. It was not sent.");
  if (saved.hash !== await wireHash(saved.command)) throw new Error("The saved instruction changed after review. Download it for inspection; it was not sent.");
  const command = tourCommandSchema.parse(saved.command);
  if (saved.hash !== await wireHash(command)) throw new Error("The saved instruction is not in its original reviewed form. It was not sent.");
  return { ...saved, command };
}
