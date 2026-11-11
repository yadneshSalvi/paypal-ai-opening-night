import { DomainError } from "@/domain/contracts";
import { boundedJson } from "@/server/bounded-body";
import { commerceOverview, commerceRequest, handleCommerce } from "@/server/commerce-service";
import { assertSameOrigin, consoleData, errorResponse, requireActor } from "@/server/http";
import { getShow } from "@/server/store";
import { WalletProviderError } from "@/server/wallet-provider";
export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  try { const actor = await requireActor(request); const show = await getShow(actor.tenantId); return Response.json({ ...consoleData(show, actor), commerce: await commerceOverview(actor, show) }, { headers }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const origin = assertSameOrigin(request); const actor = await requireActor(request);
    const parsed = commerceRequest.safeParse(await boundedJson(request, 8192));
    if (!parsed.success) throw new DomainError("COMMERCE_REVIEW_REQUIRED", "Review the exact ticket or wallet terms before submitting this action.", 400);
    const work = await handleCommerce(actor, parsed.data, origin);
    const show = await getShow(actor.tenantId);
    return Response.json({ ...consoleData(show, actor), commerce: await commerceOverview(actor, show), work }, { status: work?.status === "waiting" ? 202 : 200, headers });
  } catch (error) {
    if (error instanceof WalletProviderError) return Response.json({ error: "PayPal could not confirm the saved method. Its original request is retained for a safe readback.", code: error.code }, { status: 503, headers });
    return errorResponse(error);
  }
}
