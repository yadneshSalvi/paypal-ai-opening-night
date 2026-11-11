import { deleteSourceSchema } from "@/domain/sources";
import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningBody, planningError, planningJson } from "@/server/intelligence/http";
import { deleteSource } from "@/server/sources/store";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { assertSameOrigin(request); const authority = await planningAuthority(request), command = await planningBody(request, deleteSourceSchema); return planningJson(await deleteSource(authority, command.sourceId, command.contentHash)); }
  catch (error) { return planningError(error); }
}
