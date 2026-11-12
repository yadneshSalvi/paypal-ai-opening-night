import { DomainError } from "@/domain/contracts";
import { managedSupplierIdSchema } from "@/domain/supplier-admin/commands";
import { boundedJson } from "@/server/bounded-body";
import { authenticateSupplierRequest, supplierRequestSchema } from "@/server/supplier-protocol";
import { processManagedSupplierRequest } from "@/server/supplier-admin/adapters";
import { adminError, adminJson } from "@/server/supplier-admin/http";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request, context: { params: Promise<{ supplier: string }> }) {
  try {
    const supplier = managedSupplierIdSchema.safeParse((await context.params).supplier);
    if (!supplier.success) throw new DomainError("SUPPLIER_NOT_ENROLLED", "This supplier is not enrolled.", 404);
    const parsed = supplierRequestSchema.safeParse(await boundedJson(request, 8000));
    if (!parsed.success) throw new DomainError("SUPPLIER_REQUEST_INVALID", "The managed service instruction is invalid.", 400);
    authenticateSupplierRequest(supplier.data, request, parsed.data);
    return adminJson(await processManagedSupplierRequest(supplier.data, parsed.data));
  } catch (error) { return adminError(error); }
}
