import { DomainError } from "@/domain/contracts";
import { errorResponse } from "@/server/http";
import { authenticateSupplierRequest, supplierIdSchema, supplierRequestSchema } from "@/server/supplier-protocol";
import { boundedText } from "@/server/bounded-body";
import { processSupplierRequest } from "@/server/supplier-service";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request, context: { params: Promise<{ supplier: string }> }) {
  try {
    const supplier = supplierIdSchema.safeParse((await context.params).supplier);
    if (!supplier.success) throw new DomainError("SUPPLIER_NOT_ENROLLED", "This supplier is not enrolled in the fixture network.", 404);
    if (Number(request.headers.get("content-length") ?? 0) > 8000) throw new DomainError("REQUEST_TOO_LARGE", "This supplier request exceeds its contract.", 413);
    const raw = await boundedText(request, 8000);
    if (Buffer.byteLength(raw, "utf8") > 8000) throw new DomainError("REQUEST_TOO_LARGE", "This supplier request exceeds its contract.", 413);
    const parsed = supplierRequestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new DomainError("SUPPLIER_REQUEST_INVALID", "The supplier instruction is invalid.", 400);
    authenticateSupplierRequest(supplier.data, request, parsed.data);
    return Response.json(await processSupplierRequest(supplier.data, parsed.data), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
