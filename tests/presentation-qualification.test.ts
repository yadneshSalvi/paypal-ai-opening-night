import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { QualificationNote } from "../src/components/evaluation/qualification-note";
import annotation from "../public/evaluation/qualification-2026-11-12.json";
import index from "../public/evaluation/index.json";
test("dated observation binds exact immutable run/report/corpus bytes without changing outcomes", async () => {
  const run = index.runs.find(row => row.runId === annotation.binding.runId)!; assert.ok(run); assert.equal(annotation.binding.reportSha256, run.report.sha256); assert.equal(annotation.binding.corpusSha256, run.corpus.sha256);
  for (const ref of [run.report, run.corpus]) { const bytes = await readFile(new URL("../public" + ref.path, import.meta.url)); assert.equal(createHash("sha256").update(bytes).digest("hex"), ref.sha256); }
  assert.equal(annotation.hostedViewer.observedOutcome, "unknown pending evidence"); assert.deepEqual(annotation.hostedViewer.unresolvedCodes, ["DRIVER_UNKNOWN", "CONDITION_UNKNOWN"]); assert.equal(annotation.controlledRecording.durationMs, 12500); assert.equal(annotation.controlledRecording.audio, false); assert.equal(annotation.controlledRecording.earlierFailedTakeRetained, true);
});
test("qualification note renders only beside its exact verified immutable binding", () => {
  const props = { runId: annotation.binding.runId, reportSha256: annotation.binding.reportSha256, corpusSha256: annotation.binding.corpusSha256 }; const html = renderToStaticMarkup(createElement(QualificationNote, props)); assert.match(html, /unknown pending evidence/); assert.match(html, /12.5 seconds/); assert.match(html, /qualification-2026-11-12.json/);
  for (const changed of [{ ...props, runId: "older-run" }, { ...props, reportSha256: "a".repeat(64) }, { ...props, corpusSha256: "b".repeat(64) }]) assert.equal(renderToStaticMarkup(createElement(QualificationNote, changed)), "");
});
test("public qualification metadata contains only credential-free public references and digest bindings", () => {
  const text = JSON.stringify(annotation); assert.doesNotMatch(text, /\/Users\/|\.private\/|\.setup-evidence\/|Bearer |[?&](?:token|key|session)=/i); assert.equal(annotation.hostedViewer.canonicalUrl, "https://paypal-ai-opening-night.vercel.app"); for (const hash of [annotation.localViewer.receiptSha256, annotation.hostedViewer.receiptSha256, annotation.controlledRecording.receiptSha256]) assert.match(hash, /^[a-f0-9]{64}$/);
});
