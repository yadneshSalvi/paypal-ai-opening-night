import { intelligenceToolCommand } from "@/domain/intelligence";
import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningBody, planningJson, planningError } from "@/server/intelligence/http";
import { executeIntelligenceTool } from "@/server/intelligence/tools";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try { assertSameOrigin(request); return planningJson(await executeIntelligenceTool(await planningAuthority(request), await planningBody(request, intelligenceToolCommand))); }
  catch (error) { return planningError(error); }
}
