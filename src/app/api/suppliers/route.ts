import { errorResponse, requireActor } from "@/server/http";
import { supplierOverview } from "@/server/supplier-rfq";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return Response.json(await supplierOverview(await requireActor(request)), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return errorResponse(error); }
}
