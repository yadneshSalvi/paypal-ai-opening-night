"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Copy, RefreshCw } from "lucide-react";
import type { VoiceWorkspace } from "@/domain/voice";
import { productionFetch } from "../production-fetch";
import { Badge, Button } from "../ui";

export function VoiceRecord({ tenantId, refresh }: { tenantId: string; refresh: number }) {
  const [record, setRecord] = useState<VoiceWorkspace | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const region = useRef<HTMLDetailsElement>(null);
  const load = useCallback(async () => {
    setBusy(true);
    try { const response = await productionFetch(tenantId, `/api/intelligence/voice?production=${tenantId}`, { cache: "no-store" }), value = await response.json(); if (!response.ok) throw new Error(value.error ?? "The audio record could not open."); setRecord(value); setError(null); }
    catch (error) { setError(error instanceof Error ? error.message : "The audio record could not open."); }
    finally { setBusy(false); }
  }, [tenantId]);
  useEffect(() => { void load(); }, [load, refresh]);
  useEffect(() => { const stop = () => { if (document.hidden) region.current?.querySelectorAll("audio").forEach(audio => audio.pause()); }; document.addEventListener("visibilitychange", stop); return () => document.removeEventListener("visibilitychange", stop); }, []);
  return <details ref={region} className="voice-record" onToggle={event => { if (!event.currentTarget.open) event.currentTarget.querySelectorAll("audio").forEach(audio => audio.pause()); }}><summary><AudioLines size={16} /><span>Voice & transcripts</span><small>{record?.runs.length ?? 0} saved requests</small></summary>
    <div className="voice-record-intro"><p>Record in the native planning panel, review the editable transcript, then Send. Read-aloud uses an AI-generated voice. Saved audio never grants operational approval.</p><Button disabled={busy} busy={busy} onClick={() => void load()}><RefreshCw size={14} />Refresh audio record</Button></div>
    {error && <p className="error-note" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {record && !record.available && <p className="intelligence-muted">Audio is not connected here. The full text planning flow remains available.</p>}
    {record?.runs.map(run => <article key={run.id} className="voice-record-item"><div><b>{run.kind === "transcribe" ? "Recorded draft" : "AI-generated read-aloud"}</b><Badge tone={run.state === "completed" ? "green" : "amber"}>{run.state.replaceAll("_", " ").toUpperCase()}</Badge></div><p>{run.message}</p>{run.text && <><blockquote>{run.text}</blockquote>{run.kind === "transcribe" && <Button onClick={() => { void navigator.clipboard.writeText(run.text!).then(() => setNotice("Transcript copied. Paste it into the planning draft, edit it, then choose Send."), () => setNotice("Select and copy the transcript above, then paste it into your editable draft.")); }}><Copy size={14} />Copy transcript</Button>}</>}{run.kind === "speak" && run.state === "completed" && <audio controls preload="none" aria-label="Replay saved AI-generated voice" src={`/api/intelligence/voice?production=${tenantId}&runId=${run.id}`} />}<small>{run.provenance === "controlled_fixture" ? "Controlled audio fixture" : "Provider request"} · {run.resolvedModel ?? run.model} · {new Date(run.createdAt).toLocaleString()}{run.durationSeconds ? ` · ${run.durationSeconds.toFixed(1)} seconds` : ""}</small></article>)}
    {record?.runs.length === 0 && <p className="intelligence-muted">Your first recording or read-aloud will appear here. Microphone access starts only from your Record action.</p>}
  </details>;
}
