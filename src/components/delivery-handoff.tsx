"use client";
import { useState } from "react";
import { Copy, QrCode, RefreshCw, ShieldCheck } from "lucide-react";
import type { DeliveryAccessData } from "@/domain/supplier-contracts";
import { Badge, Button, Modal } from "./ui";

export function DeliveryIssuer({ executionId, bearer, onChanged }: { executionId: string; bearer?: string; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ data: DeliveryAccessData; image: string | null; handoff: string | null; recoveredWithoutCode: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const issue = async () => {
    setBusy(true); setError(null); setCopied(false);
    const headers = { ...(bearer ? { Authorization: "Bearer " + bearer } : {}), "Content-Type": "application/json" };
    try {
      const current = await fetch(`/api/deliveries/${executionId}`, { headers, cache: "no-store" }); const data = await current.json();
      if (!current.ok) throw new Error(data.error ?? "The current handoff could not load.");
      const response = await fetch(`/api/deliveries/${executionId}/issue`, { method: "POST", headers, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), expectedRevision: data.revision }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "The handoff code could not be issued.");
      setIssued(payload); onChanged?.();
    } catch (error) { setError(error instanceof Error ? error.message : "The handoff code could not be issued."); }
    finally { setBusy(false); }
  };
  return <><Button busy={busy} onClick={() => void issue()}><QrCode size={15} />Issue delivery code</Button>{error && <p className="payment-error" role="alert">{error}</p>}
    {issued && <Modal title="One console. One signed handoff." onClose={() => setIssued(null)}><div className="delivery-qr-review">
      <Badge tone="blue">CONTROLLED SUPPLIER DELIVERY</Badge><h3>{issued.data.execution.unitId}</h3>
      <p>Plan v{issued.data.execution.planVersion} · handoff v{issued.data.delivery?.version}. The assigned driver scans this code. Priya accepts the condition separately.</p>
      {issued.image ? <img className="delivery-qr" src={issued.image} width={380} height={380} alt="Signed single-use delivery handoff QR code" /> : <p>The original code was issued, but its private value cannot be recovered. Issue a replacement to revoke it.</p>}
      <span className="mono">Expires {issued.data.delivery?.expiresAt ? new Date(issued.data.delivery.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) : "—"} · real time</span>
      <div className="delivery-trust"><ShieldCheck size={18} /><p>This code records a controlled handoff. Scanning it cannot accept condition, capture a fee, or clear a readiness gate.</p></div>
      <div className="modal-actions"><Button disabled={!issued.handoff} onClick={async () => { try { await navigator.clipboard.writeText(issued.handoff!); setCopied(true); } catch { setError("Clipboard access was unavailable. Use the displayed QR code."); } }}><Copy size={14} />{copied ? "Private handoff copied" : "Copy handoff link"}</Button><Button disabled={busy} onClick={() => void issue()}><RefreshCw size={14} />Replace code</Button></div>
    </div></Modal>}
  </>;
}
