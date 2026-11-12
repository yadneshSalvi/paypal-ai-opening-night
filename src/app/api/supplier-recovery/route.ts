import { planningAuthority, planningError, planningJson } from "@/server/intelligence/http";
import { readSupplierRecoveryWorkspace } from "@/server/supplier-recovery/service";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return planningJson(await readSupplierRecoveryWorkspace(await planningAuthority(request))); }
  catch (error) { return planningError(error); }
}
