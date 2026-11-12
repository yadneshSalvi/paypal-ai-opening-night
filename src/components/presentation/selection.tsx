"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConsoleData } from "@/domain/contracts";
import { parseSelection, productionIdentity, sameSelection, selectionDetail, type ProductionSelection, type SelectionDetail } from "./model";

interface LinkedSelection {
  selection: ProductionSelection | null; detail: SelectionDetail | null; active: boolean;
  select: (selection: ProductionSelection, trigger?: HTMLElement | null) => void;
  clear: (restoreFocus?: boolean) => void;
}
const Context = createContext<LinkedSelection | null>(null);
export const selectionStorageKey = (data: ConsoleData) => "opening-night:linked-selection:" + productionIdentity(data);
export function ProductionSelectionProvider({ data, active = true, children }: { data: ConsoleData; active?: boolean; children: ReactNode }) {
  const identity = productionIdentity(data), storageKey = selectionStorageKey(data);
  const current = useRef({ data, active, identity }); current.current = { data, active, identity };
  const [saved, setSaved] = useState<{ identity: string; selection: ProductionSelection | null }>({ identity, selection: null });
  const trigger = useRef<HTMLElement | null>(null);
  const candidate = active && saved.identity === identity ? saved.selection : null;
  const detail = useMemo(() => selectionDetail(data, candidate), [data, candidate]);
  const selection = detail?.selection ?? null;
  useEffect(() => {
    trigger.current = null;
    if (!active) { setSaved({ identity, selection: null }); return; }
    let restored: ProductionSelection | null = null;
    try { const raw = sessionStorage.getItem(storageKey); if (raw && raw.length <= 1000) { const parsed = parseSelection(JSON.parse(raw)); if (selectionDetail(current.current.data, parsed)) restored = parsed; } if (raw && !restored) sessionStorage.removeItem(storageKey); } catch { try { sessionStorage.removeItem(storageKey); } catch {} /* Storage never supplies authority or source content. */ }
    setSaved({ identity, selection: restored });
  }, [identity, active, storageKey]);
  useEffect(() => {
    if (saved.identity === identity && saved.selection && !detail) { setSaved({ identity, selection: null }); try { sessionStorage.removeItem(storageKey); } catch {} }
  }, [detail, identity, saved, storageKey]);
  const select = useCallback((next: ProductionSelection, element?: HTMLElement | null) => {
    const scope = current.current;
    if (!scope.active || !selectionDetail(scope.data, parseSelection(next))) return;
    // Inspector-internal links replace their own DOM; retain the original
    // external activation target for close/Escape focus recovery.
    if (element && !element.closest(".presentation-inspector")) trigger.current = element;
    setSaved(previous => previous.identity === scope.identity && sameSelection(previous.selection, next) ? previous : { identity: scope.identity, selection: next });
    try { sessionStorage.setItem(selectionStorageKey(scope.data), JSON.stringify(next)); } catch {}
  }, []);
  const clear = useCallback((restoreFocus = false) => {
    const scope = current.current; setSaved({ identity: scope.identity, selection: null });
    try { sessionStorage.removeItem(selectionStorageKey(scope.data)); } catch {}
    const previous = trigger.current; trigger.current = null;
    if (restoreFocus) queueMicrotask(() => {
      if (previous?.isConnected && !previous.closest("[inert]") && !previous.matches(":disabled")) previous.focus({ preventScroll: true });
      else { const heading = document.querySelector<HTMLElement>("[data-presentation-heading],#main h1"); if (heading && !heading.closest("[inert]")) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); } }
    });
  }, []);
  const value = useMemo(() => ({ selection, detail, active, select, clear }), [selection, detail, active, select, clear]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useLinkedSelection = () => useContext(Context);
