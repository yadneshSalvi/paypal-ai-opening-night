"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InputCommandResult, InputEnvelope, InputScope, InputWorkspace } from "@/domain/production-inputs/contracts";
import { ACTIVE_REHEARSAL_STORAGE, PRODUCTION_CHANGED_EVENT, productionFetch } from "../production-fetch";
import { clearInput, inputRecoveryKey, isInputWorkspace, matchesInputReceipt, parsePendingInput, prepareInput, retainInput, sameInputScope, type PendingInput } from "./recovery";

class InputReadError extends Error { constructor(message: string, readonly status: number, readonly code: string) { super(message); } }
const message = (error: unknown) => error instanceof Error ? error.message : "The original result is unknown. Keep this instruction and check its original receipt.";
const definite = (error: InputReadError) => [400, 403, 409, 413, 422].includes(error.status) && !/IDEMPOTENCY|INTEGRITY|ACCESS_CHANGED/.test(error.code);
const endpoint = "/api/production-inputs";
export function useInputs() {
  const [view, setView] = useState<InputWorkspace | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState<string | null>(null), [ended, setEnded] = useState(false), [pending, setPending] = useState<PendingInput | null>(null), [missing, setMissing] = useState(false), [receipt, setReceipt] = useState<InputCommandResult | null>(null), [journalBlocked, setJournalBlocked] = useState(false);
  const scope = useRef<InputScope | null>(null), pendingRef = useRef<PendingInput | null>(null), busyRef = useRef(false), endedRef = useRef(false), blockedRef = useRef(false), epoch = useRef(0);
  const active = useCallback((generation: number) => generation === epoch.current && !endedRef.current, []);
  const stop = useCallback((reason: string) => { endedRef.current = true; setEnded(true); setView(null); setReceipt(null); setMissing(false); setError(reason); }, []);
  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); headers.set("Accept", "application/json");
    const options = { ...init, signal: init.signal ?? AbortSignal.timeout(12000), headers, credentials: "same-origin" as const, cache: "no-store" as const, referrerPolicy: "no-referrer" as const };
    const response = scope.current ? await productionFetch(scope.current.tenantId, path, options) : await fetch(path, options);
    let body: unknown; try { body = await response.json(); } catch { throw new InputReadError("The response was unreadable. Keep the original instruction and check its receipt.", response.status, "INPUT_UNREADABLE_RESULT"); }
    if (!response.ok) { const value = body as { code?: string; error?: string }; throw new InputReadError(typeof value.error === "string" ? value.error : "The original input review could not continue.", response.status, typeof value.code === "string" ? value.code : "INPUT_UNKNOWN_RESULT"); }
    return body;
  }, []);
  const readView = useCallback(async (generation: number) => {
    const value = await request(endpoint);
    if (!isInputWorkspace(value)) throw new Error("The source review response is incomplete. Nothing new was sent.");
    if (!active(generation)) return null;
    if (scope.current && !sameInputScope(scope.current, value.scope)) { stop("Different producer access or fixed expiry is now selected. The original instruction stays retained with its original access."); return null; }
    scope.current = value.scope; setView(value); return value;
  }, [request, active, stop]);
  const accept = useCallback(async (saved: PendingInput, value: unknown, generation: number) => {
    if (!await matchesInputReceipt(value, saved)) throw new Error("This receipt does not match the original exact instruction. Its outcome stays held for inspection.");
    if (!active(generation)) return false;
    clearInput(sessionStorage, saved); pendingRef.current = null; setPending(null); setMissing(false); setReceipt(value as InputCommandResult); setError(null); return true;
  }, [active]);
  const lookup = useCallback(async (saved: PendingInput, generation: number): Promise<"saved" | "missing" | "held"> => {
    try { return await accept(saved, await request(`${endpoint}?commandId=${encodeURIComponent(saved.envelope.commandId)}`), generation) ? "saved" : "held"; }
    catch (cause) {
      if (!active(generation)) return "held";
      if (cause instanceof InputReadError && cause.status === 404 && cause.code === "INPUT_COMMAND_NOT_FOUND") { setMissing(true); setError("No original receipt was found. An explicit retry will use these same instructions and identity."); return "missing"; }
      setMissing(false); if (cause instanceof InputReadError && [401, 410].includes(cause.status)) stop(message(cause)); else setError(message(cause)); return "held";
    }
  }, [accept, request, active, stop]);
  const fail = useCallback((cause: unknown, generation: number) => { if (active(generation)) { if (cause instanceof InputReadError && [401, 410].includes(cause.status)) stop(message(cause)); else setError(message(cause)); } }, [active, stop]);
  useEffect(() => {
    const generation = ++epoch.current; endedRef.current = false; busyRef.current = true; blockedRef.current = false; scope.current = null; pendingRef.current = null;
    setBusy(true); setEnded(false); setError(null); setView(null); setPending(null); setReceipt(null); setMissing(false); setJournalBlocked(false);
    const changed = () => stop("Another production is selected. Your original instruction remains retained with its original producer access.");
    const storage = (event: StorageEvent) => { if (event.key === ACTIVE_REHEARSAL_STORAGE) changed(); };
    window.addEventListener(PRODUCTION_CHANGED_EVENT, changed); window.addEventListener("storage", storage);
    void (async () => {
      try {
        const current = await readView(generation); if (!current || !active(generation)) return;
        try { const raw = sessionStorage.getItem(inputRecoveryKey(current.scope)); if (raw !== null) { const saved = await parsePendingInput(raw, current.scope); if (!active(generation)) return; pendingRef.current = saved; setPending(saved); await lookup(saved, generation); } }
        catch (cause) { blockedRef.current = true; setJournalBlocked(true); throw cause; }
      } catch (cause) { fail(cause, generation); }
      finally { if (generation === epoch.current) { busyRef.current = false; setBusy(false); } }
    })();
    return () => { epoch.current++; window.removeEventListener(PRODUCTION_CHANGED_EVENT, changed); window.removeEventListener("storage", storage); };
  }, [readView, lookup, fail, stop, active]);
  useEffect(() => { if (!view || ended) return; const timer = window.setTimeout(() => stop("This original producer access ended. Saved decisions and the pending instruction remain retained; no expiry was renewed."), Math.max(0, Math.min(Date.parse(view.scope.sessionExpiresAt) - Date.parse(view.serverAt), 2147483647))); return () => window.clearTimeout(timer); }, [view, ended, stop]);
  const refresh = useCallback(async () => {
    if (busyRef.current || endedRef.current) return; const generation = epoch.current; busyRef.current = true; setBusy(true);
    try { const current = await readView(generation); if (current && pendingRef.current) await lookup(pendingRef.current, generation); else if (active(generation)) setError(null); }
    catch (cause) { fail(cause, generation); } finally { if (generation === epoch.current) { busyRef.current = false; setBusy(false); } }
  }, [readView, lookup, active, fail]);
  const post = useCallback(async (saved: PendingInput, generation: number) => {
    retainInput(sessionStorage, saved); setMissing(false);
    try { await accept(saved, await request(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(saved.envelope) }), generation); }
    catch (cause) {
      if (!active(generation)) return; const outcome = await lookup(saved, generation);
      if (outcome === "missing" && cause instanceof InputReadError && definite(cause) && active(generation)) { clearInput(sessionStorage, saved); pendingRef.current = null; setPending(null); setMissing(false); setError(`This instruction was refused: ${message(cause)} Read the current source before a new review.`); }
    }
    if (active(generation)) await readView(generation);
  }, [accept, request, active, lookup, readView]);
  const send = useCallback(async (command: InputEnvelope["command"]) => {
    if (busyRef.current || pendingRef.current || endedRef.current || blockedRef.current || !view || !scope.current) return;
    const generation = epoch.current; busyRef.current = true; setBusy(true); setError(null); setReceipt(null);
    try { const saved = await prepareInput(scope.current, { version: 1, commandId: crypto.randomUUID(), scope: scope.current, expectedRevision: view.revision, inputRevision: view.inputRevision, command }); const current = await readView(generation); if (!current || !active(generation)) return; retainInput(sessionStorage, saved); pendingRef.current = saved; setPending(saved); await post(saved, generation); }
    catch (cause) { fail(cause, generation); } finally { if (generation === epoch.current) { busyRef.current = false; setBusy(false); } }
  }, [view, readView, active, post, fail]);
  const retry = useCallback(async () => {
    const saved = pendingRef.current; if (!saved || !missing || busyRef.current || endedRef.current || blockedRef.current) return;
    const generation = epoch.current; busyRef.current = true; setBusy(true);
    try { const current = await readView(generation); if (current && active(generation) && await lookup(saved, generation) === "missing") await post(saved, generation); }
    catch (cause) { fail(cause, generation); } finally { if (generation === epoch.current) { busyRef.current = false; setBusy(false); } }
  }, [missing, readView, active, lookup, post, fail]);
  return { view, busy, error, ended, pending, missing, receipt, journalBlocked, refresh, retry, send, locked: busy || Boolean(pending) || ended || journalBlocked };
}
