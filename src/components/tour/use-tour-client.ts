"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PersonalTour, TourCommand, TourReceipt, TourWorkspace } from "@/domain/tour/contracts";
import { ACTIVE_REHEARSAL_STORAGE, PRODUCTION_CHANGED_EVENT } from "../production-fetch";
import { useFocusReturn, type FocusOrigin } from "../wrap/use-focus-return";
import { preparePending, readPending, recoveryKey, type PendingTour, type TourIdentity } from "./recovery";
export type TourData = TourWorkspace | PersonalTour;
export function useTourClient<T extends TourData>(personal: boolean, view: string, fallback: () => HTMLElement | null) {
  const [data, setData] = useState<T | null>(null), [busy, setBusy] = useState<string | null>("loading"), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [ended, setEnded] = useState(false), [pending, setPending] = useState<PendingTour | null>(null), [storageError, setStorageError] = useState<string | null>(null), [notRecorded, setNotRecorded] = useState(false), [fresh, setFresh] = useState(false);
  const current = useRef<T | null>(null), token = useRef<string | null>(null), generation = useRef(0), mounted = useRef(false), lock = useRef(false), pendingRef = useRef<PendingTour | null>(null), endedRef = useRef(false), freshRef = useRef(false), actionOrigin = useRef<{ target: HTMLElement; at: number } | null>(null), rawPending = useRef<string | null>(null), loadedKey = useRef<string | null>(null);
  const focus = useFocusReturn(`${personal}:${view}:${data?.sessionFingerprint ?? "loading"}`, fallback);
  const stop = useCallback(() => { endedRef.current = true; setEnded(true); setBusy(null); generation.current++; }, []);
  const request = useCallback(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); if (current.current) headers.set("X-Opening-Night-Production", current.current.tenantId);
    if (personal) { if (!token.current) throw new Error("Open your personal tour link to continue."); headers.set("Authorization", `Bearer ${token.current}`); }
    const response = await fetch(url, { ...init, headers, credentials: personal ? "omit" : "same-origin", cache: "no-store", referrerPolicy: "same-origin" });
    const value = await response.json().catch(() => ({ error: "The server response was interrupted. Check the original instruction before retrying." }));
    if (response.status === 401 || ["PRODUCTION_CHANGED", "PRODUCTION_SCOPE_REQUIRED", "TOUR_SESSION_ENDED"].includes(value.code)) stop();
    return { response, value };
  }, [personal, stop]);
  const read = useCallback(async () => {
    const epoch = generation.current;
    const { response, value } = await request(personal ? "/api/tour/personal" : "/api/tour");
    if (!response.ok) throw new Error(value.error ?? "The planning desk could not load.");
    if (!mounted.current || epoch !== generation.current) return null;
    if (!value.tenantId || !value.actorId || !/^[a-f0-9]{64}$/.test(value.sessionFingerprint) || (personal ? !Array.isArray(value.calls) : !Array.isArray(value.tours))) throw new Error("The planning response could not be verified.");
    if (current.current && (current.current.tenantId !== value.tenantId || current.current.actorId !== value.actorId || current.current.sessionFingerprint !== value.sessionFingerprint)) { stop(); return null; }
    current.current = value as T; freshRef.current = true; setFresh(true); setData(value as T);
    const key = recoveryKey(value as TourIdentity);
    if (loadedKey.current !== key) {
      loadedKey.current = key;
      try { const raw = sessionStorage.getItem(key); rawPending.current = raw; if (raw) { const saved = await readPending(raw, value); if (mounted.current && epoch === generation.current) { pendingRef.current = saved; setPending(saved); setNotice("A reviewed instruction has no confirmed receipt on this device. Check its original result."); } } }
      catch (reason) { if (mounted.current && epoch === generation.current) setStorageError(reason instanceof Error ? reason.message : "Device recovery storage is unavailable. Mutations are paused."); }
    }
    return value as T;
  }, [personal, request, stop]);
  useEffect(() => {
    mounted.current = true; generation.current++; endedRef.current = false; setEnded(false);
    if (personal) { const fragment = new URLSearchParams(location.hash.slice(1)).get("token"); const key = "opening-night:tour:personal-capability"; try { token.current = fragment != null ? (/^[A-Za-z0-9_-]{43}$/.test(fragment) ? fragment : null) : sessionStorage.getItem(key); if (fragment && token.current === fragment) { sessionStorage.setItem(key, fragment); history.replaceState(null, "", location.pathname + location.search); } } catch { token.current = fragment; setStorageError("Private session storage is unavailable. Reading remains available; saved actions are paused."); } }
    void read().catch(reason => { if (mounted.current) setError(reason instanceof Error ? reason.message : "The planning desk is unavailable."); }).finally(() => { if (mounted.current) setBusy(null); });
    const changed = () => stop();
    const clicked = (event: MouseEvent) => { const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button") : null; if (target) actionOrigin.current = { target, at: Date.now() }; };
    document.addEventListener("click", clicked, true);
    const storage = (event: StorageEvent) => { if (!personal && event.key === ACTIVE_REHEARSAL_STORAGE && event.newValue) { try { if (current.current && JSON.parse(event.newValue).tenantId !== current.current.tenantId) stop(); } catch { /* Server scope remains authoritative. */ } } };
    window.addEventListener(PRODUCTION_CHANGED_EVENT, changed); window.addEventListener("storage", storage);
    return () => { mounted.current = false; generation.current++; window.removeEventListener(PRODUCTION_CHANGED_EVENT, changed); window.removeEventListener("storage", storage); document.removeEventListener("click", clicked, true); };
  }, [personal, read, stop]);
  const refresh = useCallback(async (origin: FocusOrigin = false) => { if (lock.current || endedRef.current) return; lock.current = true; setBusy("refresh"); setError(null); const ticket = focus(origin); try { await read(); } catch (reason) { if (mounted.current) { freshRef.current = false; setFresh(false); setError(reason instanceof Error ? reason.message : "Refresh failed. The retained view is unchanged."); } } finally { lock.current = false; if (mounted.current) setBusy(null); ticket.complete(); } }, [focus, read]);
  useEffect(() => { const refreshVisible = () => { if (document.visibilityState === "visible") void refresh(false); }; window.addEventListener("focus", refreshVisible); window.addEventListener("online", refreshVisible); return () => { window.removeEventListener("focus", refreshVisible); window.removeEventListener("online", refreshVisible); }; }, [refresh]);
  const clear = useCallback(() => { if (current.current) sessionStorage.removeItem(recoveryKey(current.current)); pendingRef.current = null; rawPending.current = null; setPending(null); setNotRecorded(false); }, []);
  const send = useCallback(async (saved: PendingTour): Promise<TourReceipt | null> => {
    const epoch = generation.current;
    const { response, value } = await request("/api/tour/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(saved.command) });
    if (!mounted.current || epoch !== generation.current) return null;
    if (!response.ok) {
      if ([400, 403, 409, 413, 422].includes(response.status) && value.code !== "TOUR_COMMAND_CHANGED" && !endedRef.current) { clear(); setNotice("The server rejected this instruction before saving any change. Review current editions before creating another."); }
      throw new Error(value.error ?? "The outcome is unknown. Check the original instruction.");
    }
    if (value.receipt?.commandId !== saved.command.commandId || value.receipt?.actorId !== saved.actorId) throw new Error("No matching command receipt was returned. Check the original instruction.");
    clear(); setNotice(`${value.replayed ? "Original receipt recovered" : "Reviewed instruction saved"}. ${value.receipt.records.length} retained edition${value.receipt.records.length === 1 ? "" : "s"}.`);
    try { await read(); } catch { if (mounted.current && epoch === generation.current) { freshRef.current = false; setFresh(false); setError("The receipt is saved, but the current view could not refresh. Refresh before the next decision."); } }
    return mounted.current && epoch === generation.current && !endedRef.current ? value.receipt as TourReceipt : null;
  }, [clear, read, request]);
  const act = useCallback(async (action: TourCommand["action"], origin?: FocusOrigin) => {
    if (lock.current || endedRef.current || pendingRef.current || storageError || !current.current || !freshRef.current) return null;
    const epoch = generation.current; lock.current = true; setBusy(action.type); setError(null); const click = actionOrigin.current; actionOrigin.current = null; const ticket = focus(origin ?? (click && Date.now() - click.at < 500 ? click.target : undefined));
    try { const saved = await preparePending(current.current, { commandId: crypto.randomUUID(), action }); if (!mounted.current || epoch !== generation.current || endedRef.current) return null; const raw = JSON.stringify(saved); sessionStorage.setItem(recoveryKey(current.current), raw); if (sessionStorage.getItem(recoveryKey(current.current)) !== raw) throw new Error("The reviewed instruction could not be retained on this device. It was not sent."); rawPending.current = raw; pendingRef.current = saved; setPending(saved); setNotRecorded(false); return await send(saved); }
    catch (reason) { if (mounted.current && epoch === generation.current) setError(reason instanceof Error ? reason.message : "The outcome is unknown. Check the original instruction."); return null; }
    finally { lock.current = false; if (mounted.current) setBusy(null); ticket.complete(); }
  }, [focus, send, storageError]);
  const recover = useCallback(async (retry: boolean, origin?: FocusOrigin) => {
    if (lock.current || endedRef.current || !pendingRef.current || !current.current) return;
    const epoch = generation.current; lock.current = true; setBusy("recover"); setError(null); const ticket = focus(origin);
    try { const saved = await readPending(sessionStorage.getItem(recoveryKey(current.current)) ?? "", current.current); if (!mounted.current || epoch !== generation.current || endedRef.current) return; if (retry) { if (!notRecorded) throw new Error("Check the original receipt before explicitly retrying this same instruction."); await send(saved); } else { const { response, value } = await request(`/api/tour/commands/${saved.command.commandId}`); if (!mounted.current || epoch !== generation.current || endedRef.current) return; if (response.status === 404 && value.code === "TOUR_COMMAND_NOT_FOUND") { setNotRecorded(true); setNotice("No committed receipt is recorded for this exact session. You may retry the same reviewed instruction; its identity and content remain unchanged."); } else if (!response.ok) throw new Error(value.error ?? "The original outcome could not be checked."); else if (value.receipt?.commandId === saved.command.commandId && value.receipt?.actorId === saved.actorId) { clear(); setNotice("The original committed receipt was recovered."); await read(); } else throw new Error("The returned receipt does not match the reviewed instruction."); } }
    catch (reason) { if (mounted.current && epoch === generation.current) setError(reason instanceof Error ? reason.message : "Recovery could not finish."); }
    finally { lock.current = false; if (mounted.current) setBusy(null); ticket.complete(); }
  }, [clear, focus, notRecorded, read, request, send]);
  const downloadRecovery = useCallback(() => { const url = URL.createObjectURL(new Blob([rawPending.current ?? JSON.stringify(pendingRef.current)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "opening-night-tour-recovery.json"; link.click(); URL.revokeObjectURL(url); }, []);
  // A concluded refusal belongs to the review that sent it. Recovery, expired
  // identity and stale-view errors remain authoritative across dialog changes.
  const clearReviewError = useCallback(() => { if (!pendingRef.current && !endedRef.current && freshRef.current) setError(null); }, []);
  return { data, busy, error, notice, ended, pending, notRecorded, storageError, blocked: Boolean(busy || ended || pending || storageError || !fresh), refresh, act, recover, downloadRecovery, request, setError, setNotice, clearReviewError };
}
export type TourClient = ReturnType<typeof useTourClient<TourWorkspace>>;
