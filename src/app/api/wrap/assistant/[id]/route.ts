import { z } from "zod";
import { assertSameOrigin } from "@/server/http";
import { advanceWrapAssistant, readWrapAssistant } from "@/server/wrap/assistant";
import { wrapAuthority, wrapBody, wrapError, wrapJson } from "@/server/wrap/http";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { return wrapJson(await readWrapAssistant(await wrapAuthority(request, "production"), z.uuid().parse((await context.params).id))); } catch (error) { return wrapError(error); } }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { try { assertSameOrigin(request); await wrapBody(request, z.object({}).strict()); return wrapJson(await advanceWrapAssistant(await wrapAuthority(request, "production"), z.uuid().parse((await context.params).id))); } catch (error) { return wrapError(error); } }
