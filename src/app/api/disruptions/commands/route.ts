import { disruptionEnvelopeSchema } from "@/domain/disruptions";
import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningBody, planningError, planningJson } from "@/server/intelligence/http";
import { executeDisruptionCommand } from "@/server/disruptions/service";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try { assertSameOrigin(request); const authority = await planningAuthority(request), envelope = await planningBody(request, disruptionEnvelopeSchema); return planningJson(await executeDisruptionCommand(authority, envelope)); }
  catch (error) { return planningError(error); }
}
