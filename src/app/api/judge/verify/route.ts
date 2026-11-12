import { DomainError } from "@/domain/contracts";
import { assertSameOrigin, currentActor, errorResponse, isProductionActor } from "@/server/http";
import { readRetainedEvidence } from "@/server/judge/verify";

export const runtime = "nodejs";
export const maxDuration = 60;
/**
 * Read-only GETs of at most three retained original sandbox resources, shared
 * by every visitor for ten minutes. Not part of any demonstration.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await currentActor();
    if (!actor || !isProductionActor(actor)) throw new DomainError("SESSION_REQUIRED", "Open a rehearsal session to continue.", 401);
    return Response.json(await readRetainedEvidence(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
