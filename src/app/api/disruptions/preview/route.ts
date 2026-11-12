import { z } from "zod";
import { disruptionModeSchema } from "@/domain/disruptions";
import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningBody, planningError, planningJson } from "@/server/intelligence/http";
import { previewCancellation } from "@/server/disruptions/service";
export const runtime = "nodejs";
const schema = z.object({ mode: disruptionModeSchema, admissionRefundMinor: z.number().int().min(0).max(3500) }).strict();
export async function POST(request: Request) {
  try { assertSameOrigin(request); const authority = await planningAuthority(request), body = await planningBody(request, schema); return planningJson(await previewCancellation(authority, body.mode, body.admissionRefundMinor)); }
  catch (error) { return planningError(error); }
}
