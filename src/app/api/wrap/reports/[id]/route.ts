import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { wrapAuthority, wrapError, wrapJson } from "@/server/wrap/http";
import { readSealedReport } from "@/server/wrap/reports";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = z.uuid().parse((await context.params).id), query = new URL(request.url).searchParams, format = z.enum(["pdf", "json", "definition"]).parse(query.get("format") ?? "definition");
    if ([...query.keys()].some(key => key !== "format")) throw new DomainError("WRAP_EXPORT_SCOPE", "An edition is exported in its complete original scope.", 400);
    const value = await readSealedReport(await wrapAuthority(request, "production"), id, format);
    if (format === "definition") return wrapJson({ report: value.report, pages: value.pages, hash: value.hash });
    return new Response(new Uint8Array(value.bytes!), { headers: { "Content-Type": format === "pdf" ? "application/pdf" : "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="opening-night-wrap-${value.edition}.${format}"`, "Cache-Control": "private, no-store", "Vary": "Authorization, Cookie", "X-Content-Type-Options": "nosniff", "X-Content-SHA256": value.hash, "X-Report-SHA256": value.report.contentDigest, "Content-Length": String(value.bytes!.byteLength) } });
  } catch (error) { return wrapError(error); }
}
