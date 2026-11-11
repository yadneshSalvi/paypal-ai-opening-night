"use client";
import { useState } from "react";
import { LockKeyhole, RefreshCw } from "lucide-react";
import { z } from "zod";
import type { ConsoleData } from "@/domain/contracts";
import { productionFetch } from "./production-fetch";
import { Badge, Button, Modal } from "./ui";

const overviewSchema = z.object({ revision: z.number().int().positive(), people: z.array(z.object({ personId: z.string(), activeLinks: z.number().int().nonnegative(), latestExpiry: z.string().nullable() })) });
type Overview = z.infer<typeof overviewSchema>;
interface RevokeReview { personId: string; expectedRevision: number; idempotencyKey: string; confirmed: true }
export function CrewAccessManager({ data, onData }: { data: ConsoleData; onData: (data: ConsoleData) => void }) {
  const [open, setOpen] = useState(false), [overview, setOverview] = useState<Overview | null>(null);
  const [selected, setSelected] = useState("");
  const [confirmed, setConfirmed] = useState(false), [pending, setPending] = useState<RevokeReview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const load = async () => {
    setBusy(true); setError(null);
    try { const response = await productionFetch(data.show.tenantId, "/api/crew/access", { cache: "no-store" }); const body = await response.json(); if (!response.ok) throw new Error(body.error); const next = overviewSchema.parse(body); setOverview(next); return next; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Personal access could not be checked."); return null; }
    finally { setBusy(false); }
  };
  const revoke = async () => {
    if (!overview || !selected || !confirmed || busy) return;
    const reviewed = pending ?? { personId: selected, expectedRevision: overview.revision, idempotencyKey: crypto.randomUUID(), confirmed: true as const };
    setPending(reviewed); setBusy(true); setError(null); setNotice(null);
    try {
      const response = await productionFetch(data.show.tenantId, "/api/crew/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reviewed) });
      const body = await response.json();
      if (!response.ok) {
        if (body.code === "STALE_REVISION") { setPending(null); setConfirmed(false); await load(); }
        throw new Error(body.error);
      }
      onData(body); setPending(null); setConfirmed(false); setSelected("");
      setNotice("The reviewed person's current links are revoked. Existing readbacks and signed records remain in history."); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The response was lost. Check access or retry the same reviewed request."); }
    finally { setBusy(false); }
  };
  const person = data.show.resources.find(item => item.id === selected);
  return <><Button onClick={() => { setOpen(true); void load(); }}><LockKeyhole size={15} />Manage personal links</Button>{open && <Modal title="Personal crew access" onClose={() => setOpen(false)} dismissible={!busy}><div className="crew-action-review"><p>Each link belongs to one rostered person and expires after 24 hours. Revocation stops further access; it preserves previously recorded actions.</p>{error && <p className="notification error" role="alert">{error}</p>}{notice && <p className="notification" role="status">{notice}</p>}<div className="crew-access-rows">{overview?.people.map(row => <button type="button" key={row.personId} aria-pressed={selected === row.personId} disabled={busy || Boolean(pending && pending.personId !== row.personId)} onClick={() => { setSelected(row.personId); setConfirmed(false); }}><span>{data.show.resources.find(item => item.id === row.personId)?.name}</span><Badge tone={row.activeLinks ? "amber" : "muted"}>{row.activeLinks} active</Badge></button>)}</div><Button onClick={() => void load()} disabled={busy} busy={busy}><RefreshCw size={14} />Check current access</Button>{person && <><label className="crew-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /><span>Revoke the currently active links for {person.name}. A new invitation will be needed for further actions.</span></label><Button variant="primary" disabled={!confirmed || busy} onClick={() => void revoke()} busy={busy}>{pending ? "Retry exact reviewed revocation" : `Revoke ${person.name.split(" ")[0]}'s current links`}</Button></>}</div></Modal>}</>;
}
