import { z } from "zod";
import { wrapAssistantStart } from "@/domain/wrap/assistant";
import { assertSameOrigin } from "@/server/http";
import { startWrapAssistant, wrapAssistantWorkspace } from "@/server/wrap/assistant";
import { wrapAuthority, wrapBody, wrapError, wrapJson } from "@/server/wrap/http";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) { try { const query = z.object({ cursor: z.uuid().optional() }).strict().parse(Object.fromEntries(new URL(request.url).searchParams)); return wrapJson(await wrapAssistantWorkspace(await wrapAuthority(request, "production"), query.cursor)); } catch (error) { return wrapError(error); } }
export async function POST(request: Request) { try { assertSameOrigin(request); return wrapJson(await startWrapAssistant(await wrapAuthority(request, "production"), await wrapBody(request, wrapAssistantStart))); } catch (error) { return wrapError(error); } }
