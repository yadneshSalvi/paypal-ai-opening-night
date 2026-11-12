import { adminAuthority, adminError, adminJson } from "@/server/supplier-admin/http";
import { readSupplierAdminWorkspace } from "@/server/supplier-admin/service";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { if (new URL(request.url).search) return adminJson({ code: "SUPPLIER_ADMIN_QUERY", error: "Use the current supplier desk or an original command identity." }, 400); return adminJson(await readSupplierAdminWorkspace(await adminAuthority(request))); }
  catch (error) { return adminError(error); }
}
