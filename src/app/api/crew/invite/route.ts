import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";
import { createCrewCapability } from "@/server/store";
export async function POST(request: Request) {
  try { assertSameOrigin(request); const actor = await requireActor(request); const body = z.object({ personId: z.string().max(80) }).strict().safeParse(await request.json()); if (!body.success) throw new DomainError("INVALID_PERSON", "Choose a rostered person.", 400); const token = await createCrewCapability(actor, body.data.personId); return Response.json({ url: `/crew/access#${token}` }); } catch (e) { return errorResponse(e); }
}
