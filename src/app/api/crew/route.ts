import { DomainError } from "@/domain/contracts";
import { crewCommandEnvelopeSchema } from "@/domain/crew/contracts";
import { boundedJson } from "@/server/bounded-body";
import { assertSameOrigin, errorResponse } from "@/server/http";
import { executeCrew, readCrew, requireCrewSession } from "@/server/crew/service";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", Vary: "Authorization" };
function crewError(error: unknown) {
  const response = errorResponse(error);
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}
export async function GET(request: Request) {
  try { return Response.json(await readCrew(await requireCrewSession(request)), { headers }); }
  catch (error) { return crewError(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const access = await requireCrewSession(request);
    const body = crewCommandEnvelopeSchema.safeParse(await boundedJson(request, 22000));
    if (!body.success) throw new DomainError("INVALID_CREW_COMMAND", "Review the exact published calls and your permitted crew action.", 400);
    return Response.json(await executeCrew(access, body.data), { headers });
  } catch (error) { return crewError(error); }
}
