import annotation from "../../../public/evaluation/qualification-2026-11-12.json";

/** Additive later observation, shown only beside its exact verified report/corpus. */
export function QualificationNote({ runId, reportSha256, corpusSha256 }: { runId: string; reportSha256: string; corpusSha256: string }) {
  if (runId !== annotation.binding.runId || reportSha256 !== annotation.binding.reportSha256 || corpusSha256 !== annotation.binding.corpusSha256) return null;
  return <aside aria-label="Dated later viewer qualification" style={{ border: "1px solid #756344", borderLeft: "3px solid #d6ad69", borderRadius: 5, padding: "clamp(16px,3vw,25px)", margin: "20px 0", background: "#b9873008", fontSize: 14, lineHeight: 1.7, minWidth: 0 }}>
    <span style={{ color: "#d8b57b", fontSize: 11, letterSpacing: "1.3px" }}>LATER OBSERVATION / 12 NOVEMBER 2026</span>
    <h2 style={{ fontSize: 22, margin: "8px 0 12px", lineHeight: 1.3 }}>The viewer was checked after this report froze.</h2>
    <p style={{ color: "#c3b9b1" }}>The later local viewer review and the promoted canonical S05 view were accepted. This dated note preserves the original report, its earlier pending gate and every declared expectation.</p>
    <ul style={{ paddingLeft: 22, color: "#d2c7b8", margin: "14px 0" }}><li>Local read and hash recovery: <time dateTime={annotation.localViewer.observedAt}>{new Date(annotation.localViewer.observedAt).toISOString()}</time>.</li><li>Hosted S05: <strong>unknown pending evidence</strong>. Qualified driver and console condition remain unresolved.</li><li>Accepted source-view capture: {annotation.controlledRecording.durationMs / 1000} seconds, without audio. It records the saved viewer.</li></ul>
    <p style={{ color: "#bfb4ac" }}>These observations qualify viewer behavior. Model quality, human planning, provider outcomes and physical execution retain their separate evidence requirements.</p>
    <details><summary style={{ minHeight: 44, padding: "10px 0", cursor: "pointer", color: "#e2bf88" }}>Exact source, run and observation bindings</summary><dl style={{ display: "grid", gap: 12, margin: "8px 0", fontSize: 12, overflowWrap: "anywhere" }}>{[
      ["Immutable run", annotation.binding.runId], ["Report SHA-256", annotation.binding.reportSha256], ["Corpus SHA-256", annotation.binding.corpusSha256], ["Local viewer source", annotation.localViewer.viewerSource], ["Local observation receipt", annotation.localViewer.receiptSha256], ["Hosted source", annotation.hostedViewer.deployedSource], ["Deployment", annotation.hostedViewer.deploymentId], ["Hosted observation receipt", annotation.hostedViewer.receiptSha256], ["Accepted capture receipt", annotation.controlledRecording.receiptSha256],
    ].map(([label, value]) => <div key={label}><dt style={{ color: "#bfa47b" }}>{label}</dt><dd style={{ margin: "4px 0 0", fontFamily: "var(--font-mono),monospace" }}>{value}</dd></div>)}</dl><a href="/evaluation/qualification-2026-11-12.json" download style={{ display: "inline-flex", alignItems: "center", minHeight: 44, textDecoration: "underline", color: "#e2bf88" }}>Read the dated qualification artifact</a></details>
  </aside>;
}
