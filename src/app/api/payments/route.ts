import { DomainError } from "@/domain/contracts";
import { assertSameOrigin, consoleData, errorResponse, requireActor } from "@/server/http";
import { getShow } from "@/server/store";
import { handlePayment, paymentOverview, paymentRequest } from "@/server/payment-service";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function GET(request: Request) {
  try { const actor = await requireActor(request); return Response.json({ payments: await paymentOverview(actor) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request);
    const raw = await request.text(); if (raw.length > 4000) throw new DomainError("REQUEST_TOO_LARGE", "This payment request is too large.", 413);
    const parsed = paymentRequest.safeParse(JSON.parse(raw)); if (!parsed.success) throw new DomainError("INVALID_PAYMENT_REQUEST", "Review the payment action and its current production revision.", 400);
    const operation = await handlePayment(actor, parsed.data, new URL(request.url).origin);
    return Response.json({ ...consoleData(await getShow(actor.tenantId), actor), payments: await paymentOverview(actor), operation: { id: operation.command.intentId, status: operation.status, error: operation.error?.message ?? null } }, { status: operation.status === "pending_reconciliation" || operation.status === "dispatching" || operation.status === "claimed" ? 202 : 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
