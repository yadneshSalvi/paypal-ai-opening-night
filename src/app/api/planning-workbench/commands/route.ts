import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningBody, planningJson, planningError } from "@/server/intelligence/http";
import { executeWorkbench } from "@/server/planning-workbench/service";
import { workbenchEnvelopeSchema } from "@/domain/planning-workbench/contracts";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) { try { assertSameOrigin(request); return planningJson(await executeWorkbench(await planningAuthority(request), await planningBody(request, workbenchEnvelopeSchema))); } catch (error) { return planningError(error); } }
