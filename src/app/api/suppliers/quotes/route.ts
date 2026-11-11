import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { assertSameOrigin, consoleData, errorResponse, requireActor } from "@/server/http";
import { beginSupplierRfq, collectSupplierRfq, supplierOverview } from "@/server/supplier-rfq";
import { getShow } from "@/server/store";
import { boundedJson } from "@/server/bounded-body";
export const runtime = "nodejs";
export const maxDuration = 30;
const schema = z.object({ idempotencyKey: z.uuid(), expectedRevision: z.number().int().positive() }).strict();
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request);
    const parsed = schema.safeParse(await boundedJson(request, 1000)); if (!parsed.success) throw new DomainError("RFQ_INVALID", "Review the current production before requesting quotes.", 400);
    await beginSupplierRfq(actor, parsed.data.idempotencyKey, parsed.data.expectedRevision);
    const result = await collectSupplierRfq(actor.tenantId, parsed.data.idempotencyKey, AbortSignal.timeout(20000));
    return Response.json({ ...consoleData(await getShow(actor.tenantId), actor), suppliers: await supplierOverview(actor), work: result }, { status: result.status === "waiting" ? 202 : 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
