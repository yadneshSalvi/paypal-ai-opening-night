import { audienceAuthority, audienceError, audienceJson } from "@/server/audience/http";
import { readAudienceWorkspace } from "@/server/audience/service";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return audienceJson(await readAudienceWorkspace(await audienceAuthority(request))); }
  catch (error) { return audienceError(error); }
}
