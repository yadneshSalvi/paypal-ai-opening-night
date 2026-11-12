import { audienceWorkSchema } from "@/domain/audience/contracts";
import { assertSameOrigin } from "@/server/http";
import { audienceAuthority, audienceBody, audienceError, audienceJson } from "@/server/audience/http";
import { runAudienceDelivery } from "@/server/audience/service";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { assertSameOrigin(request); const authority = await audienceAuthority(request), body = await audienceBody(request, audienceWorkSchema); return audienceJson(await runAudienceDelivery(authority, body.commandId, body.proof, request.signal)); }
  catch (error) { return audienceError(error); }
}
