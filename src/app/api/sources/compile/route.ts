import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { compileSourceSchema } from "@/domain/sources";
import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningDispatchAuthority, planningBody, planningError, planningJson } from "@/server/intelligence/http";
import { findCompilationRequest, readSourceCompilation, startSourceCompilation } from "@/server/sources/compiler";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try { assertSameOrigin(request); return planningJson(await startSourceCompilation(await planningDispatchAuthority(request), await planningBody(request, compileSourceSchema))); }
  catch (error) { return planningError(error); }
}
export async function GET(request: Request) {
  try {
    const authority = await planningAuthority(request), selector = z.strictObject({ compilationId: z.uuid().optional(), requestId: z.uuid().optional() }).safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!selector.success || Number(Boolean(selector.data.compilationId)) + Number(Boolean(selector.data.requestId)) !== 1) throw new DomainError("COMPILATION_SELECTOR", "Choose one original compilation identity.", 400);
    const id = selector.data.compilationId ?? await findCompilationRequest(authority, selector.data.requestId!);
    return planningJson(await readSourceCompilation(authority, id));
  } catch (error) { return planningError(error); }
}
