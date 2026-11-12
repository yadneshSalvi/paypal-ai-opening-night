"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsentCommandResult, ConsentEnvelope, ProducerConsentWorkspace, ReviewerConsentView } from "@/domain/plan-consents";
import { ACTIVE_REHEARSAL_STORAGE, PRODUCTION_CHANGED_EVENT, productionFetch } from "../production-fetch";
import { clearConsent, consentRecoveryKey, isProducerConsentWorkspace, isReviewerConsentView, matchesConsentReceipt, parsePendingConsent, prepareConsent, producerClientScope, retainConsent, reviewerClientScope, sameConsentScope, type ConsentClientScope, type PendingConsent } from "./recovery";

type ConsentView = ProducerConsentWorkspace | ReviewerConsentView;
class ConsentReadError extends Error { constructor(message: string, readonly status: number, readonly code: string) { super(message); } }
const message = (error: unknown) => error instanceof Error ? error.message : "The original result could not be read. Keep this instruction and check again.";
const definiteRejection = (error: ConsentReadError) => [400, 403, 409, 413, 422].includes(error.status) && !/IDEMPOTENCY|INTEGRITY|COMMAND_OWNER|ACCESS_CHANGED/.test(error.code);

/** One journal per original access. Recovery reads never create a replacement instruction. */
export function usePlanConsents(mode: "producer" | "reviewer", token: string | null = null) {
  const [view, setView] = useState<ConsentView | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [ended, setEnded] = useState(false);
  const [pending, setPending] = useState<PendingConsent | null>(null), [missing, setMissing] = useState(false), [receipt, setReceipt] = useState<ConsentCommandResult | null>(null);
  const [journalBlocked, setJournalBlocked] = useState(false);
  const scope = useRef<ConsentClientScope | null>(null), pendingRef = useRef<PendingConsent | null>(null), busyRef = useRef(false), endedRef = useRef(false), journalBlockedRef = useRef(false), epoch = useRef(0);
  const endpoint = mode === "producer" ? "/api/plan-approvals" : "/api/plan-approvals/review";
  const active = useCallback((generation: number) => generation === epoch.current && !endedRef.current, []);
  const stop = useCallback((reason: string) => { endedRef.current = true; setEnded(true); setView(null); setPending(null); setReceipt(null); setMissing(false); setError(reason); }, []);
  const request = useCallback(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); headers.set("Accept", "application/json");
    if (mode === "reviewer") { if (!token) throw new ConsentReadError("Open the original dedicated review link.", 401, "PLAN_CONSENT_REVIEW_REQUIRED"); headers.set("Authorization", `Bearer ${token}`); }
    const options = { ...init, headers, cache: "no-store" as const, credentials: mode === "reviewer" ? "omit" as const : "same-origin" as const, referrerPolicy: "no-referrer" as const };
    const response = mode === "producer" && scope.current?.tenantId ? await productionFetch(scope.current.tenantId, url, options) : await fetch(url, options);
    let body: unknown; try { body = await response.json(); } catch { throw new ConsentReadError("The service returned an unreadable result. Keep the original instruction.", response.status, "UNREADABLE_RESULT"); }
    if (!response.ok) { const value = body as { error?: string; code?: string }; throw new ConsentReadError(typeof value.error === "string" ? value.error : "The original review could not continue.", response.status, typeof value.code === "string" ? value.code : "UNKNOWN_RESULT"); }
    return body;
  }, [mode, token]);
  const readView = useCallback(async (generation: number): Promise<ConsentView | null> => {
    let data: unknown;
    try { data = await request(endpoint); }
    catch (cause) { if (active(generation) && cause instanceof ConsentReadError && [401, 410].includes(cause.status)) stop(message(cause)); throw cause; }
    if (!(mode === "producer" ? isProducerConsentWorkspace(data) : isReviewerConsentView(data))) throw new Error("The current review response is incomplete. Nothing new was sent.");
    if (!active(generation)) return null;
    const current = mode === "producer" ? producerClientScope(data as ProducerConsentWorkspace) : reviewerClientScope(data as ReviewerConsentView);
    if (scope.current && !sameConsentScope(scope.current, current)) { stop("Different production access is now selected. The original instruction remains retained. Reload to open the selected access."); return null; }
    scope.current = current; setView(data as ConsentView); return data as ConsentView;
  }, [request, endpoint, mode, active, stop]);
  const accept = useCallback(async (saved: PendingConsent, value: unknown, generation: number) => {
    if (!await matchesConsentReceipt(value, saved)) throw new Error("The returned receipt does not match the original reviewed instruction. It remains held for inspection.");
    if (!active(generation)) return false;
    clearConsent(sessionStorage, saved); pendingRef.current = null; setPending(null); setMissing(false); setReceipt(value as ConsentCommandResult); setError(null); return true;
  }, [active]);
  const lookup = useCallback(async (saved: PendingConsent, generation: number): Promise<"saved" | "missing" | "held"> => {
    try {
      const result = await request(`${endpoint}?commandId=${encodeURIComponent(saved.envelope.commandId)}`);
      return await accept(saved, result, generation) ? "saved" : "held";
    } catch (cause) {
      if (!active(generation)) return "held";
      if (cause instanceof ConsentReadError && cause.status === 404 && cause.code === "PLAN_CONSENT_COMMAND_NOT_FOUND") { setMissing(true); setError("No original receipt was found. Keep these exact instructions; an explicit retry uses the same identity and content."); return "missing"; }
      if (cause instanceof ConsentReadError && [401, 410].includes(cause.status)) stop(message(cause)); else setError(message(cause));
      setMissing(false); return "held";
    }
  }, [request, endpoint, accept, active, stop]);
  useEffect(() => {
    const generation = ++epoch.current; scope.current = null; pendingRef.current = null; endedRef.current = false; busyRef.current = true; journalBlockedRef.current = false;
    setView(null); setPending(null); setReceipt(null); setMissing(false); setEnded(false); setBusy(true); setError(null); setJournalBlocked(false);
    const changed = () => { if (mode === "producer") stop("Another production is selected. Your original instructions stay retained with their original access."); };
    const storage = (event: StorageEvent) => { if (mode === "producer" && event.key === ACTIVE_REHEARSAL_STORAGE) changed(); };
    window.addEventListener(PRODUCTION_CHANGED_EVENT, changed); window.addEventListener("storage", storage);
    void (async () => {
      try {
        if (mode === "reviewer" && !token) throw new ConsentReadError("Open the original link shared with the invited representative.", 401, "PLAN_CONSENT_REVIEW_REQUIRED");
        const current = await readView(generation); if (!current || !active(generation) || !scope.current) return;
        try {
          const raw = sessionStorage.getItem(consentRecoveryKey(scope.current));
          if (raw !== null) {
            const saved = await parsePendingConsent(raw, scope.current); if (!active(generation)) return;
            pendingRef.current = saved; setPending(saved); await lookup(saved, generation);
          }
        } catch (cause) { if (active(generation)) { journalBlockedRef.current = true; setJournalBlocked(true); } throw cause; }
      } catch (cause) { if (active(generation)) { if (cause instanceof ConsentReadError && [401, 410].includes(cause.status)) stop(message(cause)); else setError(message(cause)); } }
      finally { if (generation === epoch.current) { busyRef.current = false; setBusy(false); } }
    })();
    return () => { epoch.current++; window.removeEventListener(PRODUCTION_CHANGED_EVENT, changed); window.removeEventListener("storage", storage); };
  }, [mode, token, active, lookup, readView, stop]);
  useEffect(() => {
    if (!view || !scope.current || ended) return;
    const remaining = Date.parse(scope.current.expiresAt) - Date.parse(view.serverAt);
    const timer = window.setTimeout(() => stop("This original review access has ended. Its saved decisions and pending instruction remain retained; no expiry was extended."), Math.max(0, Math.min(remaining, 2147483647)));
    return () => window.clearTimeout(timer);
  }, [view, ended, stop]);
  const refresh = useCallback(async () => {
    if (busyRef.current || endedRef.current) return;
    const generation = epoch.current; busyRef.current = true; setBusy(true);
    try { await readView(generation); if (active(generation) && !pendingRef.current) setError(null); }
    catch (cause) { if (active(generation)) { if (cause instanceof ConsentReadError && [401, 410].includes(cause.status)) stop(message(cause)); else setError(message(cause)); } }
    finally { if (generation === epoch.current) { busyRef.current = false; setBusy(false); } }
  }, [readView, active, stop]);
  const check = useCallback(async () => {
    const saved = pendingRef.current; if (!saved || busyRef.current || endedRef.current) return;
    const generation = epoch.current; busyRef.current = true; setBusy(true);
    try { const current = await readView(generation); if (current && active(generation)) { await lookup(saved, generation); await readView(generation); } }
    catch (cause) { if (active(generation)) setError(message(cause)); }
    finally { if (generation === epoch.current) { busyRef.current = false; setBusy(false); } }
  }, [readView, lookup, active]);
  const post = useCallback(async (saved: PendingConsent, generation: number) => {
    if (!active(generation)) return;
    retainConsent(sessionStorage, saved); setMissing(false);
    try {
      const value = await request(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(saved.envelope) });
      await accept(saved, value, generation);
    } catch (cause) {
      if (!active(generation)) return;
      const outcome = await lookup(saved, generation);
      if (outcome === "missing" && cause instanceof ConsentReadError && definiteRejection(cause) && active(generation)) {
        clearConsent(sessionStorage, saved); pendingRef.current = null; setPending(null); setMissing(false); setError(`This instruction was refused: ${message(cause)} Review the current facts before a new instruction.`);
      }
    }
    if (active(generation)) await readView(generation);
  }, [active, request, endpoint, accept, lookup, readView]);
  const send = useCallback(async (envelope: ConsentEnvelope) => {
    if (busyRef.current || pendingRef.current || endedRef.current || journalBlockedRef.current || !scope.current) return;
    const generation = epoch.current; busyRef.current = true; setBusy(true); setError(null); setReceipt(null);
    try {
      const saved = await prepareConsent(scope.current, envelope), current = await readView(generation);
      if (!current || !active(generation)) return;
      retainConsent(sessionStorage, saved); pendingRef.current = saved; setPending(saved); await post(saved, generation);
    } catch (cause) { if (active(generation)) setError(message(cause)); }
    finally { if (generation === epoch.current) { busyRef.current = false; setBusy(false); } }
  }, [readView, post, active]);
  const retry = useCallback(async () => {
    const saved = pendingRef.current; if (!saved || !missing || busyRef.current || endedRef.current) return;
    const generation = epoch.current; busyRef.current = true; setBusy(true);
    try { const current = await readView(generation); if (current && active(generation) && await lookup(saved, generation) === "missing") await post(saved, generation); }
    catch (cause) { if (active(generation)) setError(message(cause)); }
    finally { if (generation === epoch.current) { busyRef.current = false; setBusy(false); } }
  }, [missing, readView, active, lookup, post]);
  return { view, busy, error, ended, pending, missing, receipt, refresh, check, send, retry, locked: busy || Boolean(pending) || ended || journalBlocked };
}
