import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningBody, planningError, planningJson } from "@/server/intelligence/http";
import { runJobTick } from "@/server/job-runner";
import { readCloseoutWorkspace } from "@/server/rental-closeout/service";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) { try { assertSameOrigin(request); const authority = await planningAuthority(request); await planningBody(request, z.object({}).strict()); const workspace = await readCloseoutWorkspace(authority); if (workspace.access === "supplier") throw new DomainError("RENTAL_CLOSEOUT_WORK_SCOPE", "The production desk processes approved hold work. Supplier readback remains scoped to its original unit.", 403); const work = await runJobTick({ tenantId: authority.actor.tenantId, kinds: ["rental_closeout_dispatch", "rental_closeout_readback", "rental_closeout_retry"], limit: 4 }); return planningJson({ work, workspace: await readCloseoutWorkspace(authority) }); } catch (error) { return planningError(error); } }
