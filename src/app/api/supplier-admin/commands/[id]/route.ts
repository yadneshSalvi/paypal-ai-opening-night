import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { adminAuthority, adminError, adminJson } from "@/server/supplier-admin/http";
import { recoverSupplierAdminCommand } from "@/server/supplier-admin/service";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success || new URL(request.url).search) throw new DomainError("SUPPLIER_ADMIN_COMMAND_ID", "Select the original command identity.", 400);
    return adminJson(await recoverSupplierAdminCommand(await adminAuthority(request), id));
  } catch (error) { return adminError(error); }
}
