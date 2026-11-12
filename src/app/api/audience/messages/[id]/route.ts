import { audienceAuthority, audienceError, audienceId, audienceJson } from "@/server/audience/http";
import { readAudienceMessage } from "@/server/audience/service";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { return audienceJson(await readAudienceMessage(await audienceAuthority(request), audienceId((await context.params).id))); }
  catch (error) { return audienceError(error); }
}
