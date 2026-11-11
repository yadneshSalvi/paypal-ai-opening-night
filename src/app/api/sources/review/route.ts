import { applySourceSchema } from "@/domain/sources";
import { assertSameOrigin, consoleData } from "@/server/http";
import { planningAuthority, planningBody, planningError, planningJson } from "@/server/intelligence/http";
import { applySourceCompilation } from "@/server/sources/compiler";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { assertSameOrigin(request); const authority = await planningAuthority(request), command = await planningBody(request, applySourceSchema), result = await applySourceCompilation(authority, command); return planningJson({ ...consoleData(result.show, authority.actor), replayed: result.replayed }); }
  catch (error) { return planningError(error); }
}
