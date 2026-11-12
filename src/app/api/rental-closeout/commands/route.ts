import { closeoutEnvelopeSchema } from "@/domain/rental-closeout";
import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningBody, planningError, planningJson } from "@/server/intelligence/http";
import { executeCloseoutCommand } from "@/server/rental-closeout/service";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) { try { assertSameOrigin(request); const authority = await planningAuthority(request), envelope = await planningBody(request, closeoutEnvelopeSchema); return planningJson(await executeCloseoutCommand(authority, envelope)); } catch (error) { return planningError(error); } }
