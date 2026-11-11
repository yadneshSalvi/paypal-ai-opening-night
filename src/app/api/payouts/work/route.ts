import { z } from "zod";
import { assertSameOrigin } from "@/server/http";
import { runJobTick } from "@/server/job-runner";
import { payoutAuthority, payoutBody, payoutError, payoutJson } from "@/server/payouts/http";
import { readPayouts } from "@/server/payouts/service";
import { payoutJobKinds } from "@/server/payouts/worker";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const authority = await payoutAuthority(request, "production"); await payoutBody(request, z.object({}).strict());
    await readPayouts(authority);
    // This surface cannot wake tickets, rentals, refunds or another tenant's jobs.
    const work = await runJobTick({ tenantId: authority.actor.tenantId, kinds: payoutJobKinds, limit: 8 });
    return payoutJson({ work, data: await readPayouts(authority) });
  } catch (error) { return payoutError(error); }
}
