import { parentPort, workerData } from "node:worker_threads";
import { fromBuffer } from "yauzl";

// Only in-memory file bytes are accepted. No URL, credential or application authority enters this worker.
globalThis.fetch = async () => { throw new Error("Parser network access is disabled"); };
const { format, data, limits } = workerData;
const bytes = Buffer.from(data), units = [], notices = [];
let characters = 0, pageCount = 0, sheetCount = 0;
class ParseIssue extends Error { constructor(code, message) { super(message); this.code = code; } }
const stop = (code, message) => { throw new ParseIssue(code, message); };
function add(text, locator, id, caution = null) {
  if (typeof text !== "string" || !text.trim()) return;
  characters += text.length;
  if (text.length > 12000 || characters > limits.textCharacters || units.length >= limits.units) stop("SOURCE_EXTRACTION_BOUND", "The source contains more text or cells than this bounded review supports. Split it into smaller source documents.");
  units.push({ id, text, locator, caution });
}
function notice(code, message, blocking = false) { if (notices.length < 100 && !notices.some(item => item.code === code && item.message === message)) notices.push({ code, message, blocking }); }
function columnName(value) { let name = ""; for (let n = value; n; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name; }
function textSource() {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); let start = 0;
  for (const [index, raw] of text.split("\n").entries()) {
    const value = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    add(value, { kind: "text", line: index + 1, start, end: start + value.length }, `line:${index + 1}`); start += raw.length + 1;
  }
}
function csvSource() {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), separator = format === "tsv" ? "\t" : ",";
  let row = 1, column = 1, value = "", quoted = false, closed = false;
  const commit = () => { const cell = `${columnName(column)}${row}`; add(value, { kind: "cell", sheet: "Sheet 1", row, column, cell, formula: null }, `sheet:1:${cell}`, /^[=+@]/.test(value) ? "This is literal CSV text; formula-like content has not been executed." : null); value = ""; column++; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (char === '"' && text[i + 1] === '"') { value += '"'; i++; } else if (char === '"') { quoted = false; closed = true; } else value += char; }
    else if (char === separator) commit();
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[i + 1] === "\n") i++; commit(); row++; column = 1; }
    else if (char === '"' && !value && !closed) quoted = true;
    else if (closed || char === '"') stop("SOURCE_CSV_QUOTING", "A CSV quoted cell is malformed. Correct the saved file and upload a new version.");
    else value += char;
    if (row > 10000 || column > 256 || value.length > 12000) stop("SOURCE_SHEET_BOUND", "This spreadsheet exceeds the supported row, column or cell size. Split it before import.");
  }
  if (quoted) stop("SOURCE_CSV_QUOTING", "The CSV ends inside a quoted cell. The original file is retained.");
  if (value || closed) commit(); sheetCount = 1;
}
async function inspectWorkbookArchive() {
  return new Promise((resolve, reject) => fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
    if (error || !zip) return reject(new ParseIssue("SOURCE_XLSX_ARCHIVE", "The XLSX archive could not be read."));
    let count = 0, expected = 0, inflated = 0, settled = false; const names = new Set();
    const fail = error => { if (settled) return; settled = true; zip.close(); reject(error); };
    zip.on("error", () => fail(new ParseIssue("SOURCE_XLSX_ARCHIVE", "The workbook archive is incomplete or inconsistent.")));
    zip.on("entry", entry => {
      count++; expected += entry.uncompressedSize;
      if (count > limits.zipEntries || expected > limits.inflatedBytes || entry.uncompressedSize > limits.inflatedBytes || names.has(entry.fileName) || entry.generalPurposeBitFlag & 1) return fail(new ParseIssue("SOURCE_XLSX_BOUND", "This workbook exceeds the bounded archive contract or contains duplicate/encrypted parts."));
      names.add(entry.fileName);
      if (/(vbaProject|externalLinks|embeddings)\//i.test(entry.fileName) || /vbaProject\.bin$/i.test(entry.fileName)) return fail(new ParseIssue("SOURCE_XLSX_ACTIVE_CONTENT", "Macros, embedded objects and external workbook links are not supported. Export the required values to a plain workbook or CSV."));
      if (/^xl\/media\//.test(entry.fileName)) notice("WORKBOOK_IMAGES", "Workbook images are retained in the original file but are not extracted as constraints. Supply their required facts as text.", true);
      if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) return fail(new ParseIssue("SOURCE_XLSX_ARCHIVE", "A workbook part could not be read."));
        const pieces = []; let actual = 0;
        stream.on("data", chunk => { actual += chunk.length; inflated += chunk.length; if (actual > entry.uncompressedSize || inflated > limits.inflatedBytes) { stream.destroy(); fail(new ParseIssue("SOURCE_XLSX_BOUND", "This workbook expands beyond its declared size.")); } else if (/\.xml$/.test(entry.fileName)) pieces.push(chunk); });
        stream.once("error", () => fail(new ParseIssue("SOURCE_XLSX_ARCHIVE", "A workbook part has inconsistent compressed content.")));
        stream.once("end", () => {
          if (settled) return;
          const xml = pieces.length ? Buffer.concat(pieces).toString("utf8") : "";
          if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return fail(new ParseIssue("SOURCE_XLSX_ENTITIES", "Workbook XML entities are not accepted."));
          if (/^xl\/worksheets\//.test(entry.fileName)) for (const match of xml.matchAll(/<c\b[^>]*\br="([A-Z]+)(\d+)"/g)) {
            let column = 0; for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
            if (Number(match[2]) > 10000 || column > 256) return fail(new ParseIssue("SOURCE_SHEET_BOUND", "The workbook contains cells beyond the supported 10,000 rows or 256 columns."));
          }
          zip.readEntry();
        });
      });
    });
    zip.once("end", () => { if (!settled) { settled = true; resolve(); } }); zip.readEntry();
  }));
}
function cellText(value) {
  if (value == null) return { text: "", formula: null, caution: null };
  if (value instanceof Date) return { text: value.toISOString().replace("T", " ").replace(/\.000Z$/, "") + " (spreadsheet date; time zone unspecified)", formula: null, caution: "Spreadsheet dates do not declare a time zone. Review a source that states the intended zone before using this value as an instant." };
  if (typeof value !== "object") return { text: String(value), formula: null, caution: null };
  if ("formula" in value || "sharedFormula" in value) return { text: `Formula: =${value.formula ?? `[shared ${value.sharedFormula}]`}\nUnverified cached value: ${value.result == null ? "missing" : cellText(value.result).text}`, formula: value.formula ?? `shared:${value.sharedFormula}`, caution: "Formula results are cached source data, not independently calculated values. Replace the formula with a verified value source before using it as a constraint." };
  if ("richText" in value) return { text: value.richText.map(part => part.text).join(""), formula: null, caution: null };
  if ("hyperlink" in value) return { text: String(value.text ?? ""), formula: null, caution: "The hyperlink target was not opened or treated as evidence." };
  if ("error" in value) return { text: String(value.error), formula: null, caution: "This source cell contains a spreadsheet error." };
  return { text: JSON.stringify(value), formula: null, caution: "This spreadsheet cell type needs manual verification." };
}
async function workbookSource() {
  await inspectWorkbookArchive();
  const { default: ExcelJS } = await import("exceljs"); const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes, { ignoreNodes: ["drawing", "legacyDrawing", "extLst", "conditionalFormatting", "dataValidations", "picture"] });
  if (workbook.worksheets.length > limits.sheets) stop("SOURCE_SHEET_BOUND", "The workbook has more than 12 sheets. Split it into smaller source documents.");
  sheetCount = workbook.worksheets.length;
  workbook.eachSheet((sheet, index) => {
    if (sheet.state !== "visible") notice("HIDDEN_SHEET", `The extracted sheet “${sheet.name}” is hidden in the source workbook.`, false);
    sheet.eachRow({ includeEmpty: false }, row => row.eachCell({ includeEmpty: false }, cell => {
      const value = cellText(cell.value);
      add(value.text, { kind: "cell", sheet: sheet.name, row: row.number, column: cell.col, cell: cell.address, formula: value.formula }, `sheet:${index}:${cell.address}`, value.caution);
    }));
  });
}
async function pdfSource() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useWorkerFetch: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: true, verbosity: 0 });
  try {
    const pdf = await task.promise; pageCount = pdf.numPages;
    if (pageCount > limits.pages) stop("SOURCE_PDF_PAGES", "The PDF has more than 32 pages. Split it before extracting constraints.");
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber), viewport = page.getViewport({ scale: 1 }), content = await page.getTextContent({ disableNormalization: true });
      let line = [], lineNumber = 0;
      const flush = () => {
        if (!line.length) return;
        const text = line.map(item => item.str).join(" "), rects = line.map(item => [...viewport.convertToViewportPoint(item.transform[4], item.transform[5]), ...viewport.convertToViewportPoint(item.transform[4] + item.width, item.transform[5] + item.height)]);
        const xs = rects.flatMap(rect => [rect[0], rect[2]]), ys = rects.flatMap(rect => [rect[1], rect[3]]);
        add(text, { kind: "pdf", page: pageNumber, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], width: viewport.width, height: viewport.height }, `page:${pageNumber}:line:${++lineNumber}`); line = [];
      };
      for (const item of content.items) {
        if (typeof item.str !== "string" || !item.transform) continue;
        if (line.length && Math.abs(line.at(-1).transform[5] - item.transform[5]) > 3) flush();
        line.push(item); if (item.hasEOL || line.length >= 80) flush();
      }
      flush();
      if (!lineNumber) notice("PDF_NO_TEXT", `Page ${pageNumber} contains no extractable text. Its image or layout is not treated as a verified requirement. Supply a text transcription.`, true);
      page.cleanup();
    }
  } finally { await task.destroy(); }
}
try {
  if (bytes.length > limits.bytes) stop("SOURCE_SIZE", "This source exceeds 4 MB.");
  if (format === "pdf") await pdfSource(); else if (format === "xlsx") await workbookSource(); else if (format === "csv" || format === "tsv") csvSource(); else textSource();
  if (!units.length) notice("SOURCE_EMPTY", "No source text was extracted. The original file remains available for review.", true);
  parentPort.postMessage({ ok: true, extraction: { parserVersion: "opening-source-v1/pdfjs-6.5.438/exceljs-4.4.0", units, notices, pageCount, sheetCount } });
} catch (error) {
  parentPort.postMessage({ ok: false, code: error instanceof ParseIssue ? error.code : "SOURCE_PARSE_FAILED", message: error instanceof ParseIssue ? error.message : "The source could not be parsed as a complete supported document. Its original file is retained; supply an unlocked, valid text PDF or supported spreadsheet." });
}
