import { workbenchUrl, workbenchJson, workbenchError } from "@/server/planning-workbench/http";
import { planningAuthority } from "@/server/intelligence/http";
import { planningWorkbench } from "@/server/planning-workbench/service";
export const runtime = "nodejs";
export async function GET(request: Request) { try { workbenchUrl(request); return workbenchJson(await planningWorkbench(await planningAuthority(request))); } catch (error) { return workbenchError(error); } }
