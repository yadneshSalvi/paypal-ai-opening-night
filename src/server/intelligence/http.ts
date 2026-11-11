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
export async function planningBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await boundedJson(request, 30000));
  if (!parsed.success) throw new DomainError("INVALID_PLANNING_COMMAND", "These instructions do not match the saved planning contract.", 400);
  return parsed.data;
}
export function planningJson(value: unknown) { return Response.json(value, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } }); }
export function planningError(error: unknown) { const response = errorResponse(error); response.headers.set("Cache-Control", "private, no-store"); return response; }
