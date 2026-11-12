import { supplierAdminEnvelopeSchema } from "@/domain/supplier-admin/commands";
import { assertSameOrigin } from "@/server/http";
import { planningBody } from "@/server/intelligence/http";
import { adminAuthority, adminError, adminJson } from "@/server/supplier-admin/http";
import { executeSupplierAdminCommand } from "@/server/supplier-admin/service";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request) {
  try { assertSameOrigin(request); return adminJson(await executeSupplierAdminCommand(await adminAuthority(request), await planningBody(request, supplierAdminEnvelopeSchema))); }
  catch (error) { return adminError(error); }
}
