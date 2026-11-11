"use client";
import { useCallback, useEffect, useState } from "react";

export function useOfflineCrewShell() {
  const [state, setState] = useState<"preparing" | "ready" | "unavailable">("preparing");
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const prepare = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) { setState("unavailable"); return; }
    try {
      const existing = await navigator.serviceWorker.getRegistration("/crew/");
      const registration = existing?.scope === location.origin + "/crew/" && existing.active?.scriptURL === location.origin + "/crew/sw.js"
        ? existing : await navigator.serviceWorker.register("/crew/sw.js", { scope: "/crew/", updateViaCache: "none" });
      if (navigator.onLine) void registration.update().catch(() => undefined);
      const worker = registration.active ?? registration.installing ?? registration.waiting;
      if (!worker) throw new Error("The crew shell worker is unavailable");
      if (worker.state !== "activated") await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { worker.removeEventListener("statechange", changed); reject(new Error("Crew shell installation is still pending")); }, 15000);
        const changed = () => { if (worker.state === "activated") { clearTimeout(timeout); worker.removeEventListener("statechange", changed); resolve(); } };
        worker.addEventListener("statechange", changed); changed();
      });
      const ready = await new Promise<{ cachedAt: string }>((resolve, reject) => {
        const channel = new MessageChannel();
        const timeout = setTimeout(() => { channel.port1.close(); reject(new Error("Crew shell caching is still pending")); }, 20000);
        channel.port1.onmessage = event => {
          clearTimeout(timeout); channel.port1.close();
          if (event.data?.type === "CREW_OFFLINE_READY" && typeof event.data.cachedAt === "string") resolve(event.data);
          else reject(new Error("Crew shell caching is unavailable"));
        };
        worker.postMessage({ type: "PREPARE_CREW_OFFLINE" }, [channel.port2]);
      });
      setCachedAt(ready.cachedAt); setState("ready");
    } catch { setState("unavailable"); }
  }, []);
  useEffect(() => {
    void prepare();
    const reconnect = () => { void prepare(); };
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [prepare]);
  return { state, cachedAt, prepare };
}
