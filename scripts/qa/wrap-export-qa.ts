/** Complete long-form export fixture; no model or provider transport. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createFixture } from "../../src/domain/fixture";
import { digest } from "../../src/domain/hash";
import { buildWrapReport } from "../../src/domain/wrap/report";
import type { WrapRecord, WrapState } from "../../src/domain/wrap/contracts";
import { renderWrapPdf } from "../../src/server/wrap/pdf";
import { PDFDocument } from "pdf-lib";
const show = createFixture(randomUUID()), records: WrapRecord[] = [], markers: string[] = [];
for (let index = 0; index < 72; index++) {
  const marker = `COMPLETE-SOURCE-${String(index).padStart(3,"0")}-END`, entryId = randomUUID(); markers.push(marker);
  const entry = { entryId, previousId: null, kind: "expense" as const, category: "artist" as const, label: `Élodie’s ensemble · source ${index + 1}`, amountMinor: 10000 + index, currency: "USD" as const, serviceDay: show.showDate, reference: marker, detail: `${marker} · ${"Reviewed original agreement, scope, source and exact cents. ".repeat(24)}${marker} · unsupported script example 演出`, sourceIds: [], reviewedScope: true as const };
  records.push({ id: randomUUID(), commandId: randomUUID(), requestDigest: digest(entry), actorId: "producer:export-controlled", revision: index + 1, productionRevision: index + 2, recordedAt: new Date().toISOString(), kind: "entry", version: 1, previousDigest: null, entry });
}
const state: WrapState = { schemaVersion: 1, revision: records.length, records }, empty = { schemaVersion: 1 as const, revision: 0, records: [] }, report = buildWrapReport(show, empty, empty, state, true), rendered = await renderWrapPdf(report), loaded = await PDFDocument.load(rendered.bytes), out = resolve(".artifacts/wrap-export-qualification"); await mkdir(out, { recursive: true });
assert.equal(loaded.getPageCount(), rendered.pages); assert.ok(rendered.pages >= 20); assert.equal(report.lines.length, 72); assert.ok(rendered.escapedCharacters > 0);
await writeFile(resolve(out,"complete.pdf"), rendered.bytes); await writeFile(resolve(out,"complete.json"), JSON.stringify(report,null,2)); await writeFile(resolve(out,"expected-markers.json"), JSON.stringify(markers));
const result = { lines: report.lines.length, sourceReceipts: report.lines.reduce((sum,line)=>sum+line.evidence.length,0), pages: rendered.pages, escapedCharacters: rendered.escapedCharacters, pdfBytes: rendered.bytes.length, sha256: createHash("sha256").update(rendered.bytes).digest("hex"), definition: report.contentDigest, output: out };
await writeFile(resolve(out,"result.json"),JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
