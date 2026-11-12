import { writerRequestSchema } from "@/domain/audience/writer";
import { assertSameOrigin } from "@/server/http";
import { audienceAuthority, audienceBody, audienceError, audienceJson } from "@/server/audience/http";
import { draftWithWriter, readWriterWorkspace } from "@/server/audience/writer";
export const runtime = "nodejs";
export const maxDuration = 60;
/** Writer availability, caps and this producer access's retained writer runs. Reading drafts nothing. */
export async function GET(request: Request) {
  try { return audienceJson(await readWriterWorkspace(await audienceAuthority(request))); }
  catch (error) { return audienceError(error); }
}
/** One bounded writer run. It returns a fact-checked draft or a stored failure; it never saves, approves or delivers a message. */
export async function POST(request: Request) {
  try { assertSameOrigin(request); return audienceJson(await draftWithWriter(await audienceAuthority(request), await audienceBody(request, writerRequestSchema))); }
  catch (error) { return audienceError(error); }
}
