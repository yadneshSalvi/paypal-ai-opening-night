import { z } from "zod";
import { assertSameOrigin } from "@/server/http";
import { payoutAuthority, payoutBody, payoutError, payoutJson } from "@/server/payouts/http";
import { readPayoutReview } from "@/server/payouts/service";
export const runtime = "nodejs";
const schema = z.object({ personIds: z.array(z.string().min(1).max(128)).min(1).max(20) }).strict();
/** This computes a review only. It does not authorize, queue or dispatch money. */
export async function POST(request: Request) {
  try { assertSameOrigin(request); const authority = await payoutAuthority(request, "production"), body = await payoutBody(request, schema); return payoutJson(await readPayoutReview(authority, body.personIds)); }
  catch (error) { return payoutError(error); }
}
