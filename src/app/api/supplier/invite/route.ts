import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";
import { createSupplierCapability } from "@/server/store";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { assertSameOrigin(request); const actor = await requireActor(request); const token = await createSupplierCapability(actor); return Response.json({ url: "/supplier/access#" + token }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return errorResponse(error); }
}
