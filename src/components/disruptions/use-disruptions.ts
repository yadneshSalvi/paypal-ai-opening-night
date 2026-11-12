"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CancellationPreview, DisruptionCommand, DisruptionMode, DisruptionResult, DisruptionWorkspace } from "@/server/disruptions/contracts";
import { ACTIVE_REHEARSAL_STORAGE, PRODUCTION_CHANGED_EVENT, productionFetch } from "../production-fetch";
import { useFocusReturn, type FocusOrigin } from "../wrap/use-focus-return";
import { clearDisruption, definiteDisruptionRejection, disruptionRecoveryKey, isDisruptionWorkspace, matchesDisruptionReceipt, parseDisruption, prepareDisruption, retainDisruption, sameDisruptionIdentity, type PendingDisruption } from "./recovery";

class DisruptionRequestError extends Error { constructor(message: string, readonly status: number, readonly code: string) { super(message); } }
const problem = (cause: unknown) => cause instanceof Error ? cause.message : "This result could not be verified. Check the original instruction before another action.";
type Options = { tenantId?: string; bearer?: string; onSaved?: (workspace: DisruptionWorkspace) => void | Promise<void>; fallback?: () => HTMLElement | null };
export function useDisruptions({ tenantId, bearer, onSaved, fallback }: Options) {
  const [data, setData] = useState<DisruptionWorkspace | null>(null), [busy, setBusy] = useState<string | null>("loading"), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingDisruption | null>(null), [storageError, setStorageError] = useState<string | null>(null), [notRecorded, setNotRecorded] = useState(false), [ended, setEnded] = useState(false), [fresh, setFresh] = useState(false), [reviewEpoch, setReviewEpoch] = useState(0);
  const current = useRef<DisruptionWorkspace | null>(null), retained = useRef<PendingDisruption | null>(null), rawPending = useRef<string | null>(null), loadedKey = useRef<string | null>(null), lock = useRef(false), active = useRef(false), generation = useRef(0), stopped = useRef(false), freshRef = useRef(false), storageBlocked = useRef(false), savedCallback = useRef(onSaved), fallbackRef = useRef(fallback);
  savedCallback.current = onSaved; fallbackRef.current = fallback;
  const focus = useFocusReturn(`disruptions:${tenantId ?? "supplier"}:${bearer ?? "production"}`, () => fallbackRef.current?.() ?? null);
  const end = useCallback(() => { stopped.current = true; freshRef.current = false; generation.current++; setEnded(true); setFresh(false); setBusy(null); setReviewEpoch(value => value + 1); }, []);
  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
    const scope = current.current?.tenantId ?? tenantId;
    const options: RequestInit = { ...init, headers, credentials: bearer ? "omit" : "same-origin", cache: "no-store", referrerPolicy: "same-origin" };
    const response = await (scope ? productionFetch(scope, path, options) : fetch(path, options));
    let value: any;
    try { value = await response.json(); }
    catch { throw new DisruptionRequestError("The response was interrupted or unreadable. Keep the retained instruction and check its original status.", response.status, "UNREADABLE_RESPONSE"); }
    if (response.status === 401 || ["PRODUCTION_CHANGED", "PRODUCTION_SCOPE_REQUIRED", "DISRUPTION_SESSION_ENDED"].includes(value?.code)) end();
    if (!response.ok) throw new DisruptionRequestError(typeof value?.error === "string" ? value.error : "The disruption desk could not verify this request.", response.status, value?.code ?? "UNKNOWN");
    return value as unknown;
  }, [bearer, tenantId, end]);
  const adopt = useCallback((next: unknown) => {
    if (!isDisruptionWorkspace(next) || tenantId && next.tenantId !== tenantId) throw new Error("The disruption workspace could not be verified for this production.");
    if (current.current && !sameDisruptionIdentity(current.current, next)) { end(); throw new Error("This response belongs to different access. The original session and its retained instruction remain separate."); }
    if (Date.parse(next.expiresAt) <= Date.now()) { end(); throw new Error("This exact production access has expired. Its retained instructions were preserved."); }
    if (current.current && next.revision < current.current.revision) return current.current;
    current.current = next; setData(next); freshRef.current = true; setFresh(true); return next;
  }, [tenantId, end]);
  const read = useCallback(async () => {
    const epoch = generation.current, value = await request("/api/disruptions");
    if (!active.current || epoch !== generation.current || stopped.current) return null;
    const next = adopt(value), key = disruptionRecoveryKey(next);
    if (loadedKey.current !== key) {
      loadedKey.current = key;
      try {
        const raw = localStorage.getItem(key); rawPending.current = raw;
        if (raw) {
          const original = await parseDisruption(raw, next);
          if (!active.current || epoch !== generation.current || stopped.current) return null;
          retained.current = original; setPending(original); setNotice("A reviewed instruction is retained on this device without a confirmed receipt. Check its original status.");
        }
      } catch (cause) { storageBlocked.current = true; setStorageError(problem(cause)); }
    }
    return next;
  }, [adopt, request]);
  const refresh = useCallback(async (origin: FocusOrigin = false) => {
    if (lock.current || stopped.current) return null;
    lock.current = true; setBusy("refresh"); setError(null); setReviewEpoch(value => value + 1); const ticket = focus(origin), epoch = generation.current;
    try { return await read(); }
    catch (cause) { if (active.current && epoch === generation.current) { freshRef.current = false; setFresh(false); setError(problem(cause)); } return null; }
    finally { lock.current = false; if (active.current) setBusy(null); ticket.complete(); }
  }, [focus, read]);
  useEffect(() => {
    active.current = true; stopped.current = false; generation.current++; current.current = null; retained.current = null; rawPending.current = null; loadedKey.current = null; storageBlocked.current = false; freshRef.current = false;
    setData(null); setPending(null); setEnded(false); setFresh(false); setError(null); setNotice(null); setStorageError(null); setNotRecorded(false); setBusy("loading");
    const epoch = generation.current; lock.current = true;
    void read().catch(cause => { if (active.current && epoch === generation.current) setError(problem(cause)); }).finally(() => { if (active.current) { lock.current = false; setBusy(null); } });
    const changed = () => { if (!bearer) end(); };
    const storage = (event: StorageEvent) => {
      if (!bearer && event.key === ACTIVE_REHEARSAL_STORAGE && event.newValue) { try { if (current.current && JSON.parse(event.newValue).tenantId !== current.current.tenantId) end(); } catch { /* Server production scope remains authoritative. */ } }
      if (current.current && event.key === disruptionRecoveryKey(current.current) && event.newValue !== rawPending.current) {
        storageBlocked.current = true; setStorageError("Recovery storage changed in another tab. Refresh this page to open its retained original instruction before changing the production."); setReviewEpoch(value => value + 1);
      }
    };
    const expiry = setInterval(() => { if (current.current && Date.parse(current.current.expiresAt) <= Date.now() && !stopped.current) end(); }, 15000);
    window.addEventListener(PRODUCTION_CHANGED_EVENT, changed); window.addEventListener("storage", storage);
    return () => { active.current = false; generation.current++; clearInterval(expiry); window.removeEventListener(PRODUCTION_CHANGED_EVENT, changed); window.removeEventListener("storage", storage); };
  }, [bearer, read, end]);
  useEffect(() => { const visible = () => { if (document.visibilityState === "visible") void refresh(false); }; window.addEventListener("focus", visible); window.addEventListener("online", visible); return () => { window.removeEventListener("focus", visible); window.removeEventListener("online", visible); }; }, [refresh]);

  const retire = useCallback((original: PendingDisruption) => {
    try { clearDisruption(localStorage, original); retained.current = null; rawPending.current = null; setPending(null); setNotRecorded(false); setStorageError(null); storageBlocked.current = false; }
    catch (cause) { storageBlocked.current = true; setStorageError(problem(cause)); }
  }, []);
  const acceptResult = useCallback((value: unknown, original: PendingDisruption): DisruptionResult => {
    if (!matchesDisruptionReceipt(value, original)) throw new Error("The returned receipt does not match this exact instruction, action and reviewed content. Check its original status; nothing will be resent automatically.");
    adopt(value.workspace); setNotRecorded(false); retire(original); setNotice(`${value.replayed ? "Original receipt recovered." : "Reviewed instruction recorded."} ${value.receipt.message}`);
    setReviewEpoch(epoch => epoch + 1);
    try { void Promise.resolve(savedCallback.current?.(value.workspace)).catch(() => undefined); } catch { /* A secondary header refresh never changes a verified command result. */ }
    return value;
  }, [adopt, retire]);
  const transmit = useCallback(async (original: PendingDisruption) => {
    const epoch = generation.current;
    // Reverify the local bytes before every POST. An uncertain response leaves them intact.
    rawPending.current = retainDisruption(localStorage, original);
    const verified = await parseDisruption(rawPending.current, original);
    if (!active.current || epoch !== generation.current || stopped.current) return null;
    retained.current = verified; setPending(verified); setNotRecorded(false);
    const value = await request("/api/disruptions/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(verified.envelope) });
    if (!active.current || epoch !== generation.current || stopped.current) return null;
    return acceptResult(value, original);
  }, [acceptResult, request]);
  const submit = useCallback(async (command: DisruptionCommand, reviewedRevision?: number, origin?: FocusOrigin) => {
    if (lock.current || stopped.current || retained.current || storageBlocked.current || !current.current || !freshRef.current) return null;
    if (reviewedRevision !== undefined && reviewedRevision !== current.current.revision) { setError("This review is out of date. Refresh and review the current facts before approving it."); return null; }
    lock.current = true; setBusy(command.type); setError(null); setNotice(null); const epoch = generation.current, ticket = focus(origin);
    let original: PendingDisruption | null = null;
    try {
      original = await prepareDisruption(current.current, { idempotencyKey: crypto.randomUUID(), expectedRevision: reviewedRevision ?? current.current.revision, command });
      if (!active.current || epoch !== generation.current || stopped.current) return null;
      rawPending.current = JSON.stringify(original);
      try { rawPending.current = retainDisruption(localStorage, original); retained.current = original; setPending(original); }
      catch (cause) { storageBlocked.current = true; setStorageError(problem(cause)); return null; }
      return await transmit(original);
    } catch (cause) {
      if (active.current && epoch === generation.current && !stopped.current) {
        if (original && cause instanceof DisruptionRequestError && definiteDisruptionRejection(cause.status, cause.code)) { retire(original); freshRef.current = false; setFresh(false); setReviewEpoch(value => value + 1); }
        setError(problem(cause));
      }
      return null;
    } finally { lock.current = false; if (active.current) setBusy(null); ticket.complete(); }
  }, [focus, retire, transmit]);
  const recover = useCallback(async (retry = false, origin?: FocusOrigin) => {
    if (lock.current || stopped.current || !retained.current || !current.current) return null;
    lock.current = true; setBusy(retry ? "retry_original" : "recover"); setError(null); setNotice(null); setNotRecorded(false); const ticket = focus(origin), epoch = generation.current;
    let original: PendingDisruption | null = null;
    try {
      const raw = localStorage.getItem(disruptionRecoveryKey(current.current)) ?? rawPending.current;
      if (!raw) throw new Error("The retained instruction is unavailable. Keep its recovery file and check the original server history.");
      original = await parseDisruption(raw, current.current);
      if (!active.current || epoch !== generation.current || stopped.current) return null;
      if (original.envelope.idempotencyKey !== retained.current.envelope.idempotencyKey || original.requestDigest !== retained.current.requestDigest) throw new Error("The retained instruction changed. Refresh before checking a different original result.");
      if (retry) {
        if (!notRecorded) throw new Error("Check the exact original status before explicitly retrying this same instruction.");
        return await transmit(original);
      }
      const value = await request(`/api/disruptions/commands/${original.envelope.idempotencyKey}`);
      if (!active.current || epoch !== generation.current || stopped.current) return null;
      return acceptResult(value, original);
    } catch (cause) {
      if (active.current && epoch === generation.current && !stopped.current) {
        if (!retry && cause instanceof DisruptionRequestError && cause.status === 404 && cause.code === "DISRUPTION_COMMAND_NOT_FOUND") { setNotRecorded(true); setNotice("No receipt is recorded for this exact instruction and session. You may explicitly retry the retained instruction with its original identity and content."); }
        else { if (retry && original && cause instanceof DisruptionRequestError && definiteDisruptionRejection(cause.status, cause.code)) { retire(original); freshRef.current = false; setFresh(false); setReviewEpoch(value => value + 1); } setError(problem(cause)); }
      }
      return null;
    } finally { lock.current = false; if (active.current) setBusy(null); ticket.complete(); }
  }, [acceptResult, focus, notRecorded, request, retire, transmit]);
  const preview = useCallback(async (mode: DisruptionMode, admissionRefundMinor: number) => {
    if (lock.current || stopped.current || retained.current || storageBlocked.current || !current.current || !freshRef.current) return null;
    lock.current = true; setBusy("preview"); setError(null); setNotice(null); const epoch = generation.current, revision = current.current.revision;
    try {
      const value = await request("/api/disruptions/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, admissionRefundMinor }) }) as CancellationPreview;
      if (!active.current || epoch !== generation.current || stopped.current) return null;
      if (value?.revision !== revision || current.current.revision !== revision || value?.mode !== mode || value.admissionRefundMinor !== admissionRefundMinor || !/^[a-f0-9]{64}$/.test(value.digest) || !Array.isArray(value.lines) || !Array.isArray(value.blockers) || !Array.isArray(value.obligations)) throw new Error("The allocation changed while it was being prepared. Refresh the current facts and review it again.");
      return value;
    } catch (cause) { if (active.current && epoch === generation.current) { setError(problem(cause)); freshRef.current = false; setFresh(false); setReviewEpoch(value => value + 1); } return null; }
    finally { lock.current = false; if (active.current) setBusy(null); }
  }, [request]);
  const beginReview = useCallback(() => { if (!retained.current && !stopped.current && freshRef.current) { setError(null); setNotice(null); } }, []);
  const downloadRecovery = useCallback(() => {
    const raw = rawPending.current ?? (retained.current ? JSON.stringify(retained.current) : null);
    if (!raw) return;
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" })), link = document.createElement("a"); link.href = url; link.download = "opening-night-disruption-instruction.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);
  return { data, busy, error, notice, pending, storageError, notRecorded, ended, fresh, reviewEpoch, hasRecoveryFile: Boolean(rawPending.current), blocked: Boolean(busy || ended || pending || storageError || !fresh), refresh, submit, recover, preview, beginReview, downloadRecovery };
}
export type DisruptionClient = ReturnType<typeof useDisruptions>;
