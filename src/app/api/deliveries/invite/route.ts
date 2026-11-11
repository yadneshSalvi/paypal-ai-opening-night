import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";
import { boundedJson } from "@/server/bounded-body";
import { createDeliveryCapability } from "@/server/store";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request);
    const parsed = z.object({ role: z.enum(["driver", "inspector"]) }).strict().safeParse(await boundedJson(request, 500));
    if (!parsed.success) throw new DomainError("DELIVERY_ROLE_INVALID", "Choose the controlled driver or assigned lighting lead.", 400);
    const invitation = await createDeliveryCapability(actor, parsed.data.role);
    return Response.json({ url: `/delivery/access?execution=${invitation.executionId}#access=${invitation.token}`, role: parsed.data.role }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
