import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";
import { boundedJson } from "@/server/bounded-body";
import { deliveryOverview, inspectDelivery } from "@/server/delivery-service";
export const runtime = "nodejs";
const schema = z.object({ idempotencyKey: z.uuid(), expectedRevision: z.number().int().positive(), deliveryId: z.uuid(), version: z.number().int().positive(), decision: z.enum(["accept", "reject"]), confirmInspection: z.literal(true), condition: z.object({ report: z.string().trim().min(12).max(1200), powerOn: z.boolean(), accessories: z.boolean(), safeCondition: z.boolean() }).strict() }).strict();
export async function POST(request: Request, context: { params: Promise<{ execution: string }> }) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request); const execution = z.uuid().safeParse((await context.params).execution);
    if (!execution.success) throw new DomainError("EXECUTION_NOT_FOUND", "This rental execution is invalid.", 404);
    const parsed = schema.safeParse(await boundedJson(request, 4000)); if (!parsed.success) throw new DomainError("DELIVERY_INSPECTION_INVALID", "Record and explicitly confirm the current console condition inspection.", 400);
    const { idempotencyKey, confirmInspection: _confirmation, ...input } = parsed.data;
    await inspectDelivery(actor, { ...input, executionId: execution.data, commandId: idempotencyKey });
    return Response.json(await deliveryOverview(actor, execution.data), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
