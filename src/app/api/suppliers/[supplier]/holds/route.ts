import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { assertSameOrigin, consoleData, errorResponse, requireActor } from "@/server/http";
import { callSupplierService, supplierIdSchema } from "@/server/supplier-protocol";
import { assertProducer } from "@/server/supplier-storage";
import { getShow } from "@/server/store";
import { boundedJson } from "@/server/bounded-body";
export const runtime = "nodejs";
export const maxDuration = 30;
const schema = z.object({ idempotencyKey: z.uuid(), expectedRevision: z.number().int().positive(), quoteId: z.uuid(), planDigest: z.string().regex(/^[a-f0-9]{64}$/), acceptCaptureTerms: z.literal(true) }).strict();
export async function POST(request: Request, context: { params: Promise<{ supplier: string }> }) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request); assertProducer(actor);
    const supplier = supplierIdSchema.safeParse((await context.params).supplier);
    if (!supplier.success) throw new DomainError("SUPPLIER_NOT_ENROLLED", "This supplier is not enrolled.", 404);
    const parsed = schema.safeParse(await boundedJson(request, 2000)); if (!parsed.success) throw new DomainError("HOLD_INVALID", "Review the exact current quote and capture terms before holding equipment.", 400);
    const { idempotencyKey, ...action } = parsed.data;
    const result = await callSupplierService(supplier.data, { version: 1, requestId: idempotencyKey, tenantId: actor.tenantId, actorId: actor.id, action: { type: "hold", ...action } }, AbortSignal.timeout(20000));
    return Response.json({ ...consoleData(await getShow(actor.tenantId), actor), reservation: result }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
