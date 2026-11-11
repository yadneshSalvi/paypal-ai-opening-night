import { payoutEnvelopeSchema } from "@/domain/payouts/contracts";
import { assertSameOrigin } from "@/server/http";
import { payoutAuthority, payoutBody, payoutError, payoutJson } from "@/server/payouts/http";
import { executePayout, readPayouts } from "@/server/payouts/service";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return payoutJson(await readPayouts(await payoutAuthority(request, "production"))); }
  catch (error) { return payoutError(error); }
}
export async function POST(request: Request) {
  try { assertSameOrigin(request); const authority = await payoutAuthority(request, "production"); return payoutJson(await executePayout(authority, await payoutBody(request, payoutEnvelopeSchema))); }
  catch (error) { return payoutError(error); }
}
