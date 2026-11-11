import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { errorResponse, requireActor } from "@/server/http";
import { deliveryOverview } from "@/server/delivery-service";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ execution: string }> }) {
  try {
    const actor = await requireActor(request); const execution = z.uuid().safeParse((await context.params).execution);
    if (!execution.success) throw new DomainError("EXECUTION_NOT_FOUND", "This rental execution is invalid.", 404);
    return Response.json(await deliveryOverview(actor, execution.data), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
