import { cookies } from "next/headers";
import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { SESSION_COOKIE, assertProductionScope, errorResponse } from "../http";
import { getActor } from "../store";
import { sessionTokenHash } from "../session-records";
import { boundedJson } from "../bounded-body";
import type { AudienceAuthority } from "./store";

export const AUDIENCE_SESSION_COOKIE = !process.env.VERCEL && process.env.OPENING_NIGHT_AUDIENCE_QA === "1" ? "opening-night-audience-4594-session" : SESSION_COOKIE;
export async function audienceAuthority(request?: Request): Promise<AudienceAuthority> {
  const authorization = request?.headers.get("authorization");
  const token = authorization !== null && authorization !== undefined ? /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization) ? authorization.slice(7) : null : (await cookies()).get(AUDIENCE_SESSION_COOKIE)?.value;
  const actor = token ? await getActor(token) : null;
  if (!actor || !token) throw new DomainError("AUDIENCE_SESSION_REQUIRED", "Open your current producer session to review audience access.", 401);
  if (request) assertProductionScope(actor, request);
  return { actor, sessionHash: sessionTokenHash(token) };
}
export async function audienceBody<T>(request: Request, schema: z.ZodType<T>) {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim();
  if (contentType !== "application/json") throw new DomainError("AUDIENCE_JSON_REQUIRED", "Audience instructions require a JSON request.", 415);
  const parsed = schema.safeParse(await boundedJson(request, 30000));
  if (!parsed.success) throw new DomainError("AUDIENCE_COMMAND_INVALID", "These instructions do not match the exact audience command contract.", 400);
  return parsed.data;
}
const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Vary": "Cookie, Authorization" };
export function audienceJson(value: unknown) { return Response.json(value, { headers: privateHeaders }); }
export function audienceError(error: unknown) { const result = errorResponse(error); for (const [key, value] of Object.entries(privateHeaders)) result.headers.set(key, value); return result; }
export function audienceId(id: string) { if (!z.uuid().safeParse(id).success) throw new DomainError("AUDIENCE_RECORD_ID", "Select the exact original audience record.", 400); return id; }
