"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsoleData } from "@/domain/contracts";
import { productionFetch } from "../production-fetch";
import { acceptedRead, productionIdentity, sameProduction } from "./model";

export type ProductionReadPhase = "ready" | "reading" | "unavailable" | "ended";
/** One scoped GET at a time. A late response cannot replace another production or a newer revision. */
export function useProductionRead(data: ConsoleData, onData: (next: ConsoleData) => void, busy: boolean, enabled: boolean) {
  const identity = productionIdentity(data), current = useRef({ data, onData, busy, enabled, identity });
  current.current = { data, onData, busy, enabled, identity };
  const [state, setState] = useState<{ identity: string; phase: ProductionReadPhase; message: string | null; confirmedAt: number }>({ identity, phase: "ready", message: null, confirmedAt: 0 });
  const inFlight = useRef<{ identity: string; controller: AbortController } | null>(null);
  const ended = useRef<string | null>(null);
  useEffect(() => { ended.current = null; setState({ identity, phase: "ready", message: null, confirmedAt: 0 }); return () => { inFlight.current?.controller.abort(); inFlight.current = null; }; }, [identity]);
  useEffect(() => { if (!enabled) { inFlight.current?.controller.abort(); inFlight.current = null; } }, [enabled]);
  const refresh = useCallback(async () => {
    const owner = current.current;
    if (!owner.enabled || owner.busy || ended.current === owner.identity || inFlight.current || document.visibilityState === "hidden") return false;
    const read = { identity: owner.identity, controller: new AbortController() }; inFlight.current = read;
    setState(previous => ({ identity: owner.identity, phase: "reading", message: null, confirmedAt: previous.identity === owner.identity ? previous.confirmedAt : 0 }));
    try {
      const response = await productionFetch(owner.data.show.tenantId, "/api/show", { cache: "no-store", signal: read.controller.signal });
      if (inFlight.current !== read || !current.current.enabled || current.current.identity !== owner.identity) return false;
      let payload: unknown;
      try { payload = await response.json(); }
      catch {
        if (inFlight.current !== read || !current.current.enabled || current.current.identity !== owner.identity) return false;
        if ([401, 403, 409].includes(response.status)) { ended.current = owner.identity; setState({ identity: owner.identity, phase: "ended", message: "Current production access ended. Its unreadable refusal does not preserve source access; reopen the current production.", confirmedAt: 0 }); return false; }
        throw new Error("The current production response was not a valid read model. The last confirmed view was retained.");
      }
      if (inFlight.current !== read || !current.current.enabled || current.current.identity !== owner.identity) return false;
      if (!response.ok) {
        const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "The current production could not be read.";
        const terminal = [401, 403, 409].includes(response.status);
        if (terminal) ended.current = owner.identity;
        setState({ identity: owner.identity, phase: terminal ? "ended" : "unavailable", message, confirmedAt: 0 }); return false;
      }
      if (!acceptedRead(current.current.data, payload)) {
        const next = payload as Partial<ConsoleData> | null;
        if (next?.show && next.currentActor && typeof next.show.tenantId === "string" && typeof next.currentActor.id === "string" && !sameProduction(owner.data, next as ConsoleData)) { ended.current = owner.identity; setState({ identity: owner.identity, phase: "ended", message: "This read belongs to a different production or operator. Reopen the current production before reading its presentation.", confirmedAt: 0 }); return false; }
        if (acceptedRead(owner.data, payload) && payload.show.revision < current.current.data.show.revision) { setState({ identity: owner.identity, phase: "ready", message: "A later confirmed revision is already displayed.", confirmedAt: Date.now() }); return false; }
        setState({ identity: owner.identity, phase: "unavailable", message: "This response does not match the displayed production and current revision. The last confirmed view was retained.", confirmedAt: 0 }); return false;
      }
      current.current.onData(payload); setState({ identity: owner.identity, phase: "ready", message: null, confirmedAt: Date.now() }); return true;
    } catch (error) {
      if (inFlight.current === read && current.current.identity === owner.identity && !read.controller.signal.aborted) setState({ identity: owner.identity, phase: "unavailable", message: error instanceof Error ? error.message : "The current production read did not complete. The last confirmed view was retained.", confirmedAt: 0 });
      return false;
    } finally { if (inFlight.current === read) inFlight.current = null; }
  }, []);
  return { phase: state.identity === identity ? state.phase : "ready" as ProductionReadPhase, message: state.identity === identity ? state.message : null, confirmedAt: state.identity === identity ? state.confirmedAt : 0, refresh };
}
