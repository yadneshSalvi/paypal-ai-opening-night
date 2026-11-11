import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";
import { boundedJson } from "@/server/bounded-body";
import { deliveryOverview, scanDelivery } from "@/server/delivery-service";
export const runtime = "nodejs";
const schema = z.object({ idempotencyKey: z.uuid(), token: z.string().min(80).max(1800) }).strict();
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request);
    const parsed = schema.safeParse(await boundedJson(request, 3000)); if (!parsed.success) throw new DomainError("DELIVERY_SCAN_INVALID", "Read the current signed handoff code before recording the scan.", 400);
    const receipt = await scanDelivery(actor, parsed.data.token, parsed.data.idempotencyKey);
    return Response.json(await deliveryOverview(actor, receipt.executionId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
