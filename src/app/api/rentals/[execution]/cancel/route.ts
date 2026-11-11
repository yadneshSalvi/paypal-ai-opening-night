import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { assertSameOrigin, consoleData, errorResponse, requireActor } from "@/server/http";
import { approveRentalCancellation } from "@/server/supplier-cancellation";
import { boundedJson } from "@/server/bounded-body";
export const runtime = "nodejs";
const schema = z.object({ idempotencyKey: z.uuid(), expectedRevision: z.number().int().positive(), approveUncapturedVoid: z.literal(true), detail: z.string().trim().min(12).max(1200) }).strict();
export async function POST(request: Request, context: { params: Promise<{ execution: string }> }) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request); const execution = z.uuid().safeParse((await context.params).execution);
    if (!execution.success) throw new DomainError("EXECUTION_NOT_FOUND", "This rental execution is invalid.", 404);
    const parsed = schema.safeParse(await boundedJson(request, 4000)); if (!parsed.success) throw new DomainError("CANCELLATION_REVIEW_REQUIRED", "Explicitly review the uncaptured authorization and state the cancellation reason.", 400);
    const value = parsed.data;
    return Response.json(consoleData(await approveRentalCancellation(actor, execution.data, value.idempotencyKey, value.expectedRevision, value.detail), actor), { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
