import { DomainError } from "@/domain/contracts";
import type { AdminAuthority } from "@/domain/supplier-admin/contracts";
import { getActor } from "../store";
import { sessionTokenHash } from "../session-records";
import { assertProductionScope, errorResponse, SESSION_COOKIE } from "../http";
export const SUPPLIER_ADMIN_COOKIE = "opening-night-supplier-admin-owner";
function originalCookie(request: Request, name: string) {
  const header = request.headers.get("cookie") ?? "";
  if (header.length > 8000) throw new DomainError("SESSION_REQUIRED", "Use the original bounded access cookie.", 401);
  const matches = header.split(";").map(value => value.trim()).filter(value => value.startsWith(name + "="));
  if (matches.length > 1) throw new DomainError("SESSION_REQUIRED", "Choose one original access cookie.", 401);
  return matches[0]?.slice(name.length + 1);
}
export async function adminAuthority(request: Request): Promise<AdminAuthority> {
  const authorization = request.headers.get("authorization"), supplier = request.headers.get("x-opening-supplier-admin-role") === "supplier";
  if (authorization !== null && !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw new DomainError("SESSION_REQUIRED", "Open the exact original production or supplier access.", 401);
  const token = authorization?.slice(7) ?? originalCookie(request, supplier ? SUPPLIER_ADMIN_COOKIE : SESSION_COOKIE);
  const actor = await getActor(token);
  if (!actor || !token) throw new DomainError("SESSION_REQUIRED", supplier ? "Open the supplier's original private invitation." : "Open your current production session.", 401);
  assertProductionScope(actor, request); return { actor, sessionHash: sessionTokenHash(token) };
}
export function adminJson(value: unknown, status = 200) { return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } }); }
export function adminError(error: unknown) { const response = errorResponse(error); response.headers.set("Cache-Control", "private, no-store"); response.headers.set("Referrer-Policy", "no-referrer"); return response; }
