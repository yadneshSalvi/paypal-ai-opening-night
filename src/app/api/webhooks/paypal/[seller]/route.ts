import { ProviderError } from "@fracture/paypal-core";
import { DomainError } from "@/domain/contracts";
import { errorResponse } from "@/server/http";
import { ingestPaymentWebhook, readWebhookBody } from "@/server/payment-webhooks";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request, context: { params: Promise<{ seller: string }> }) {
  try {
    const { seller } = await context.params;
    if (seller !== "venue" && seller !== "brightline") throw new DomainError("MERCHANT_NOT_FOUND", "This webhook merchant does not exist.", 404);
    const result = await ingestPaymentWebhook(seller, await readWebhookBody(request), request.headers);
    return Response.json(result, { status: result.accepted ? 200 : 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Verification outages must ask PayPal to redeliver; a202 would lose the wakeup.
    if (error instanceof ProviderError) return Response.json({ code: "WEBHOOK_VERIFICATION_UNAVAILABLE", error: "Signature verification is temporarily unavailable. Retry this delivery." }, { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } });
    return errorResponse(error);
  }
}
