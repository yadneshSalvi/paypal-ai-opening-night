"use client";
import { useEffect, useState } from "react";

export type JudgeDevice = "controlled" | "judge";
const STORAGE = "opening-night:judge-device";

/**
 * A guided demonstration opens the crew client with `device=controlled` or
 * `device=judge`. The flag is remembered for this tab and this person only, so
 * the label survives a reload and never follows another person's link.
 */
export function useJudgeDevice(personId: string | undefined): JudgeDevice | null {
  const [device, setDevice] = useState<JudgeDevice | null>(null);
  useEffect(() => {
    let flag: JudgeDevice | null = null;
    try { const query = new URLSearchParams(location.search).get("device"); if (query === "controlled" || query === "judge") flag = query; } catch { /* No readable address: fall back to the saved flag. */ }
    if (personId) {
      try {
        if (flag) sessionStorage.setItem(STORAGE, JSON.stringify({ device: flag, personId }));
        else { const saved = JSON.parse(sessionStorage.getItem(STORAGE) ?? "null"); if (saved?.personId === personId && (saved.device === "controlled" || saved.device === "judge")) flag = saved.device; }
      } catch { /* The address flag still labels this page when storage is unavailable. */ }
    }
    setDevice(flag);
  }, [personId]);
  return device;
}

/** Slim, non-dismissible label inside the crew client. It never claims a real crew member's phone. */
export function JudgeDeviceBanner({ device, personName }: { device: JudgeDevice | null; personName?: string | undefined }) {
  if (!device) return null;
  return <p className={`judge-device-banner ${device}`} role="note">{device === "controlled" ? "CONTROLLED DEVICE - guided demonstration" : `JUDGE DEVICE - you are standing in for ${personName ?? "a fictional crew member"}`}</p>;
}
