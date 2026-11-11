import { payoutAuthority, payoutError, payoutJson } from "@/server/payouts/http";
import { readPersonalPayouts } from "@/server/payouts/service";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return payoutJson(await readPersonalPayouts(await payoutAuthority(request, "personal"))); }
  catch (error) { return payoutError(error); }
}
