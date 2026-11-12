import { cookies } from "next/headers";
import { DomainError, type ConsoleData, type ShowSnapshot, type Actor } from "@/domain/contracts";
import { allReadiness } from "./crew/readiness";
import { crewProductionOverview } from "./crew/projection";
import { getActor } from "./store";
import { PaymentError, ProviderError } from "@fracture/paypal-core";
import { SessionCreationLimitError } from "./session-admission";
import { PRODUCTION_SCOPE_HEADER } from "@/domain/rehearsal-contracts";
import { controlledPresentation } from "./judge/presentation";
import { isDemonstration, JUDGE_PAYMENT_NOTICE } from "@/domain/judge/contracts";
export const SESSION_COOKIE = !process.env.VERCEL && process.env.OPENING_NIGHT_SUPPLIER_RECOVERY_QA === "1" ? "opening-night-supplier-recovery-4586-session" : !process.env.VERCEL && process.env.OPENING_NIGHT_RENTAL_CLOSEOUT_QA === "1" ? "opening-night-rental-closeout-4580-session" : !process.env.VERCEL && process.env.OPENING_NIGHT_DISRUPTION_QA === "1" ? "opening-night-disruption-4564-session" : !process.env.VERCEL && process.env.OPENING_NIGHT_TOUR_QA === "1" ? "opening-night-tour-4561-session" : !process.env.VERCEL && process.env.OPENING_NIGHT_AI_QA === "1" ? "opening-night-ai-qa-session" : "opening-night-session";
export async function currentActor(request?: Request): Promise<Actor | null> {
  const authorization = request?.headers.get("authorization");
  if (authorization != null) return authorization.startsWith("Bearer ") ? getActor(authorization.slice(7)) : null;
  return getActor((await cookies()).get(SESSION_COOKIE)?.value);
}
export function assertProductionScope(actor: Actor, request: Request) {
  const scope = request.headers.get(PRODUCTION_SCOPE_HEADER);
  if (scope && scope !== actor.tenantId) throw new DomainError("PRODUCTION_CHANGED", "This tab belongs to another rehearsal. Reload to see the currently selected production before acting.", 409);
  // A bearer capability carries its own immutable tenant. Cookie-based mutations
  // must also name the production the person is actually viewing in this tab.
  if (!scope && !["GET", "HEAD"].includes(request.method) && !request.headers.get("authorization")?.startsWith("Bearer ")) throw new DomainError("PRODUCTION_SCOPE_REQUIRED", "Refresh this page before changing the production. Its displayed rehearsal must match the current session.", 409);
}
export async function requireActor(request?: Request) { const actor = await currentActor(request); if (!actor) throw new DomainError("SESSION_REQUIRED", "Open a rehearsal session to continue.", 401); if (request) assertProductionScope(actor, request); return actor; }
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url); const host = request.headers.get("host");
  let expected = url.origin;
  // NextURL canonicalizes 127.0.0.1 to localhost. For local HTTP only, retain the
  // actual loopback Host while requiring the same port; the two cookie hosts
  // must never authorize each other's requests. Hosted comparisons stay exact.
  if (!process.env.VERCEL && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && host) {
    const allowed = ["localhost", "127.0.0.1"].map(name => name + (url.port ? ":" + url.port : ""));
    if (!allowed.includes(host)) throw new DomainError("ORIGIN_DENIED", "Changes require this app’s exact request origin.", 403);
    expected = "http://" + host;
  }
  if (!origin || origin !== expected) throw new DomainError("ORIGIN_DENIED", "Changes require this app’s exact request origin.", 403);
  return expected;
}
export function isProductionActor(actor: Actor) { return !actor.personId && !actor.executionId && !actor.supplierId && !actor.roles.includes("crew") && actor.roles.some(role => ["producer", "stage_manager", "foh"].includes(role)); }
export function consoleData(show: ShowSnapshot, currentActor: Actor): ConsoleData {
  if (!isProductionActor(currentActor)) throw new DomainError("SCOPED_CLIENT_REQUIRED", "Open this capability’s dedicated client.", 403);
  return { show, currentActor, readiness: allReadiness(show), serverAt: new Date().toISOString(), crew: crewProductionOverview(show), controlledQa: controlledPresentation(show), controlledPlanningQa: !process.env.VERCEL && process.env.OPENING_NIGHT_AI_QA === "1", ...(isDemonstration(show) ? { demonstration: true, paymentNotice: JUDGE_PAYMENT_NOTICE } : {}) };
}
export function errorResponse(error: unknown) {
  if (error instanceof SessionCreationLimitError) return Response.json({ error: error.message, code: error.code }, { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds), "Cache-Control": "no-store" } });
  if (error instanceof PaymentError) return Response.json({ error: error.message, code: error.code }, { status: error.httpStatus });
  if (error instanceof ProviderError) return Response.json({ error: error.message, code: "PROVIDER_" + error.kind.toUpperCase() }, { status: error.outcome === "unknown" ? 202 : error.httpStatus });
  if (error instanceof DomainError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof SyntaxError) return Response.json({ error: "The request must be valid JSON.", code: "INVALID_JSON" }, { status: 400 });
  console.error("Opening Night request failed", error instanceof Error ? error.name : "Unknown error");
  return Response.json({ error: "The production service could not complete this request. Your confirmed state is preserved.", code: "SERVICE_UNAVAILABLE" }, { status: 503 });
}
