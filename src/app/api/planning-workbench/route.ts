import { planningAuthority, planningJson, planningError } from "@/server/intelligence/http";
import { planningWorkbench } from "@/server/planning-workbench/service";
export const runtime = "nodejs";
export async function GET(request: Request) { try { return planningJson(await planningWorkbench(await planningAuthority(request))); } catch (error) { return planningError(error); } }
