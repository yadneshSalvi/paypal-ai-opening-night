"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SettlementCommand, SettlementCommandResponse, SettlementData, SettlementEnvelope } from "@/domain/settlement/contracts";
import { definiteSettlementRejection, newPendingSettlement, parsePendingSettlement, recoveredSettlement, settlementDataMatches, settlementStorageKey, type PendingSettlement, type SettlementIdentity } from "./recovery";

export type SettlementTransport = (envelope?: SettlementEnvelope) => Promise<Response>;
class SettlementRequestError extends Error { constructor(message: string, public status: number, public code: string) { super(message); } }
const message = (cause: unknown) => cause instanceof Error ? cause.message : "The settlement desk could not be reached. Check the saved request before another action.";
async function responseBody(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new SettlementRequestError(body.error ?? "The settlement request could not finish.", response.status, body.code ?? "UNKNOWN");
  return body;
}

export function useSettlement<T extends SettlementData>(identity: SettlementIdentity, transport: SettlementTransport, onSaved?: () => void) {
  const key = settlementStorageKey(identity), identityRef = useRef(identity); identityRef.current = identity;
  const transportRef = useRef(transport); transportRef.current = transport;
  const savedRef = useRef(onSaved); savedRef.current = onSaved;
  const [data, setData] = useState<T | null>(null), [pending, setPending] = useState<PendingSettlement | null>(null);
  const [busy, setBusy] = useState<"read" | "save" | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null), [damaged, setDamaged] = useState(false), [connected, setConnected] = useState(false), [clock, setClock] = useState(0);
  const current = useRef<T | null>(null), retained = useRef<PendingSettlement | null>(null), activeKey = useRef<string | null>(null), recoveryReady = useRef<string | null>(null), sequence = useRef(0), writing = useRef(false), preparing = useRef(false), reading = useRef<number | null>(null);
  const persist = useCallback((value: PendingSettlement | null) => {
    const raw = value ? JSON.stringify(value) : null;
    if (raw) sessionStorage.setItem(key, raw); else sessionStorage.removeItem(key);
    if (sessionStorage.getItem(key) !== raw) throw new Error("This tab could not retain the exact recovery request. Restore browser storage before submitting another action.");
    retained.current = value; setPending(value); setStorageError(null);
  }, [key]);
  const accept = useCallback((next: T) => {
    if (!settlementDataMatches(next, identityRef.current)) throw new Error("The response belongs to different production access. Its contents were not accepted.");
    if (current.current && next.revision < current.current.revision) return;
    current.current = next; setData(next); setConnected(true); setClock(Date.now());
    if (retained.current && recoveredSettlement(next, retained.current)) {
      try { persist(null); setNotice("The exact saved request has a retained receipt. Its history is available below."); }
      catch (cause) { setStorageError(message(cause)); }
    }
  }, [persist]);
  const refresh = useCallback(async (clearError = true) => {
    if (activeKey.current !== key || recoveryReady.current !== key || reading.current !== null || writing.current || preparing.current) return null;
    const readSequence = ++sequence.current; reading.current = readSequence; setBusy("read");
    try {
      const next = await responseBody(await transportRef.current()) as T;
      if (activeKey.current !== key || readSequence !== sequence.current) return null;
      accept(next); if (clearError) setError(null); return next;
    } catch (cause) { if (activeKey.current === key) { setConnected(false); setError(message(cause)); } return null; }
    finally { if (reading.current === readSequence) reading.current = null; if (activeKey.current === key && readSequence === sequence.current && !writing.current) setBusy(null); }
  }, [key, accept]);
  useEffect(() => {
    activeKey.current = key; recoveryReady.current = null; reading.current = null; current.current = null; retained.current = null; setData(null); setPending(null); setError(null); setNotice(null); setStorageError(null); setDamaged(false); setConnected(false); setClock(Date.now());
    const initialSequence = ++sequence.current;
    void (async () => {
      try { const raw = sessionStorage.getItem(key); if (raw) { const value = await parsePendingSettlement(raw, identityRef.current); if (activeKey.current !== key || initialSequence !== sequence.current) return; retained.current = value; setPending(value); } }
      catch (cause) { if (activeKey.current !== key || initialSequence !== sequence.current) return; setDamaged(true); setStorageError(message(cause)); }
      if (activeKey.current === key && initialSequence === sequence.current) { recoveryReady.current = key; void refresh(); }
    })();
    const focus = () => { if (!document.hidden) void refresh(); }, offline = () => setConnected(false);
    window.addEventListener("focus", focus); window.addEventListener("online", focus); window.addEventListener("offline", offline);
    const tick = setInterval(() => setClock(Date.now()), 1000), poll = setInterval(focus, 30000);
    return () => { activeKey.current = null; recoveryReady.current = null; sequence.current++; clearInterval(tick); clearInterval(poll); window.removeEventListener("focus", focus); window.removeEventListener("online", focus); window.removeEventListener("offline", offline); };
  }, [key, refresh]);
  const transmit = useCallback(async (original: PendingSettlement) => {
    if (activeKey.current !== key || recoveryReady.current !== key || writing.current) return false;
    writing.current = true; sequence.current++; setBusy("save"); setError(null); setNotice(null);
    try {
      // Saving and verifying the exact identity precedes every POST, including a manual retry.
      try { persist(original); } catch (cause) { setStorageError(message(cause)); throw cause; }
      const result = await responseBody(await transportRef.current(original.envelope)) as SettlementCommandResponse<T>;
      if (activeKey.current !== key) return false;
      if (result.receipt?.commandId !== original.envelope.idempotencyKey || !settlementDataMatches(result.data, identityRef.current) || !recoveredSettlement(result.data, original)) throw new Error("The response did not confirm this exact request. Check its saved receipt before another action.");
      accept(result.data); setNotice(result.replayed ? "The original receipt was recovered. No additional record was created." : "Saved with its exact receipt. Payment and physical attendance remain separate.");
      // A secondary console refresh cannot turn a confirmed receipt into an uncertain write.
      try { savedRef.current?.(); } catch { /* The exact settlement read above remains authoritative. */ }
      return true;
    } catch (cause) {
      if (activeKey.current !== key) return false;
      if (cause instanceof SettlementRequestError && definiteSettlementRejection(cause.status, cause.code)) { try { persist(null); } catch (failure) { setStorageError(message(failure)); } }
      setError(message(cause)); return false;
    } finally { writing.current = false; if (activeKey.current === key) { setBusy(null); void refresh(false); } }
  }, [key, persist, accept, refresh]);
  const submit = useCallback(async (command: SettlementCommand, review: { revision: number; productionRevision: number }) => {
    if (activeKey.current !== key || recoveryReady.current !== key || retained.current || damaged || storageError || writing.current || preparing.current) return false;
    preparing.current = true; setBusy("save");
    try {
      const envelope: SettlementEnvelope = { idempotencyKey: crypto.randomUUID(), expectedRevision: review.revision, expectedShowRevision: review.productionRevision, command };
      const original = await newPendingSettlement(identityRef.current, envelope); preparing.current = false; return await transmit(original);
    }
    catch { if (activeKey.current === key) setStorageError("This browser could not verify the exact request identity. No new instruction was sent; restore browser storage and secure-context support before trying again."); return false; }
    finally { preparing.current = false; if (activeKey.current === key && !writing.current && reading.current === null) setBusy(null); }
  }, [key, damaged, storageError, transmit]);
  const retry = useCallback(() => retained.current ? transmit(retained.current) : Promise.resolve(false), [transmit]);
  const restore = useCallback(async (raw: string) => {
    if (activeKey.current !== key || recoveryReady.current !== key || retained.current || damaged || storageError || writing.current || preparing.current) return false;
    preparing.current = true; setBusy("read"); setError(null);
    try {
      const value = await parsePendingSettlement(raw, identityRef.current);
      if (activeKey.current !== key) return false;
      persist(value); setNotice("The saved request was opened for an original-receipt check. No instruction was resent.");
      preparing.current = false; await refresh(); return true;
    } catch (cause) { if (activeKey.current === key) setError(message(cause)); return false; }
    finally { preparing.current = false; if (activeKey.current === key && reading.current === null && !writing.current) setBusy(null); }
  }, [key, damaged, storageError, persist, refresh]);
  const downloadRecovery = useCallback(() => {
    try { const raw = sessionStorage.getItem(key); if (!raw) return; const url = URL.createObjectURL(new Blob([raw], { type: "application/json" })), link = document.createElement("a"); link.href = url; link.download = "opening-night-settlement-request.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch (cause) { setStorageError(message(cause)); }
  }, [key]);
  const clearDamaged = useCallback(async () => { const latest = await refresh(); if (!latest) return; try { persist(null); setDamaged(false); setNotice("The unreadable local draft was cleared after checking server history. Existing receipts remain unchanged."); } catch (cause) { setStorageError(message(cause)); } }, [refresh, persist]);
  const fresh = Boolean(data && connected && clock - Date.parse(data.serverAt) < 60000);
  return { data, pending, busy, error, notice, storageError, damaged, fresh, refresh, submit, retry, restore, downloadRecovery, clearDamaged, blocked: !fresh || Boolean(busy || pending || storageError || damaged) };
}
export type SettlementClient<T extends SettlementData = SettlementData> = ReturnType<typeof useSettlement<T>>;
