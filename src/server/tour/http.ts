import { DomainError } from "@/domain/contracts";
import { planningAuthority, planningJson, planningError } from "../intelligence/http";
import { requireCrewSession } from "../crew/service";
import type { TourAuthority } from "./store";
export async function tourAuthority(request: Request, personal = false): Promise<TourAuthority> {
  if (personal) { const session = await requireCrewSession(request); return { actor: session.actor, sessionHash: session.tokenHash }; }
  const authority = await planningAuthority(request);
  if (authority.actor.personId && !/^Bearer [A-Za-z0-9_-]{43}$/.test(request.headers.get("authorization") ?? "")) throw new DomainError("TOUR_PERSON_CAPABILITY", "Open the personal crew link for this action.", 401);
  return authority;
}
export const tourJson = planningJson;
export const tourError = planningError;
