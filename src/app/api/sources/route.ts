import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningError, planningJson } from "@/server/intelligence/http";
import { requirePlanningAuthority, withPlanningTransaction } from "@/server/intelligence/ledger";
import { sourceUploadBody } from "@/server/sources/http";
import { findSourceRequest, readSource, readSourceFile, uploadSource } from "@/server/sources/store";
import { sourceWorkspace } from "@/server/sources/compiler";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const authority = await planningAuthority(request);
    await withPlanningTransaction(db => requirePlanningAuthority(db, authority));
    const input = await sourceUploadBody(request);
    return planningJson(await uploadSource(authority, input.command, input.filename, input.bytes));
  } catch (error) { return planningError(error); }
}
export async function GET(request: Request) {
  try {
    const authority = await planningAuthority(request), selector = z.strictObject({ sourceId: z.uuid().optional(), requestId: z.uuid().optional(), download: z.literal("1").optional() }).safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!selector.success || selector.data.download && !selector.data.sourceId || selector.data.sourceId && selector.data.requestId) throw new DomainError("SOURCE_SELECTOR", "Choose one saved source identity.", 400);
    if (selector.data.requestId) return planningJson(await findSourceRequest(authority, selector.data.requestId));
    if (selector.data.sourceId && selector.data.download) {
      const { source, bytes } = await readSourceFile(authority, selector.data.sourceId);
      return new Response(new Uint8Array(bytes), { headers: { "Content-Type": source.mediaType, "Content-Disposition": `attachment; filename="source-${source.id}.${source.filename.split(".").at(-1)?.replace(/[^a-z0-9]/gi, "") || "bin"}"; filename*=UTF-8''${encodeURIComponent(source.filename)}`, "Content-Length": String(bytes.length), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Source-SHA256": source.contentHash, "Content-Security-Policy": "sandbox" } });
    }
    return planningJson(selector.data.sourceId ? await readSource(authority, selector.data.sourceId) : await sourceWorkspace(authority));
  } catch (error) { return planningError(error); }
}
