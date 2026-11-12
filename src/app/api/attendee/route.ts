import { DomainError } from "@/domain/contracts";
import { readAttendee, requireAttendeeReader } from "@/server/audience/attendee";
import { audienceError, audienceId, audienceJson } from "@/server/audience/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => key !== "before") || params.getAll("before").length > 1) throw new DomainError("ATTENDEE_QUERY_INVALID", "This private reader accepts only its own inbox position.", 400);
    const before = params.has("before") ? audienceId(params.get("before")!) : null;
    return audienceJson(await readAttendee(await requireAttendeeReader(request), before));
  } catch (error) { return audienceError(error); }
}
