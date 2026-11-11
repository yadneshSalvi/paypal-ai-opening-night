import { cookies } from "next/headers";
import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { boundedJson } from "../bounded-body";
import { requireCrewSession } from "../crew/service";
import { SESSION_COOKIE, errorResponse, requireActor } from "../http";
import { sessionTokenHash } from "../session-records";
import type { SettlementAuthority } from "./service";

export async function settlementAuthority(request: Request, scope: SettlementAuthority["scope"]): Promise<SettlementAuthority> {
  if (scope === "personal") { const access = await requireCrewSession(request); return { actor: access.actor, sessionHash: access.tokenHash, scope }; }
  const actor = await requireActor(request), authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new DomainError("SESSION_REQUIRED", "Open your current production access.", 401);
  return { actor, sessionHash: sessionTokenHash(token), scope };
}
export async function settlementBody<T>(request: Request, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(await boundedJson(request, 20000));
  if (!parsed.success) throw new DomainError("INVALID_SETTLEMENT_COMMAND", "Review the exact time, rate or payable instructions before submitting.", 400);
  return parsed.data;
}
const headers = { "Cache-Control": "private, no-store", Vary: "Authorization, Cookie", "X-Content-Type-Options": "nosniff" };
export function settlementJson(value: unknown) { return Response.json(value, { headers }); }
export function settlementError(error: unknown) { const response = errorResponse(error); for (const [key, value] of Object.entries(headers)) response.headers.set(key, value); return response; }
