import { PRODUCTION_SCOPE_HEADER } from "@/domain/rehearsal-contracts";

export const PRODUCTION_CHANGED_EVENT = "opening-night:production-changed";
export const ACTIVE_REHEARSAL_STORAGE = "opening-night:active-rehearsal";

/** A stale tab cannot silently follow the shared cookie into another production. */
export async function productionFetch(tenantId: string, input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers); headers.set(PRODUCTION_SCOPE_HEADER, tenantId);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 409 && typeof window !== "undefined") {
    const body = await response.clone().json().catch(() => null);
    if (["PRODUCTION_CHANGED", "PRODUCTION_SCOPE_REQUIRED"].includes(body?.code)) window.dispatchEvent(new Event(PRODUCTION_CHANGED_EVENT));
  }
  return response;
}
export function announceRehearsal(tenantId: string) {
  try { localStorage.setItem(ACTIVE_REHEARSAL_STORAGE, JSON.stringify({ tenantId, at: Date.now() })); }
  catch { /* The server still binds every mutation when browser storage is unavailable. */ }
}
