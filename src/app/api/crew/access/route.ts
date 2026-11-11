import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { crewAccessOverview, revokeCrewAccess } from "@/server/crew/access";
import { assertSameOrigin, consoleData, errorResponse, requireActor } from "@/server/http";
import { boundedJson } from "@/server/bounded-body";

export async function GET(request: Request) {
  try { return Response.json(await crewAccessOverview(await requireActor(request)), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request);
    const parsed = z.object({ personId: z.string().min(1).max(80), idempotencyKey: z.uuid(), expectedRevision: z.number().int().positive(), confirmed: z.literal(true) }).strict().safeParse(await boundedJson(request, 6000));
    if (!parsed.success) throw new DomainError("CREW_ACCESS_REVIEW_REQUIRED", "Review the person and current production before revoking access.", 400);
    const { personId, idempotencyKey, expectedRevision } = parsed.data;
    const result = await revokeCrewAccess(actor, personId, idempotencyKey, expectedRevision);
    return Response.json({ ...consoleData(result.show, actor), replayed: result.replayed }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
