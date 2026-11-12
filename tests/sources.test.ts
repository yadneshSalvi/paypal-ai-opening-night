import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { parseSource, sourceFormat } from "../src/server/sources/parser";
import { validateSourceGraph } from "../src/server/sources/validation";
import { sourceCompilerRequest, graphFromResponse, retainedSourceContractVersion, sourceProvider } from "../src/server/sources/compiler";
import { legacyCompiledGraphSchema, sourceCompilerContract, sourceLimits } from "../src/domain/sources";
import { sourceBaselineRetention } from "../src/server/sources/retention";
import { base, evidence } from "./helpers";
import { sourceFixture } from "./source-fixture";

const code = (expected: string) => (error: unknown) => { assert.equal((error as { code?: string }).code, expected); return true; };
function pdf(lines: string[], pages = 1) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let page = 0; page < pages; page++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + page * 2} 0 R >>`);
    const content = page ? "" : `BT /F1 12 Tf 50 740 Td ${lines.map((line, index) => `${index ? "0 -18 Td " : ""}(${line.replace(/[()\\]/g, value => "\\" + value)}) Tj`).join("\n")} ET`;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let body = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(body); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(value => String(value).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}
test("text and quoted CSV extraction preserve exact line and cell locations without executing formula-like text", async () => {
  const text = await parseSource("rider.txt", Buffer.from("Cue one\r\n\r\nVenue: Alder Hall\n"));
  assert.deepEqual(text.units.map(unit => [unit.text, unit.locator]), [["Cue one", { kind: "text", line: 1, start: 0, end: 7 }], ["Venue: Alder Hall", { kind: "text", line: 3, start: 11, end: 28 }]]);
  const csv = await parseSource("calls.csv", Buffer.from('Name,Notes\n"Priya, Shah","First line\nsecond ""quoted"" line"\n=fetch(secret),literal\n'));
  assert.equal(csv.units[2]!.text, "Priya, Shah"); assert.equal(csv.units[3]!.text, 'First line\nsecond "quoted" line');
  assert.equal(csv.units[3]!.locator.kind, "cell"); assert.match(csv.units[4]!.caution!, /not been executed/);
  await assert.rejects(parseSource("bad.csv", Buffer.from('one,"unterminated')), code("SOURCE_CSV_QUOTING"));
});
test("actual XLSX parsing retains hidden cells, formula cautions, dates and exact worksheet addresses", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("Crew calls"), hidden = book.addWorksheet("Reference", { state: "hidden" });
  sheet.getCell("B2").value = "Priya Shah"; sheet.getCell("C2").value = 3500; sheet.getCell("D2").value = { formula: "C2*2", result: 7000 }; sheet.getCell("E2").value = new Date("2026-11-14T16:40:00Z"); hidden.getCell("A1").value = "Unverified reference";
  const extraction = await parseSource("crew.xlsx", Buffer.from(await book.xlsx.writeBuffer()));
  assert.equal(extraction.sheetCount, 2); assert.ok(extraction.notices.some(item => item.code === "HIDDEN_SHEET"));
  assert.equal(extraction.units.find(unit => unit.text === "Priya Shah")?.locator.kind, "cell");
  assert.ok(extraction.units.find(unit => unit.text.includes("7000"))?.caution?.includes("not independently"));
  assert.ok(extraction.units.find(unit => unit.text.includes("spreadsheet date"))?.caution?.includes("time zone"));
  assert.deepEqual(extraction.units[0]!.locator, { kind: "cell", sheet: "Crew calls", row: 2, column: 2, cell: "B2", formula: null });
});
test("actual PDF parser retains page regions and exposes unreadable pages instead of inventing facts", async () => {
  const extraction = await parseSource("venue.pdf", pdf(["Alder Hall", "Hard curfew 23:00"], 2));
  assert.equal(extraction.pageCount, 2); assert.ok(extraction.units.some(unit => unit.text.includes("Hard curfew")));
  const location = extraction.units[0]!.locator; assert.equal(location.kind, "pdf");
  if (location.kind === "pdf") { assert.equal(location.page, 1); assert.equal(location.width, 612); assert.equal(location.rect.length, 4); assert.ok(location.rect[2]! > location.rect[0]!); }
  assert.ok(extraction.notices.some(item => item.code === "PDF_NO_TEXT" && item.blocking && item.message.includes("2")));
  await assert.rejects(parseSource("too-many-pages.pdf", pdf(["Text"], 33)), code("SOURCE_PDF_PAGES"));
});
test("bounded parsers reject masquerading binaries, invalid text and oversized source material", async () => {
  assert.throws(() => sourceFormat("rider.pdf", Buffer.from("not a PDF")), code("SOURCE_FORMAT"));
  assert.throws(() => sourceFormat("rider.txt", Buffer.from([0xff, 0xfe])), code("SOURCE_ENCODING"));
  assert.throws(() => sourceFormat("rider.txt", Buffer.alloc(sourceLimits.bytes + 1)), code("SOURCE_SIZE"));
  await assert.rejects(parseSource("large.txt", Buffer.from("A".repeat(12001))), code("SOURCE_EXTRACTION_BOUND"));
  const book = new ExcelJS.Workbook(); book.addWorksheet("Far away").getCell("A10001").value = "Outside bounded spreadsheet";
  await assert.rejects(parseSource("sparse.xlsx", Buffer.from(await book.xlsx.writeBuffer())), code("SOURCE_SHEET_BOUND"));
});
test("a sourced call passes real Bryntum validation without changing canonical calls or published baseline", async () => {
  const { show } = base(), { source, graph } = sourceFixture(show), before = JSON.stringify(show);
  const review = await validateSourceGraph(show, graph, [source], randomUUID());
  assert.equal(review.canApply, true, JSON.stringify(review.issues)); assert.equal(review.engine?.status, "passed"); assert.equal(review.engine?.dates.length, show.tasks.length + 1);
  assert.equal(review.patch.importedTaskIds.length, 1); assert.equal(review.assumptions.length, 0); assert.ok(review.citations.length > 20 && review.citations.every(item => item.valid));
  assert.deepEqual(review.baselineRetention, { ...sourceBaselineRetention(show), matches: true });
  assert.equal(JSON.stringify(show), before); assert.deepEqual(review.patch.tasks.filter(task => !review.patch.importedTaskIds.includes(task.id)), show.tasks);
});
test("foreign citations, unsupported facts and conflicting sources cannot yield applicable graphs", async () => {
  const { show } = base(), fixture = sourceFixture(show);
  fixture.graph.tasks[0]!.name.citations[0]!.quote = "This quotation never appeared";
  fixture.graph.tasks[0]!.durationMinutes.citations = [];
  fixture.graph.conflicts.push({ field: "policy.curfewAt", message: "Sources give two different curfews.", citations: [fixture.fact("", 4).citations[0]!] });
  const review = await validateSourceGraph(show, fixture.graph, [fixture.source], randomUUID());
  assert.equal(review.canApply, false); for (const code of ["CITATION_NOT_IN_SOURCE", "UNSUPPORTED_FACT", "SOURCE_CONFLICT"]) assert.ok(review.issues.some(item => item.code === code), code);
});
test("roster qualification, resource exclusivity, source windows, hard policy and production identity remain strict", async () => {
  const { show } = base(), fixture = sourceFixture(show), graph = fixture.graph;
  graph.resources[0]!.targetId = "tom"; graph.resources[0]!.name.value = "Tom Chen"; graph.resources[0]!.skills.value = ["lx_focus", "electrical"];
  graph.tasks[0]!.start.value = "2026-11-14T15:45:00-06:00"; graph.policy.minimumRestMinutes.value = 100; graph.production.venue.value = "An unrelated hall";
  const review = await validateSourceGraph(show, graph, [fixture.source], randomUUID());
  for (const code of ["QUALIFICATION", "RESOURCE_OVERLAP", "EARLIEST_START", "HARD_POLICY_RELAXED", "DIFFERENT_PRODUCTION"]) assert.ok(review.issues.some(item => item.code === code), code);
  assert.equal(review.canApply, false);
});
test("assumptions have stable exact identities; new roster admissions and actual history stay uncommitted", async () => {
  const { show } = base(), fixture = sourceFixture(show); fixture.graph.tasks[0]!.amplified = { value: false, citations: [], assumption: "The paperwork review uses no amplified audio." };
  let review = await validateSourceGraph(show, fixture.graph, [fixture.source], randomUUID()); assert.equal(review.canApply, true); assert.equal(review.assumptions.length, 1); assert.match(review.assumptions[0]!.id, /^assumption:task\.paperwork\.amplified:/);
  const repeated = await validateSourceGraph(show, fixture.graph, [fixture.source], randomUUID()); assert.deepEqual(repeated.assumptions, review.assumptions);
  fixture.graph.resources[0]!.targetId = null; show.financialEvidence.push(evidence(show)); review = await validateSourceGraph(show, fixture.graph, [fixture.source], randomUUID());
  assert.equal(review.canApply, false); assert.ok(review.issues.some(item => item.code === "ROSTER_ADMISSION_REQUIRED")); assert.ok(review.issues.some(item => item.code === "OPERATIONAL_HISTORY_EXISTS"));
});
test("source provider contract has no tools and rejects a document-induced tool call or malformed output", () => {
  const { show, actor } = base(), { source } = sourceFixture(show), request = sourceCompilerRequest(randomUUID(), show, [source], actor.id);
  assert.deepEqual(request.tools, []); assert.equal(request.tool_choice, "none"); assert.equal(request.background, true); assert.equal(request.store, false); assert.deepEqual(request.reasoning, { effort: "max" });
  assert.throws(() => graphFromResponse({ status: "completed", output: [{ type: "function_call" }] }), /AUTHORITY/);
  assert.throws(() => graphFromResponse({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "refusal" }] }] }), /SHAPE/);
  assert.equal(sourceProvider().configured, false); assert.throws(() => sourceProvider().fetch("https://api.openai.com/v1/responses"), /disabled/);
});
test("v2 explicitly retains the exact baseline without presenting it as uploaded evidence", () => {
  const { show, actor } = base(), { source } = sourceFixture(show), request = sourceCompilerRequest(randomUUID(), show, [source], actor.id);
  const input = JSON.parse((request.input as { content: { text: string }[] }[])[0]!.content[0]!.text);
  assert.deepEqual(input.compilationContract, { name: sourceCompilerContract, baselineRetention: sourceBaselineRetention(show) });
  assert.equal(retainedSourceContractVersion(request), 2);
  assert.equal((request.metadata as Record<string, string>).compiler_contract, sourceCompilerContract);
  const format = (request.text as { format: { name: string; schema: { properties: Record<string, unknown>; required: string[] } } }).format;
  assert.equal(format.name, sourceCompilerContract); assert.ok(format.schema.required.includes("baselineRetention"));
  assert.match(String(request.instructions), /new shift\/pay rule/); assert.match(String(request.instructions), /must still be a blocking unsupported requirement/);
});
test("changed maximum-shift settings, cohort settings or base identities are held without rewriting the baseline", async () => {
  const { show } = base(), before = JSON.stringify(show), fixture = sourceFixture(show);
  for (const change of [
    { baseRevision: show.revision + 1 }, { baseDigest: "f".repeat(64) },
    ...["maxShiftMinutes", "refundCount", "criticalCrewCount"].map(field => ({ policy: { ...fixture.graph.baselineRetention.policy, [field]: 1 } })),
  ]) {
    const graph = structuredClone(fixture.graph); Object.assign(graph.baselineRetention, change);
    const review = await validateSourceGraph(show, graph, [fixture.source], randomUUID());
    assert.equal(review.canApply, false); assert.equal(review.baselineRetention?.matches, false);
    assert.ok(review.issues.some(item => item.code === "BASELINE_RETENTION_CHANGED" && item.blocking));
    assert.deepEqual(review.baselineRetention?.policy, sourceBaselineRetention(show).policy);
  }
  assert.equal(JSON.stringify(show), before);
});
test("v1 holds remain exact and v2 retention never suppresses an unsupported requirement", async () => {
  const { show } = base(), fixture = sourceFixture(show), { baselineRetention: _retained, ...shared } = fixture.graph;
  const message = "Assumption from selected-production reference data: retain the existing 720-minute maximum-shift limit unchanged. This schema has no maxShiftMinutes policy field.";
  const legacy = legacyCompiledGraphSchema.parse({ ...shared, schemaVersion: 1, unsupportedRequirements: [{ message, citations: [] }] });
  const old = await validateSourceGraph(show, legacy, [fixture.source], randomUUID());
  assert.equal(old.canApply, false); assert.equal(old.baselineRetention, undefined); assert.deepEqual(old.graph.unsupportedRequirements, legacy.unsupportedRequirements);
  assert.ok(old.issues.some(item => item.code === "SOURCE_UNSUPPORTED_REQUIREMENT" && item.message === message && item.blocking));
  fixture.graph.unsupportedRequirements.push({ message: "A source requires a new maximum-shift or pay rule that this planning contract cannot apply.", citations: fixture.fact(null, 4).citations });
  const current = await validateSourceGraph(show, fixture.graph, [fixture.source], randomUUID());
  assert.equal(current.baselineRetention?.matches, true); assert.equal(current.canApply, false);
  assert.ok(current.issues.some(item => item.code === "SOURCE_UNSUPPORTED_REQUIREMENT" && item.blocking));
  fixture.graph.unsupportedRequirements = [{ message, citations: [] }];
  assert.equal((await validateSourceGraph(show, fixture.graph, [fixture.source], randomUUID())).canApply, false);
});
test("an output can only satisfy its originally requested graph version", () => {
  const { show } = base(), { graph } = sourceFixture(show), { baselineRetention: _retained, ...shared } = graph;
  const legacy = { ...shared, schemaVersion: 1 };
  const response = (value: unknown) => ({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
  assert.equal(graphFromResponse(response(graph), 2).schemaVersion, 2); assert.equal(graphFromResponse(response(legacy), 1).schemaVersion, 1);
  assert.throws(() => graphFromResponse(response(legacy), 2), /COMPILER_OUTPUT_VERSION/);
  assert.throws(() => graphFromResponse(response(graph), 1), /COMPILER_OUTPUT_VERSION/);
  assert.throws(() => retainedSourceContractVersion({}), /COMPILER_REQUEST_VERSION/);
});
