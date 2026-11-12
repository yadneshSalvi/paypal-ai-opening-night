import { planningAuthority, planningError, planningJson } from "@/server/intelligence/http";
import { readDisruptionWorkspace } from "@/server/disruptions/service";
export const runtime = "nodejs";
export async function GET(request: Request) { try { return planningJson(await readDisruptionWorkspace(await planningAuthority(request))); } catch (error) { return planningError(error); } }
