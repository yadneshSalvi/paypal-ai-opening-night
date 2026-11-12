import { z } from "zod";
import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningBody, planningError, planningJson } from "@/server/intelligence/http";
import { previewRentalCloseout } from "@/server/rental-closeout/service";
export const runtime = "nodejs";
const schema = z.object({ executionId: z.uuid(), expectedRevision: z.number().int().positive() }).strict();
export async function POST(request: Request) { try { assertSameOrigin(request); const authority = await planningAuthority(request), body = await planningBody(request, schema); return planningJson(await previewRentalCloseout(authority, body.executionId, body.expectedRevision)); } catch (error) { return planningError(error); } }
