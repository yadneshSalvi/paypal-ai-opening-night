import { z } from "zod";
import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningBody, planningError, planningJson } from "@/server/intelligence/http";
import { continueSupplierRecoveryRfq } from "@/server/supplier-recovery/service";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request) {
  try { assertSameOrigin(request); const authority = await planningAuthority(request), input = await planningBody(request, z.object({ rfqId: z.uuid() }).strict()); return planningJson(await continueSupplierRecoveryRfq(authority, input.rfqId, AbortSignal.timeout(20000))); }
  catch (error) { return planningError(error); }
}
