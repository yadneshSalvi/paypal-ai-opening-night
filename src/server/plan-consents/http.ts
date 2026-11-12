import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { planningError, planningJson } from "../intelligence/http";

export function consentJson(value: unknown) {
  const response = planningJson(value);
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
export function consentError(error: unknown) {
  const response = planningError(error);
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
export function reviewToken(request: Request): string {
  const value = request.headers.get("authorization");
  if (!value || !/^Bearer [A-Za-z0-9_-]{43}$/.test(value)) throw new DomainError("PLAN_CONSENT_REVIEW_REQUIRED", "Open the dedicated original review link.", 401);
  return value.slice(7);
}
export function consentCommandId(request: Request): string | null {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== "commandId") || query.getAll("commandId").length > 1) throw new DomainError("PLAN_CONSENT_QUERY", "Use the dedicated review or one original command identity.", 400);
  const id = query.get("commandId");
  if (id !== null && !z.uuid().safeParse(id).success) throw new DomainError("PLAN_CONSENT_COMMAND_ID", "Choose the original command identity.", 400);
  return id;
}
