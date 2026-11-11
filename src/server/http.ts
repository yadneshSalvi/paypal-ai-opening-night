import { cookies } from "next/headers";
import { DomainError, type ConsoleData, type ShowSnapshot, type Actor } from "@/domain/contracts";
import { allReadiness } from "@/domain/readiness";
import { getActor } from "./store";
import { PaymentError, ProviderError } from "@fracture/paypal-core";
import { SessionCreationLimitError } from "./session-admission";
export const SESSION_COOKIE = "opening-night-session";
export async function currentActor(request?: Request): Promise<Actor | null> {
  const authorization = request?.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  return getActor(bearer ?? (await cookies()).get(SESSION_COOKIE)?.value);
}
export async function requireActor(request?: Request) { const actor = await currentActor(request); if (!actor) throw new DomainError("SESSION_REQUIRED", "Open a rehearsal session to continue.", 401); return actor; }
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
}
export function consoleData(show: ShowSnapshot, currentActor: Actor): ConsoleData { return { show, currentActor, readiness: allReadiness(show), serverAt: new Date().toISOString() }; }
export function errorResponse(error: unknown) {
  if (error instanceof SessionCreationLimitError) return Response.json({ error: error.message, code: error.code }, { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds), "Cache-Control": "no-store" } });
  if (error instanceof PaymentError) return Response.json({ error: error.message, code: error.code }, { status: error.httpStatus });
  if (error instanceof ProviderError) return Response.json({ error: error.message, code: "PROVIDER_" + error.kind.toUpperCase() }, { status: error.outcome === "unknown" ? 202 : error.httpStatus });
  if (error instanceof DomainError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof SyntaxError) return Response.json({ error: "The request must be valid JSON.", code: "INVALID_JSON" }, { status: 400 });
  console.error("Opening Night request failed", error instanceof Error ? error.name : "Unknown error");
  return Response.json({ error: "The production service could not complete this request. Your confirmed state is preserved.", code: "SERVICE_UNAVAILABLE" }, { status: 503 });
}
