"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AudienceCommand, AudienceInvitation, AudienceMessageView, AudienceResult, AudienceWorkspace } from "@/domain/audience/contracts";
import { ACTIVE_REHEARSAL_STORAGE, PRODUCTION_CHANGED_EVENT, productionFetch } from "../production-fetch";
import { useFocusReturn, type FocusOrigin } from "../wrap/use-focus-return";
import { audienceRecoveryKey, clearAudienceJournal, definiteAudienceRejection, matchAudienceResult, parseAudienceJournal, prepareAudienceCommand, prepareAudienceWork, retainAudienceJournal, sameAudienceIdentity, type AudienceJournal } from "./recovery";
import { parseAudienceInvitation, parseAudienceMessage, parseAudienceResult, parseAudienceWorkspace } from "./validation";

export class AudienceRequestError extends Error { constructor(message: string, readonly status: number, readonly code: string) { super(message); } }
const problem = (error: unknown) => error instanceof Error ? error.message : "This result could not be verified. Check its original retained instruction.";
export function useAudience(tenantId: string | null, fallback: () => HTMLElement | null) {
  const [data, setData] = useState<AudienceWorkspace | null>(null), [message, setMessage] = useState<AudienceMessageView | null>(null), [invitation, setInvitation] = useState<AudienceInvitation | null>(null);
  const [busy, setBusy] = useState<string | null>("loading"), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [ended, setEnded] = useState(false), [fresh, setFresh] = useState(false), [reviewEpoch, setReviewEpoch] = useState(0);
  const [pending, setPending] = useState<AudienceJournal | null>(null), [storageError, setStorageError] = useState<string | null>(null), [notRecorded, setNotRecorded] = useState(false);
  const current = useRef<AudienceWorkspace | null>(null), selected = useRef<AudienceMessageView | null>(null), retained = useRef<AudienceJournal | null>(null), raw = useRef<string | null>(null), loadedKey = useRef<string | null>(null), active = useRef(false), stopped = useRef(false), freshRef = useRef(false), lock = useRef(false), generation = useRef(0), blockedStorage = useRef(false), fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const focus = useFocusReturn(`audience:${tenantId ?? "none"}:${data?.sessionFingerprint ?? "opening"}`, () => fallbackRef.current());
  const end = useCallback(() => { stopped.current = true; generation.current++; freshRef.current = false; current.current = null; selected.current = null; setData(null); setMessage(null); setInvitation(null); setEnded(true); setFresh(false); setBusy(null); setReviewEpoch(value => value + 1); }, []);
  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const options: RequestInit = { ...init, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" }, scope = current.current?.tenantId ?? tenantId;
    const response = await (scope ? productionFetch(scope, path, options) : fetch(path, options));
    if (response.status === 401 || response.status === 403 && (init.method ?? "GET") === "GET") end();
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new AudienceRequestError("The response was interrupted or unreadable. Keep the exact original instruction and check its saved result.", response.status, "UNREADABLE_RESPONSE"); }
    const failure = body && typeof body === "object" ? body as { code?: unknown; error?: unknown } : null;
    const code = typeof failure?.code === "string" ? failure.code : "UNKNOWN";
    if (response.status === 401 || ["AUDIENCE_PRODUCER_REQUIRED", "AUDIENCE_SESSION_ENDED", "AUDIENCE_ORIGINAL_SESSION_REQUIRED", "PRODUCTION_CHANGED", "PRODUCTION_SCOPE_REQUIRED"].includes(code)) end();
    if (!response.ok) throw new AudienceRequestError(typeof failure?.error === "string" ? failure.error : "The private audience service could not verify this request.", response.status, code);
    return body;
  }, [tenantId, end]);
  const adopt = useCallback((rawValue: unknown) => {
    const next = parseAudienceWorkspace(rawValue);
    if (tenantId && next.tenantId !== tenantId || current.current && (!sameAudienceIdentity(current.current, next) || next.expiresAt !== current.current.expiresAt)) { end(); throw new Error("This response belongs to different exact producer access. Its private content was not adopted."); }
    if (Date.parse(next.expiresAt) <= Date.now()) { end(); throw new Error("This exact producer access has expired. Original instructions were preserved."); }
    if (current.current && (next.revision < current.current.revision || next.showRevision < current.current.showRevision)) return current.current;
    current.current = next; freshRef.current = true; setData(next); setFresh(true); return next;
  }, [tenantId, end]);
  const read = useCallback(async () => {
    const epoch = generation.current, value = await request("/api/audience");
    if (!active.current || epoch !== generation.current || stopped.current) return null;
    const next = adopt(value), key = audienceRecoveryKey(next);
    if (loadedKey.current !== key) {
      loadedKey.current = key;
      try {
        raw.current = localStorage.getItem(key);
        if (raw.current) {
          const saved = await parseAudienceJournal(raw.current, next);
          if (!active.current || epoch !== generation.current || stopped.current) return null;
          retained.current = saved; setPending(saved); setNotice("An original audience instruction is retained on this device. Read its exact saved result before another action.");
        }
      } catch (cause) { blockedStorage.current = true; setStorageError(problem(cause)); }
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
    active.current = true; stopped.current = false; generation.current++; current.current = null; selected.current = null; retained.current = null; raw.current = null; loadedKey.current = null; blockedStorage.current = false; freshRef.current = false;
    setData(null); setMessage(null); setInvitation(null); setPending(null); setEnded(false); setFresh(false); setError(null); setNotice(null); setStorageError(null); setNotRecorded(false); setBusy("loading");
    const epoch = generation.current; lock.current = true;
    void read().catch(cause => { if (active.current && epoch === generation.current) setError(problem(cause)); }).finally(() => { if (active.current && epoch === generation.current) { lock.current = false; setBusy(null); } });
    const changed = () => end();
    const storage = (event: StorageEvent) => {
      if (event.key === ACTIVE_REHEARSAL_STORAGE && event.newValue) { try { if (current.current && JSON.parse(event.newValue).tenantId !== current.current.tenantId) end(); } catch { end(); } }
      if (current.current && event.key === audienceRecoveryKey(current.current) && event.newValue !== raw.current) { blockedStorage.current = true; setStorageError("Recovery storage changed in another view. Refresh this page to open its original retained instruction."); setReviewEpoch(value => value + 1); }
    };
    window.addEventListener(PRODUCTION_CHANGED_EVENT, changed); window.addEventListener("storage", storage);
    return () => { active.current = false; generation.current++; window.removeEventListener(PRODUCTION_CHANGED_EVENT, changed); window.removeEventListener("storage", storage); };
  }, [read, end]);
  useEffect(() => {
    if (!data) return;
    const remaining = Date.parse(data.expiresAt) - Date.now(), timer = setTimeout(end, Math.max(0, Math.min(remaining, 2147483647)));
    return () => clearTimeout(timer);
  }, [data?.expiresAt, end]);
  useEffect(() => { const visible = () => { if (document.visibilityState === "visible") void refresh(false); }; window.addEventListener("focus", visible); window.addEventListener("online", visible); return () => { window.removeEventListener("focus", visible); window.removeEventListener("online", visible); }; }, [refresh]);

  const retire = useCallback((saved: AudienceJournal) => {
    try { clearAudienceJournal(localStorage, saved); retained.current = null; raw.current = null; setPending(null); setNotRecorded(false); setStorageError(null); blockedStorage.current = false; }
    catch (cause) { blockedStorage.current = true; setStorageError(problem(cause)); }
  }, []);
  const accept = useCallback((value: unknown, saved: AudienceJournal) => {
    const result = matchAudienceResult(value, saved); adopt(result.workspace); setInvitation(result.invitation ?? null); retire(saved); setReviewEpoch(epoch => epoch + 1);
    setNotice(saved.kind === "work" ? "The original delivery pass was found. Individual saved inbox receipts show what completed; read its current progress before continuing." : `${result.replayed ? "Original receipt recovered." : "Reviewed instruction saved."} ${result.receipt.message}`);
    return result;
  }, [adopt, retire]);
  const transmit = useCallback(async (saved: AudienceJournal) => {
    if (saved.kind !== "command") throw new Error("An interrupted delivery pass must be read before a new explicit continuation.");
    const epoch = generation.current; raw.current = retainAudienceJournal(localStorage, saved); const checked = await parseAudienceJournal(raw.current, saved);
    if (checked.kind !== "command" || !active.current || epoch !== generation.current || stopped.current) return null;
    retained.current = checked; setPending(checked); setNotRecorded(false);
    const value = await request("/api/audience/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(checked.envelope) });
    if (!active.current || epoch !== generation.current || stopped.current) return null;
    return accept(value, saved);
  }, [accept, request]);
  const submit = useCallback(async (command: AudienceCommand, reviewedRevision: number, origin?: FocusOrigin) => {
    if (lock.current || stopped.current || retained.current || blockedStorage.current || !current.current || !freshRef.current) return null;
    if (reviewedRevision !== current.current.revision) { setError("This review changed. Refresh the exact current facts before approving it."); return null; }
    lock.current = true; setBusy(command.type); setError(null); setNotice(null); const ticket = focus(origin), epoch = generation.current;
    let saved: AudienceJournal | null = null;
    try {
      saved = await prepareAudienceCommand(current.current, { commandId: crypto.randomUUID(), expectedRevision: reviewedRevision, sessionFingerprint: current.current.sessionFingerprint, sessionExpiresAt: current.current.expiresAt, command });
      if (!active.current || epoch !== generation.current || stopped.current) return null;
      raw.current = JSON.stringify(saved);
      try { raw.current = retainAudienceJournal(localStorage, saved); retained.current = saved; setPending(saved); }
      catch (cause) { blockedStorage.current = true; setStorageError(problem(cause)); return null; }
      return await transmit(saved);
    } catch (cause) {
      if (active.current && epoch === generation.current && !stopped.current) { if (saved && cause instanceof AudienceRequestError && definiteAudienceRejection(cause.status, cause.code)) { retire(saved); freshRef.current = false; setFresh(false); setReviewEpoch(value => value + 1); } setError(problem(cause)); }
      return null;
    } finally { lock.current = false; if (active.current) setBusy(null); ticket.complete(); }
  }, [focus, retire, transmit]);
  const recover = useCallback(async (retry = false, origin?: FocusOrigin) => {
    if (lock.current || stopped.current || !retained.current || !current.current) return null;
    lock.current = true; setBusy(retry ? "retry_original" : "recover"); setError(null); setNotice(null); const ticket = focus(origin), epoch = generation.current;
    try {
      const original = localStorage.getItem(audienceRecoveryKey(current.current)) ?? raw.current;
      if (!original) throw new Error("The exact retained instruction is unavailable. Keep its private recovery file and inspect the original server history.");
      const saved = await parseAudienceJournal(original, current.current);
      if (!active.current || epoch !== generation.current || stopped.current) return null;
      if (saved.requestDigest !== retained.current.requestDigest) throw new Error("The retained instruction changed. Refresh before reading a different original result.");
      if (retry) { if (!notRecorded || saved.kind !== "command") throw new Error("Only a recorded absent command receipt permits explicitly retrying the same original command."); return await transmit(saved); }
      setNotRecorded(false); const id = saved.kind === "command" ? saved.envelope.commandId : saved.commandId;
      const value = await request(`/api/audience/commands/${id}`);
      if (!active.current || epoch !== generation.current || stopped.current) return null;
      return accept(value, saved);
    } catch (cause) {
      if (active.current && epoch === generation.current && !stopped.current) {
        if (!retry && retained.current?.kind === "command" && cause instanceof AudienceRequestError && cause.status === 404 && cause.code === "AUDIENCE_RECEIPT_NOT_FOUND") { setNotRecorded(true); setNotice("No receipt is recorded for this exact instruction and session. You may explicitly retry its original identity and unchanged content."); }
        else setError(problem(cause));
      }
      return null;
    } finally { lock.current = false; if (active.current) setBusy(null); ticket.complete(); }
  }, [accept, focus, notRecorded, request, transmit]);

  const readMessage = useCallback(async (id: string, origin: FocusOrigin = false) => {
    if (lock.current || stopped.current || !current.current) return null;
    lock.current = true; setBusy("message"); setError(null); setReviewEpoch(value => value + 1); const ticket = focus(origin), epoch = generation.current;
    if (selected.current?.draft.id !== id) { selected.current = null; setMessage(null); }
    try {
      const next = await parseAudienceMessage(await request(`/api/audience/messages/${id}`));
      if (!active.current || epoch !== generation.current || stopped.current) return null;
      if (!sameAudienceIdentity(current.current!, next) || next.draft.id !== id || next.expiresAt !== current.current!.expiresAt) { end(); throw new Error("The private message belongs to different exact access. It was not adopted."); }
      if (next.revision !== current.current!.revision || next.preview.currentSourceDigest !== current.current!.sourceDigest) await read();
      if (!active.current || epoch !== generation.current || stopped.current) return null;
      selected.current = next; setMessage(next); return next;
    } catch (cause) { if (active.current && epoch === generation.current) { freshRef.current = false; setFresh(false); setError(problem(cause)); } return null; }
    finally { lock.current = false; if (active.current) setBusy(null); ticket.complete(); }
  }, [end, focus, read, request]);
  const openInvitation = useCallback(async (id: string, origin?: FocusOrigin) => {
    if (lock.current || stopped.current || !current.current) return null;
    lock.current = true; setBusy("invitation"); setError(null); const ticket = focus(origin), epoch = generation.current;
    try {
      const next = parseAudienceInvitation(await request(`/api/audience/invites/${id}`));
      if (!active.current || epoch !== generation.current || stopped.current) return null;
      if (next.capabilityId !== id || Date.parse(next.expiresAt) <= Date.now()) throw new Error("This original private invitation is not current. It was not renewed.");
      setInvitation(next); return next;
    } catch (cause) { if (active.current && epoch === generation.current) { if (cause instanceof AudienceRequestError && cause.status === 410) setInvitation(null); setError(problem(cause)); } return null; }
    finally { lock.current = false; if (active.current) setBusy(null); ticket.complete(); }
  }, [focus, request]);
  const work = useCallback(async (passId: string, proof: string, origin?: FocusOrigin) => {
    if (lock.current || stopped.current || retained.current || blockedStorage.current || !current.current || !freshRef.current) return null;
    lock.current = true; setBusy("work"); setError(null); setNotice(null); const ticket = focus(origin), epoch = generation.current;
    try {
      // A real exact-session GET precedes every bounded continuation.
      const original = parseAudienceResult(await request(`/api/audience/commands/${passId}`));
      if (!active.current || epoch !== generation.current || stopped.current) return null;
      if (!sameAudienceIdentity(current.current, original.workspace) || current.current.expiresAt !== original.workspace.expiresAt || original.receipt.commandId !== passId || original.receipt.recordId !== passId || original.receipt.action !== "deliver_message") throw new Error("This saved delivery pass belongs to different original access or instructions.");
      const saved = await prepareAudienceWork(current.current, passId, original.receipt.requestDigest, proof);
      raw.current = JSON.stringify(saved);
      try { raw.current = retainAudienceJournal(localStorage, saved); retained.current = saved; setPending(saved); }
      catch (cause) { blockedStorage.current = true; setStorageError(problem(cause)); return null; }
      if (!active.current || epoch !== generation.current || stopped.current) return null;
      const value = await request("/api/audience/work", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId: passId, proof }) });
      if (!active.current || epoch !== generation.current || stopped.current) return null;
      return accept(value, saved);
    } catch (cause) { if (active.current && epoch === generation.current) { freshRef.current = false; setFresh(false); setError(problem(cause)); } return null; }
    finally { lock.current = false; if (active.current) setBusy(null); ticket.complete(); }
  }, [accept, focus, request]);
  const downloadRecovery = useCallback(() => { const bytes = raw.current ?? (retained.current ? JSON.stringify(retained.current) : null); if (!bytes) return; const url = URL.createObjectURL(new Blob([bytes], { type: "application/json" })), link = document.createElement("a"); link.href = url; link.download = "opening-night-audience-recovery.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }, []);
  const messageFresh = Boolean(message && data && message.revision === data.revision && message.preview.currentSourceDigest === data.sourceDigest && message.expiresAt === data.expiresAt);
  return { data, message, invitation, busy, error, notice, ended, fresh, reviewEpoch, pending, storageError, notRecorded, messageFresh, hasRecoveryFile: Boolean(raw.current || pending), blocked: Boolean(busy || ended || pending || storageError || !fresh), refresh, submit, recover, readMessage, openInvitation, work, downloadRecovery };
}
export type AudienceClient = ReturnType<typeof useAudience>;
