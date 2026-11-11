import { z } from "zod";
import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningBody, planningError, planningJson } from "@/server/intelligence/http";
import { extractSource } from "@/server/sources/store";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try { assertSameOrigin(request); const authority = await planningAuthority(request), { sourceId } = await planningBody(request, z.strictObject({ sourceId: z.uuid() })); return planningJson(await extractSource(authority, sourceId)); }
  catch (error) { return planningError(error); }
}
