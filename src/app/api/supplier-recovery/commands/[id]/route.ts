import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { planningAuthority, planningError, planningJson } from "@/server/intelligence/http";
import { recoverSupplierRecoveryCommand } from "@/server/supplier-recovery/service";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { id } = await context.params; if (!z.uuid().safeParse(id).success) throw new DomainError("SUPPLIER_RECOVERY_COMMAND_ID", "Select the original command identity.", 400); return planningJson(await recoverSupplierRecoveryCommand(await planningAuthority(request), id)); }
  catch (error) { return planningError(error); }
}
