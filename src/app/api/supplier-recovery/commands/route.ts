import { supplierRecoveryEnvelopeSchema } from "@/domain/supplier-recovery";
import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningBody, planningError, planningJson } from "@/server/intelligence/http";
import { executeSupplierRecoveryCommand } from "@/server/supplier-recovery/service";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { assertSameOrigin(request); return planningJson(await executeSupplierRecoveryCommand(await planningAuthority(request), await planningBody(request, supplierRecoveryEnvelopeSchema))); }
  catch (error) { return planningError(error); }
}
