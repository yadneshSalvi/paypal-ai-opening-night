"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { crewDataSchema, type CrewCommandEnvelope, type CrewCommandResponse, type CrewData, type CrewLiveCommand } from "@/domain/crew/contracts";
import type { SettlementEnvelope } from "@/domain/settlement/contracts";
import { capabilityFingerprint, emptyOutbox, prepareReadbackAttempt, queueReadback, readbackEnvelope, readCache, readOutbox, recoveredReadback, rejectStaleReadback, retireLegacyCrewStorage, saveCache, saveOutbox, storageKeys, type CrewOutbox, type LegacyCrewDraft, type PendingLiveAction } from "./storage";

type Connection = "loading" | "online" | "offline" | "unreachable" | "expired";
class CrewRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
async function responseBody(response: Response) {
  let body;
  try { body = await response.json(); } catch { throw new Error("The response was incomplete. Keep the saved request and check its receipt before retrying."); }
  if (!response.ok) throw new CrewRequestError(typeof body.error === "string" ? body.error : "The crew service could not complete this request.", response.status, typeof body.code === "string" ? body.code : "UNKNOWN");
  return body;
}
const message = (error: unknown) => error instanceof Error ? error.message : "Your personal sheet could not be reached.";

export function useCrewClient() {
  const [access, setAccess] = useState<{ token: string; fingerprint: string } | null>(null);
  const [data, setData] = useState<CrewData | null>(null);
  const [outbox, setOutbox] = useState<CrewOutbox | null>(null);
  const [legacyDraft, setLegacyDraft] = useState<LegacyCrewDraft | null>(null);
  const [connection, setConnection] = useState<Connection>("loading");
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [clock, setClock] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [cacheWarning, setCacheWarning] = useState<string | null>(null);
  const current = useRef<CrewData | null>(null);
  const queue = useRef<CrewOutbox | null>(null);
  const posting = useRef(false);
  const accessEnded = useRef(false);
  const reading = useRef<Promise<CrewData | null> | null>(null);

  const persist = useCallback((next: CrewOutbox) => {
    try { saveOutbox(localStorage, next); queue.current = next; setOutbox(next); setStorageError(null); }
    catch (cause) { setStorageError(message(cause)); throw cause; }
  }, []);

  const endAccess = useCallback(() => {
    accessEnded.current = true;
    setConnection("expired"); current.current = null; setData(null); setNotice(null);
    if (access) try { localStorage.removeItem(storageKeys(access.fingerprint).cache); } catch { /* The expired copy is never rendered. */ }
  }, [access]);

  const accept = useCallback((next: CrewData) => {
    if (accessEnded.current) throw new CrewRequestError("This personal access has ended. Open a new link from the production desk.", 401, "CREW_ACCESS_EXPIRED");
    if (!access) return next;
    // A slower read must never overwrite the revision just returned by a write.
    if (current.current && current.current.show.revision > next.show.revision) return current.current;
    current.current = next; setData(next); setConnection("online"); setError(null);
    try { const cached = saveCache(localStorage, access.fingerprint, next); setCachedAt(cached.cachedAt); setCacheWarning(null); }
    catch { setCacheWarning("This browser cannot save an offline copy. Keep this page online or enable local storage."); }
    try {
      const saved = queue.current ?? readOutbox(localStorage, access.fingerprint);
      const found = saved.readbacks.filter(pending => recoveredReadback(next, pending));
      const liveFound = saved.live && next.history.some(record => record.commandId === saved.live!.envelope.idempotencyKey);
      if (found.length || liveFound) {
        const sameSheetElsewhere = found.some(pending => recoveredReadback(next, pending)?.commandId !== pending.idempotencyKey);
        persist({ ...saved, readbacks: saved.readbacks.filter(pending => !recoveredReadback(next, pending)), live: liveFound ? null : saved.live });
        setNotice(found.some(pending => pending.command.sheetDigest !== next.sheet.digest)
          ? "The saved historical readback is recorded. Review the current sheet separately; that older readback does not clear its changes."
          : liveFound ? "The saved action has a recorded receipt. Its current or historical status appears below." : sameSheetElsewhere ? "This exact sheet already has your personal readback from another request. The saved duplicate was not sent again." : "Your saved readback has a recorded receipt.");
      } else { queue.current = saved; setOutbox(saved); }
    } catch (cause) { setStorageError(message(cause)); }
    return next;
  }, [access, persist]);

  const refresh = useCallback(async (): Promise<CrewData | null> => {
    if (!access) return null;
    if (reading.current) return reading.current;
    const request = (async () => {
      try {
        const response = await fetch("/api/crew", { headers: { Authorization: `Bearer ${access.token}` }, credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(12000) });
        return accept(crewDataSchema.parse(await responseBody(response)));
      } catch (cause) {
        if (cause instanceof CrewRequestError && (cause.status === 401 || cause.status === 403)) {
          endAccess(); setError(message(cause));
        } else if (!navigator.onLine) {
          setConnection("offline");
          setError(current.current ? null : "You are offline and this browser has no saved personal sheet. Open your access link online once to save it for later.");
        } else {
          setConnection("unreachable");
          setError(cause instanceof TypeError || (cause instanceof Error && ["AbortError", "TimeoutError"].includes(cause.name))
            ? "The crew service cannot be reached. Any saved sheet and requests remain on this device. Reconnect, then refresh before checking receipts and syncing."
            : message(cause));
        }
        return null;
      }
    })();
    reading.current = request;
    try { return await request; } finally { reading.current = null; }
  }, [access, accept, endAccess]);

  useEffect(() => {
    let active = true;
    // A second personal link can navigate within this same document. Start a
    // fresh client so no sheet, in-flight read or queue crosses capabilities.
    // Ordinary page anchors must not replace the tab's personal access.
    const followPersonalLink = () => {
      if (/^[A-Za-z0-9_-]{43}$/.test(location.hash.slice(1))) location.reload();
    };
    window.addEventListener("hashchange", followPersonalLink);
    void (async () => {
      setClock(Date.now());
      const hash = location.hash.slice(1);
      let token = hash === "main" ? "" : hash;
      if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
        // Capability material lives only in this tab's session storage. Remove
        // the URL fragment before the first network request or cache write.
        history.replaceState(null, "", location.pathname + location.search);
        try { sessionStorage.setItem("opening-night-crew", hash); } catch { /* The open tab can still use its in-memory capability. */ }
      } else if (!token) { try { token = sessionStorage.getItem("opening-night-crew") ?? ""; } catch { /* No reusable tab session. */ } }
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { setError("This personal access link has no valid capability. Open a new link from the crew readback desk."); setConnection("expired"); return; }
      const fingerprint = await capabilityFingerprint(token);
      if (!active) return;
      try {
        setLegacyDraft(retireLegacyCrewStorage(localStorage, token, fingerprint));
        const cached = readCache(localStorage, fingerprint);
        if (cached) { current.current = cached.data; setData(cached.data); setCachedAt(cached.cachedAt); setConnection(navigator.onLine ? "loading" : "offline"); }
        const saved = readOutbox(localStorage, fingerprint); queue.current = saved; setOutbox(saved);
      } catch (cause) { setStorageError(message(cause)); }
      setAccess({ token, fingerprint });
    })().catch(cause => { setError(message(cause)); setConnection("unreachable"); });
    return () => { active = false; window.removeEventListener("hashchange", followPersonalLink); };
  }, []);

  useEffect(() => {
    if (!access) return;
    void refresh();
    const online = () => { void refresh(); };
    const offline = () => { setConnection("offline"); setError(null); };
    const focus = () => { if (!posting.current && document.visibilityState === "visible") void refresh(); };
    const poll = setInterval(focus, 20000);
    const tick = setInterval(() => {
      const now = Date.now(); setClock(now);
      if (current.current && Date.parse(current.current.access.expiresAt) <= now) { endAccess(); setError("This personal capability has expired. Ask the production desk for a new link. Saved requests remain on this device for review."); }
    }, 1000);
    window.addEventListener("online", online); window.addEventListener("offline", offline); window.addEventListener("focus", focus);
    return () => { clearInterval(poll); clearInterval(tick); window.removeEventListener("online", online); window.removeEventListener("offline", offline); window.removeEventListener("focus", focus); };
  }, [access, refresh, endAccess]);

  const transmit = useCallback(async (envelope: CrewCommandEnvelope): Promise<CrewCommandResponse> => {
    if (!access) throw new Error("Open a personal crew capability before recording this action.");
    const response = await fetch("/api/crew", { method: "POST", headers: { Authorization: `Bearer ${access.token}`, "Content-Type": "application/json" }, credentials: "omit", body: JSON.stringify(envelope), signal: AbortSignal.timeout(15000) });
    if (response.status === 401) endAccess();
    const body = await responseBody(response);
    const next = crewDataSchema.parse(body.data);
    if (!body.receipt || body.receipt.commandId !== envelope.idempotencyKey || typeof body.replayed !== "boolean") throw new Error("The response did not include this request's receipt. Its exact identity is saved; check before retrying.");
    accept(next);
    return { data: next, receipt: body.receipt, replayed: body.replayed };
  }, [access, accept, endAccess]);

  const syncReadbacks = useCallback(async () => {
    if (posting.current || !access) return;
    posting.current = true; setBusy("readback"); setError(null); setNotice(null);
    try {
      let latest = await refresh(); if (!latest) return;
      let attempts = 0;
      while (queue.current?.readbacks.length && attempts++ < 35) {
        const saved = queue.current;
        const first = saved.readbacks[0];
        if (first.personId !== latest.person.id) throw new Error("The saved request belongs to another person. Its identity has been retained; ask the production desk to review access.");
        const pending = prepareReadbackAttempt(first, latest.show.revision);
        persist({ ...saved, readbacks: [pending, ...saved.readbacks.slice(1)] });
        try {
          const result = await transmit(readbackEnvelope(pending)); latest = result.data;
          // The authenticated history is the recovery authority. Keep the queue
          // if an otherwise successful response lacks the expected readback.
          if (!recoveredReadback(latest, pending)) throw new Error("The service response needs a readback check. Keep the saved request and refresh before retrying.");
          setNotice(result.receipt.current ? "Your current run sheet readback is recorded." : "Your historical readback is recorded. The current sheet still needs its own review.");
        } catch (cause) {
          if (cause instanceof CrewRequestError && cause.code === "STALE_REVISION") {
            persist({ ...queue.current!, readbacks: queue.current!.readbacks.map(item => item.idempotencyKey === pending.idempotencyKey ? rejectStaleReadback(pending) : item) });
            latest = await refresh(); if (!latest) return;
            continue;
          }
          if (cause instanceof CrewRequestError && cause.code === "ALREADY_ACKNOWLEDGED") {
            latest = await refresh(); if (latest && recoveredReadback(latest, pending)) continue;
          }
          throw cause;
        }
      }
      if (queue.current?.readbacks.length) setNotice("Other crew are updating this production. Your exact requests are saved; check receipts and sync again.");
    } catch (cause) { setError(message(cause)); }
    finally { posting.current = false; setBusy(null); }
  }, [access, persist, refresh, transmit]);

  const acknowledge = useCallback(async (seen: string[]) => {
    if (!current.current || !access || posting.current) return;
    try {
      const latest = current.current;
      const saved = queue.current ?? readOutbox(localStorage, access.fingerprint);
      const offlineReview = connection !== "online" || !navigator.onLine || Date.now() - Date.parse(latest.serverAt) >= 60000;
      if (!saved.readbacks.some(item => item.command.sheetDigest === latest.sheet.digest)) {
        const pending = queueReadback(latest, seen, offlineReview);
        persist({ ...saved, readbacks: [...saved.readbacks, pending] });
      }
      setNotice("The exact readback is saved on this device. It counts toward readiness only after the service records it.");
      if (!offlineReview) await syncReadbacks();
    } catch (cause) { setError(message(cause)); }
  }, [access, connection, persist, syncReadbacks]);

  const sendLive = useCallback(async (pending: PendingLiveAction) => {
    if (posting.current || !access) return false;
    posting.current = true; setBusy("action"); setError(null); setNotice(null);
    try {
      const saved = queue.current ?? readOutbox(localStorage, access.fingerprint);
      if (saved.live && saved.live.envelope.idempotencyKey !== pending.envelope.idempotencyKey) throw new Error("Check the existing action's receipt before starting another live review.");
      persist({ ...saved, live: pending });
      const result = await transmit(pending.envelope);
      if (!result.data.history.some(record => record.commandId === pending.envelope.idempotencyKey)) throw new Error("Check the saved action's receipt before another cue. Its exact request remains on this device.");
      setNotice(result.receipt.current ? "Your reviewed action is signed and recorded." : "The saved action was recorded against an earlier sheet. It remains in your history.");
      return true;
    } catch (cause) {
      // Validation and stale failures are definite no-commit outcomes. A 5xx,
      // timeout or identity conflict stays saved until its receipt is checked.
      if (cause instanceof CrewRequestError && [400, 409, 422].includes(cause.status) && cause.code !== "IDEMPOTENCY_CONFLICT") {
        persist({ ...queue.current!, live: null }); await refresh();
      }
      setError(message(cause)); return false;
    } finally { posting.current = false; setBusy(null); }
  }, [access, persist, refresh, transmit]);

  const reviewAction = useCallback((command: CrewLiveCommand, revision: number) => {
    if (!current.current) return null;
    return { personId: current.current.person.id, createdAt: new Date().toISOString(), envelope: { idempotencyKey: crypto.randomUUID(), expectedRevision: revision, command } } satisfies PendingLiveAction;
  }, []);
  const clearActionFeedback = useCallback(() => { if (!posting.current) { setError(null); setNotice(null); } }, []);
  const resetDamagedQueue = useCallback(async () => {
    if (!access || posting.current || queue.current) return;
    const latest = await refresh(); if (!latest) return;
    persist(emptyOutbox(access.fingerprint));
    setNotice("The damaged local queue was cleared after checking the service. Existing server receipts remain in your history. Review any missing action before creating a new request.");
  }, [access, persist, refresh]);
  const retryStorage = useCallback(() => {
    if (!access) return;
    try { setLegacyDraft(retireLegacyCrewStorage(localStorage, access.token, access.fingerprint)); const saved = readOutbox(localStorage, access.fingerprint); persist(saved); void refresh(); }
    catch (cause) { setStorageError(message(cause)); }
  }, [access, persist, refresh]);
  const clearLegacyDraft = useCallback(async () => {
    if (!access || posting.current || !legacyDraft) return;
    const latest = await refresh(); if (!latest) return;
    try {
      const key = storageKeys(access.fingerprint).legacyDraft; localStorage.removeItem(key);
      if (localStorage.getItem(key) !== null) throw new Error("The older draft could not be removed from this browser.");
      setLegacyDraft(null); setNotice("The older local draft was removed after checking the service. Its server history is unchanged.");
    } catch (cause) { setStorageError(message(cause)); }
  }, [access, legacyDraft, refresh]);
  const exportSavedRequests = useCallback(() => {
    if (!access) return;
    try {
      const raw = localStorage.getItem(storageKeys(access.fingerprint).outbox);
      if (!raw) { setNotice("This device has no saved request queue to download."); return; }
      const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "opening-night-personal-recovery.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setStorageError(message(cause)); }
  }, [access]);
  const requestSettlement = useCallback(async (envelope?: SettlementEnvelope) => {
    if (!access || accessEnded.current) throw new Error("Open your current personal crew access before reading or reporting hours.");
    const response = await fetch("/api/crew/settlement", { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${access.token}`, ...(envelope ? { "Content-Type": "application/json" } : {}) }, ...(envelope ? { method: "POST", body: JSON.stringify(envelope) } : {}) });
    if (response.status === 401) endAccess();
    return response;
  }, [access, endAccess]);
  return { data, outbox, legacyDraft, connection, cachedAt, clock, busy, error, notice, storageError, cacheWarning, refresh, acknowledge, syncReadbacks, sendLive, reviewAction, clearActionFeedback, retryStorage, resetDamagedQueue, clearLegacyDraft, exportSavedRequests, requestSettlement };
}
