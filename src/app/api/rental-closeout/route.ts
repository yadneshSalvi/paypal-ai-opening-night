import { planningAuthority, planningError, planningJson } from "@/server/intelligence/http";
import { readCloseoutWorkspace } from "@/server/rental-closeout/service";
export const runtime = "nodejs";
export async function GET(request: Request) { try { return planningJson(await readCloseoutWorkspace(await planningAuthority(request))); } catch (error) { return planningError(error); } }
