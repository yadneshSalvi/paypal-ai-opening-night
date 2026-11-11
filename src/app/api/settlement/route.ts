import { producerSettlementEnvelopeSchema } from "@/domain/settlement/contracts";
import { assertSameOrigin } from "@/server/http";
import { settlementAuthority, settlementBody, settlementError, settlementJson } from "@/server/settlement/http";
import { executeSettlement, readSettlement } from "@/server/settlement/service";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return settlementJson(await readSettlement(await settlementAuthority(request, "production"))); }
  catch (error) { return settlementError(error); }
}
export async function POST(request: Request) {
  try { assertSameOrigin(request); const authority = await settlementAuthority(request, "production"); return settlementJson(await executeSettlement(authority, await settlementBody(request, producerSettlementEnvelopeSchema))); }
  catch (error) { return settlementError(error); }
}
