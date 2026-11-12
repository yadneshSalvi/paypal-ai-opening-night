import { cookies } from "next/headers";
import type { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { SESSION_COOKIE, requireActor, errorResponse } from "../http";
import { sessionTokenHash } from "../session-records";
import { boundedJson } from "../bounded-body";
import type { IntelligenceAuthority } from "./ledger";

export async function planningAuthority(request: Request): Promise<IntelligenceAuthority> {
  const actor = await requireActor(request), authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new DomainError("SESSION_REQUIRED", "Open your current production session.", 401);
  return { actor, sessionHash: sessionTokenHash(token) };
}
/** A never-received instruction cannot adopt a later same-token expiry. */
export async function planningDispatchAuthority(request: Request): Promise<IntelligenceAuthority> {
  const authority = await planningAuthority(request), expectedExpiry = request.headers.get("x-opening-night-planning-expiry"), expectedAccessId = request.headers.get("x-opening-night-planning-access");
  if (!expectedExpiry || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(expectedExpiry) || !Number.isFinite(Date.parse(expectedExpiry)) || new Date(expectedExpiry).toISOString().slice(0, 23) !== expectedExpiry.slice(0, 23)) throw new DomainError("PLANNING_REVIEW_REQUIRED", "Read the current planning workspace before creating this new model instruction.", 409);
  if (!expectedAccessId || !/^[a-f0-9]{64}$/.test(expectedAccessId)) throw new DomainError("PLANNING_REVIEW_REQUIRED", "Read the current planning workspace before creating this new model instruction.", 409);
  return { ...authority, expectedExpiry, expectedAccessId };
}
export async function planningBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await boundedJson(request, 30000));
  if (!parsed.success) throw new DomainError("INVALID_PLANNING_COMMAND", "These instructions do not match the saved planning contract.", 400);
  return parsed.data;
}
export function planningJson(value: unknown) { return Response.json(value, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } }); }
export function planningError(error: unknown) { const response = errorResponse(error); response.headers.set("Cache-Control", "private, no-store"); return response; }
