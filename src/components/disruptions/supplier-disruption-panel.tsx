"use client";
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { DisruptionWorkspace } from "@/server/disruptions/contracts";
import { Button } from "../ui";
import { SupplierReports } from "./supplier-reports";
import { ReportDialog } from "./report-dialog";
import { DisruptionStatus } from "./shared";
import { useDisruptions } from "./use-disruptions";

export function SupplierDisruptionPanel({ bearer, onSaved, onBlockedChange, reservationBusy = false }: { bearer: string; onSaved: () => void | Promise<void>; onBlockedChange: (blocked: boolean) => void; reservationBusy?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null), opener = useRef<HTMLElement | null>(null), [offer, setOffer] = useState<DisruptionWorkspace["offers"][number] | null>(null);
  const client = useDisruptions({ bearer, onSaved, fallback: () => heading.current });
  const reportingClient = { ...client, blocked: client.blocked || reservationBusy };
  useEffect(() => { onBlockedChange(client.blocked); }, [client.blocked, onBlockedChange]);
  useEffect(() => { if (client.ended) setOffer(null); }, [client.ended]);
  const fallback = () => opener.current?.isConnected && !opener.current.matches(":disabled") ? opener.current : heading.current;
  return <section className="disruption-supplier-portal"><div className="disruption-section-heading"><div><span className="eyebrow">WHEN THE RESERVATION CHANGES</span><h2 ref={heading} tabIndex={-1}>Keep the promise current.</h2><p>Record a delay, an unavailable unit, or your own new availability against the exact enrolled offer.</p></div><Button ariaLabel="Refresh your supplier availability reports" disabled={Boolean(client.busy || client.ended)} busy={client.busy === "refresh"} onClick={event => void client.refresh(event.currentTarget)}><RefreshCw size={15} /></Button></div><DisruptionStatus client={client} />{client.data?.access === "supplier" ? <SupplierReports workspace={client.data} client={reportingClient} report={value => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; client.beginReview(); setOffer(value); }} /> : client.busy ? <p role="status">Reading only your enrolled availability…</p> : !client.ended ? <p className="disruption-inline-error" role="alert">The supplier reporting scope could not be verified. Reopen the private supplier link.</p> : null}{client.data?.access === "supplier" && offer ? <ReportDialog key={`${offer.id}:${client.data.revision}`} offer={offer} client={reportingClient} close={() => setOffer(null)} fallback={fallback} /> : null}</section>;
}
