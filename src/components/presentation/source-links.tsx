"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CompilationView } from "@/domain/sources";
import { productionFetch } from "../production-fetch";

/** Existing immutable source GETs only. Never dispatches extraction, compilation, approval or a model. */
export function CompiledSourceLinks({ tenantId, compilationId }: { tenantId: string; compilationId: string }) {
  const identity = tenantId + ":" + compilationId, current = useRef(identity); current.current = identity;
  const [state, setState] = useState<{ identity: string; value: CompilationView | null; error: string | null }>({ identity, value: null, error: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setState({ identity, value: null, error: null });
    if (!/^[a-f0-9-]{36}$/.test(compilationId)) { setState({ identity, value: null, error: "The saved compilation reference is not a readable exact identity." }); return; }
    void productionFetch(tenantId, "/api/sources/compile?compilationId=" + encodeURIComponent(compilationId), { cache: "no-store", signal: controller.signal }).then(async response => {
      const value = await response.json(); if (controller.signal.aborted || current.current !== identity) return;
      if (!response.ok) throw new Error(value.error ?? "The retained source citations could not open.");
      if (value.id !== compilationId || !Array.isArray(value.sourceBindings) || value.sourceBindings.length > 8 || value.sourceBindings.some((row: { id: string; hash: string }) => !/^[a-f0-9-]{36}$/.test(row.id) || !/^[a-f0-9]{64}$/.test(row.hash))) throw new Error("This source response does not match the exact retained compilation.");
      setState({ identity, value, error: null });
    }).catch(error => { if (!controller.signal.aborted && current.current === identity) setState({ identity, value: null, error: error instanceof Error ? error.message : "The retained source read did not complete." }); });
    return () => controller.abort();
  }, [tenantId, compilationId, identity, retry]);
  if (state.identity !== identity || !state.value && !state.error) return <section role="status"><h3>Original source citations</h3><p>Reading the exact saved compilation…</p></section>;
  if (state.error) return <section><h3>Original source citations</h3><p className="presentation-warning" role="alert">{state.error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry saved citation read</button></section>;
  const value = state.value!, citations = value.review?.citations ?? [], known = new Set(value.sourceBindings.map(row => row.id));
  return <section className="presentation-source-citations"><h3>Retained compilation citations</h3><p>{value.appliedAt ? "Reviewed graph applied" : "Proposal, not applied"} · {value.provenance === "controlled_fixture" ? "Controlled model response" : "Retained model output"} · source edition remains immutable.</p><code>{value.digest ?? "No completed compilation digest"}</code>{citations.filter(row => row.valid && known.has(row.citation.sourceId)).map((row, index) => <article key={index}><strong>{row.title}</strong><small>{row.field}</small><blockquote>{row.citation.quote}</blockquote><Link href={"/sources?document=" + encodeURIComponent(row.citation.sourceId) + "&unit=" + encodeURIComponent(row.citation.unitId)}>Open exact original source location</Link></article>)}{!citations.length && <p>No validated source locations are available in this saved result.</p>}{value.sourceBindings.map(binding => <details key={binding.id}><summary>Original file version {binding.version} · content hash</summary><code>{binding.hash}</code><Link href={"/sources?document=" + encodeURIComponent(binding.id)}>Inspect retained file version</Link></details>)}</section>;
}
