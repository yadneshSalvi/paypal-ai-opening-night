import { audienceEnvelopeSchema } from "@/domain/audience/contracts";
import { assertSameOrigin } from "@/server/http";
import { audienceAuthority, audienceBody, audienceError, audienceJson } from "@/server/audience/http";
import { executeAudienceCommand } from "@/server/audience/service";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { assertSameOrigin(request); return audienceJson(await executeAudienceCommand(await audienceAuthority(request), await audienceBody(request, audienceEnvelopeSchema))); }
  catch (error) { return audienceError(error); }
}
