"use client";
import { useMemo, useState } from "react";
import { Download, FileText, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { sourceLocationLabel, type SourceDocument, type SourceUnit } from "@/domain/sources";
import { productionFetch } from "../production-fetch";
import { Badge, Button, Modal } from "../ui";

function PageRegion({ unit }: { unit: SourceUnit }) {
  if (unit.locator.kind !== "pdf") return null;
  const { width, height, rect, page } = unit.locator;
  return <figure className="source-page-region"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Quoted text region on page ${page}`}><rect x="0" y="0" width={width} height={height} fill="#f0e9dc" /><rect x={Math.max(0, rect[0]!)} y={Math.max(0, rect[1]!)} width={Math.max(2, rect[2]! - rect[0]!)} height={Math.max(2, rect[3]! - rect[1]!)} fill="#ffb00070" stroke="#7d5a18" strokeWidth="2" /></svg><figcaption>Page {page} · text region<br /><span>Position in the original PDF; download the file to inspect its full layout.</span></figcaption></figure>;
}
export function SourceDocumentDialog({ source, focusedUnit, tenantId, busy, onClose, onExtract }: { source: SourceDocument; focusedUnit?: string; tenantId: string; busy: boolean; onClose: () => void; onExtract: (id: string) => void }) {
  const units = source.extraction?.units ?? [], focusIndex = Math.max(0, units.findIndex(unit => unit.id === focusedUnit));
  const [query, setQuery] = useState(""), [page, setPage] = useState(Math.floor(focusIndex / 60)), [downloading, setDownloading] = useState(false), [error, setError] = useState<string | null>(null);
  const matching = useMemo(() => query.trim() ? units.filter(unit => `${unit.text} ${sourceLocationLabel(unit.locator)}`.toLowerCase().includes(query.trim().toLowerCase())) : units, [query, units]);
  const focus = units.find(unit => unit.id === focusedUnit), pageCount = Math.max(1, Math.ceil(matching.length / 60));
  async function download() {
    setDownloading(true); setError(null);
    try {
      const response = await productionFetch(tenantId, `/api/sources?sourceId=${source.id}&download=1`, { cache: "no-store" });
      if (!response.ok) throw new Error((await response.json()).error ?? "The original source could not be read.");
      const objectUrl = URL.createObjectURL(await response.blob()), anchor = document.createElement("a"); anchor.href = objectUrl; anchor.download = source.filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);
    } catch (error) { setError(error instanceof Error ? error.message : "The original source could not be downloaded."); } finally { setDownloading(false); }
  }
  return <Modal title={source.title} onClose={onClose}><div className="source-document-dialog">
    <div className="source-document-top"><Badge tone={source.current ? "blue" : "muted"}>VERSION {source.version}{source.current ? " · CURRENT" : " · RETAINED"}</Badge><span>{source.filename} · {(source.byteLength / 1024).toFixed(1)} KB</span></div>
    <div className="source-rights-record"><ShieldCheck size={18} /><div><strong>{source.rights?.owner ?? "Private content removed"}</strong><p>{source.rights ? `${source.rights.basis.replaceAll("_", " ")} source${source.rights.note ? ` · ${source.rights.note}` : ""}` : "Only the original identity and deletion record remain."}</p></div></div>
    <div className="source-document-actions">{source.state !== "deleted" ? <Button onClick={() => void download()} busy={downloading}><Download size={15} />Download original</Button> : null}{["saved", "parsing", "failed"].includes(source.state) ? <Button busy={busy} onClick={() => onExtract(source.id)}><RefreshCw size={15} />Read original file again</Button> : null}</div>
    {error ? <p className="error-note" role="alert">{error}</p> : null}
    {source.state === "failed" ? <div className="source-notice warning"><strong>Extraction needs attention.</strong><p>The original file is saved. Use a complete, unlocked text PDF or supported UTF-8 text or workbook. A new version can correct the source without replacing its history.</p>{source.failureCode ? <small>{source.failureCode.replaceAll("_", " ").toLowerCase()}</small> : null}</div> : null}
    {source.extraction?.notices.map((notice, index) => <div key={`${notice.code}:${index}`} className={`source-notice ${notice.blocking ? "warning" : ""}`}><strong>{notice.blocking ? "Constraint remains unknown" : "Source note"}</strong><p>{notice.message}</p></div>)}
    {focus ? <section className="source-focused-quote" aria-label="Selected source citation"><span className="eyebrow">EXACT SOURCE LOCATION · {sourceLocationLabel(focus.locator)}</span><blockquote>{focus.text}</blockquote>{focus.caution ? <p>{focus.caution}</p> : null}<PageRegion unit={focus} /></section> : null}
    {source.extraction ? <>
      <label className="source-search"><Search size={16} /><input aria-label="Search extracted source text" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Find a call, person, page or cell…" /></label>
      <div className="source-extraction-heading"><strong>{matching.length} extracted locations</strong><span>Exact text · {source.extraction.pageCount ? `${source.extraction.pageCount} pages` : source.extraction.sheetCount ? `${source.extraction.sheetCount} sheets` : "line references"}</span></div>
      <ol className="source-extraction" aria-label="Extracted source text">{matching.slice(page * 60, (page + 1) * 60).map(unit => <li key={unit.id} className={unit.id === focusedUnit ? "focused" : ""}><span className="source-location">{sourceLocationLabel(unit.locator)}</span><div><p>{unit.text}</p>{unit.caution ? <small>{unit.caution}</small> : null}</div></li>)}</ol>
      {matching.length === 0 ? <p className="source-empty-search">No matching source text.</p> : null}
      {pageCount > 1 ? <div className="source-pagination"><Button disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</Button><span>Page {page + 1} of {pageCount}</span><Button disabled={page + 1 >= pageCount} onClick={() => setPage(value => value + 1)}>Next</Button></div> : null}
    </> : source.state !== "deleted" ? <div className="source-notice"><FileText size={20} /><p>The original file is saved. Its complete extraction is not ready yet.</p></div> : null}
    <details className="source-identity"><summary>Original file identity</summary><p>SHA-256</p><code>{source.contentHash}</code><p>Saved {new Date(source.createdAt).toLocaleString()} · source {source.id}</p>{source.extraction ? <p>{source.extraction.parserVersion}</p> : null}</details>
  </div></Modal>;
}
