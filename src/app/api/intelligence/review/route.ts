import { assertSameOrigin, consoleData } from "@/server/http";
import { planningAuthority, planningBody, planningJson, planningError } from "@/server/intelligence/http";
import { reviewIntelligenceProposal, reviewIntelligenceSchema } from "@/server/intelligence/tools";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { assertSameOrigin(request); const authority = await planningAuthority(request); const result = await reviewIntelligenceProposal(authority, await planningBody(request, reviewIntelligenceSchema)); return planningJson({ ...consoleData(result.show, authority.actor), replayed: result.replayed }); }
  catch (error) { return planningError(error); }
}
