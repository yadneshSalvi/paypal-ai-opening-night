import { Worker } from "node:worker_threads";
import path from "node:path";
import { sourceExtractionSchema, sourceLimits, type SourceExtraction } from "@/domain/sources";
import { DomainError } from "@/domain/contracts";

export function sourceFormat(filename: string, bytes: Buffer) {
  if (!bytes.length || bytes.length > sourceLimits.bytes) throw new DomainError("SOURCE_SIZE", "Choose a source file between 1 byte and 4 MB.", 413);
  const extension = filename.toLowerCase().split(".").at(-1);
  if (extension === "pdf" && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return { format: "pdf" as const, kind: "pdf" as const, mediaType: "application/pdf" };
  if (extension === "xlsx" && bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) return { format: "xlsx" as const, kind: "spreadsheet" as const, mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  if (["txt", "md", "csv", "tsv"].includes(extension ?? "")) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new DomainError("SOURCE_ENCODING", "Save text and CSV sources as UTF-8 before uploading.", 415); }
    return { format: extension as "txt" | "md" | "csv" | "tsv", kind: ["csv", "tsv"].includes(extension!) ? "spreadsheet" as const : "text" as const, mediaType: extension === "csv" ? "text/csv" : extension === "tsv" ? "text/tab-separated-values" : "text/plain" };
  }
  throw new DomainError("SOURCE_FORMAT", "Supported sources are UTF-8 text, Markdown, CSV, TSV, text PDFs and XLSX workbooks. This file does not match one of those containers.", 415);
}
/** Parsers run without application secrets, with a separate heap and a hard wall-clock bound. */
export async function parseSource(filename: string, bytes: Buffer): Promise<SourceExtraction> {
  const { format } = sourceFormat(filename, bytes), data = new Uint8Array(bytes);
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(process.cwd(), "src/server/sources/parser-worker.mjs"), { workerData: { format, data, limits: sourceLimits }, transferList: [data.buffer], env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 24 } });
    let settled = false;
    const finish = (error?: Error, value?: SourceExtraction) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); error ? reject(error) : resolve(value!); };
    const timer = setTimeout(() => finish(new DomainError("SOURCE_PARSE_TIMEOUT", "This source exceeded the bounded parser. Its original file is retained for review.", 422)), 30000);
    worker.once("message", message => {
      if (!message?.ok) { finish(new DomainError(typeof message?.code === "string" && /^[A-Z_]{1,100}$/.test(message.code) ? message.code : "SOURCE_PARSE_FAILED", typeof message?.message === "string" ? message.message.slice(0, 800) : "The saved source could not be extracted. Its original file is retained.", 422)); return; }
      const parsed = sourceExtractionSchema.safeParse(message.extraction);
      if (!parsed.success || parsed.data.units.reduce((count, unit) => count + unit.text.length, 0) > sourceLimits.textCharacters) finish(new DomainError("SOURCE_EXTRACTION_BOUND", "The extracted source exceeds its review bounds. Its original file is retained.", 422));
      else finish(undefined, parsed.data);
    });
    worker.once("error", () => finish(new DomainError("SOURCE_PARSER_STOPPED", "The bounded source parser stopped. Its original file is retained; no graph was applied.", 422)));
    worker.once("exit", code => { if (!settled) finish(new DomainError("SOURCE_PARSER_EXIT", `The source parser ended before a complete extraction (${code}). Its original file is retained.`, 422)); });
  });
}
