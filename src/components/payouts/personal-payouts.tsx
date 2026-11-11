"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Banknote, RefreshCw } from "lucide-react";
import type { PersonalPayoutData } from "@/domain/payouts/contracts";
import { Button, EmptyState } from "../ui";
import { PayoutItem } from "./shared";
export function PersonalPayouts({ actorId, personId, request }: { actorId: string; personId: string; request: () => Promise<Response> }) {
  const [data, setData] = useState<PersonalPayoutData | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), active = useRef(true), reading = useRef(false), transport = useRef(request); transport.current = request;
  const refresh = useCallback(async () => {
    if (reading.current) return; reading.current = true; setBusy(true);
    try { const response = await transport.current(), value = await response.json(); if (!response.ok) throw new Error(value.error ?? "Your payout history could not be reached.");
      if (value.schemaVersion !== 1 || value.scope !== "personal" || value.actorId !== actorId || value.personId !== personId || !Array.isArray(value.items) || value.items.some((item: { personId: string }) => item.personId !== personId)) throw new Error("This response does not match your current personal access.");
      if (active.current) { setData(value); setError(null); }
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : "Reconnect to read your original payout items."); }
    finally { reading.current = false; if (active.current) setBusy(false); }
  }, [actorId, personId]);
  useEffect(() => { active.current = true; void refresh(); const focus = () => { if (!document.hidden) void refresh(); }; const poll = setInterval(focus, 30000); window.addEventListener("online", focus); window.addEventListener("focus", focus); return () => { active.current = false; clearInterval(poll); window.removeEventListener("online", focus); window.removeEventListener("focus", focus); }; }, [refresh]);
  return <section className="payout-personal" aria-labelledby="personal-payout-heading"><div className="settlement-heading"><div><span className="eyebrow">YOUR PAYMENT HISTORY</span><h2 id="personal-payout-heading">A receipt for your work.</h2></div><Button ariaLabel="Refresh your payout history" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} /></Button></div><p>These are only your original payout items. Recipient approval and reported work remain separate from a verified credit.</p>{error && <p className="settlement-feedback error" role="alert">{error}</p>}{!data ? <p role="status">{busy ? "Reading your private payout history…" : "Reconnect and refresh to read your history."}</p> : data.items.length ? <div className="payout-items">{data.items.slice().reverse().map(item => <PayoutItem key={item.senderItemId} item={item} />)}</div> : <EmptyState icon={<Banknote size={23} />} title="No payout has been instructed for you.">Your approved liabilities stay available in the hours history above. Payment requires the producer’s separate exact recipient review.</EmptyState>}</section>;
}
