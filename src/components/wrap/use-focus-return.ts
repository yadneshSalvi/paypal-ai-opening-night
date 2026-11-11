"use client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ACTIVE_REHEARSAL_STORAGE, PRODUCTION_CHANGED_EVENT } from "../production-fetch";

/** `false` marks background work, which must never acquire a person's focus. */
export type FocusOrigin = HTMLElement | null | false;
export type FocusReturn = { complete: () => void; cancel: () => void; canRestore: () => boolean };
type Ticket = FocusReturn & { ready: boolean; restore: () => void };
const noReturn: FocusReturn = { complete() {}, cancel() {}, canRestore: () => false };

function focusableNow(target: HTMLElement | null): target is HTMLElement {
  if (!target?.isConnected || target === target.ownerDocument.body || target === target.ownerDocument.documentElement || target.matches(":disabled") || target.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
  const style = target.ownerDocument.defaultView?.getComputedStyle(target);
  return Boolean(target.getClientRects().length && style?.visibility === "visible" && style.display !== "none");
}

/** Restore only after React has re-enabled the control, within its original view. */
export function useFocusReturn(scope: string, fallback: () => HTMLElement | null) {
  const active = useRef<Ticket | null>(null), mounted = useRef(false), generation = useRef(0);
  const currentScope = useRef(scope), currentFallback = useRef(fallback);
  currentScope.current = scope; currentFallback.current = fallback;
  const [completion, setCompletion] = useState(0);

  useLayoutEffect(() => {
    mounted.current = true;
    generation.current += 1;
    return () => { mounted.current = false; generation.current += 1; active.current?.cancel(); };
  }, [scope]);

  useLayoutEffect(() => {
    if (active.current?.ready) active.current.restore();
  }, [completion, scope]);

  return useCallback((origin?: FocusOrigin): FocusReturn => {
    if (origin === false || !mounted.current) return noReturn;
    const opener = origin ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (!opener || opener === document.body || opener === document.documentElement || !opener.isConnected) return noReturn;
    active.current?.cancel();
    const documentAtStart = opener.ownerDocument, windowAtStart = documentAtStart.defaultView;
    const scopeAtStart = currentScope.current, generationAtStart = generation.current;
    const dialog = opener.closest("dialog[open]");
    let moved = false, cancelled = false;
    const onFocus = (event: FocusEvent) => {
      if (event.target !== opener && event.target !== documentAtStart.body && event.target !== documentAtStart.documentElement) moved = true;
    };
    const onPointer = (event: Event) => { if (!(event.target instanceof Node) || !opener.contains(event.target)) moved = true; };
    const onKey = (event: KeyboardEvent) => { if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) moved = true; };
    const onLeave = () => { moved = true; };
    const onStorage = (event: StorageEvent) => { if (event.key === ACTIVE_REHEARSAL_STORAGE) moved = true; };
    const onVisibility = () => { if (documentAtStart.visibilityState === "hidden") moved = true; };
    const dispose = () => {
      documentAtStart.removeEventListener("focusin", onFocus, true);
      documentAtStart.removeEventListener("pointerdown", onPointer, true);
      documentAtStart.removeEventListener("keydown", onKey, true);
      documentAtStart.removeEventListener("visibilitychange", onVisibility);
      windowAtStart?.removeEventListener("blur", onLeave);
      windowAtStart?.removeEventListener(PRODUCTION_CHANGED_EVENT, onLeave);
      windowAtStart?.removeEventListener("storage", onStorage);
      if (active.current === ticket) active.current = null;
    };
    const canRestore = () => {
      const focused = documentAtStart.activeElement;
      const openDialog = [...documentAtStart.querySelectorAll("dialog[open]")].at(-1) ?? null;
      return !cancelled && !moved && mounted.current && generation.current === generationAtStart && currentScope.current === scopeAtStart
        && (focused === opener || focused === documentAtStart.body || focused === documentAtStart.documentElement)
        && (!dialog || dialog.isConnected && dialog.hasAttribute("open")) && openDialog === dialog;
    };
    const ticket: Ticket = {
      ready: false,
      canRestore,
      complete() { if (!cancelled && mounted.current && active.current === ticket && !ticket.ready) { ticket.ready = true; setCompletion(value => value + 1); } },
      cancel() { cancelled = true; dispose(); },
      restore() {
        const allowed = canRestore(); dispose(); cancelled = true;
        if (!allowed) return;
        // A closing native dialog owns its opener restoration. An open dialog
        // keeps any error fallback inside its own focus boundary.
        const fallbackTarget = dialog instanceof HTMLElement ? dialog : currentFallback.current();
        const target = focusableNow(opener) ? opener : focusableNow(fallbackTarget) ? fallbackTarget : null;
        if (target) target.focus({ preventScroll: true });
      },
    };
    active.current = ticket;
    documentAtStart.addEventListener("focusin", onFocus, true);
    documentAtStart.addEventListener("pointerdown", onPointer, true);
    documentAtStart.addEventListener("keydown", onKey, true);
    documentAtStart.addEventListener("visibilitychange", onVisibility);
    windowAtStart?.addEventListener("blur", onLeave);
    windowAtStart?.addEventListener(PRODUCTION_CHANGED_EVENT, onLeave);
    windowAtStart?.addEventListener("storage", onStorage);
    return ticket;
  }, []);
}
