import { z } from "zod";
import { assertSameOrigin } from "@/server/http";
import { runJobTick } from "@/server/job-runner";
import { wrapAuthority, wrapBody, wrapError, wrapJson } from "@/server/wrap/http";
import { readWrap } from "@/server/wrap/service";
import { invoiceJobKinds } from "@/server/wrap/worker";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) { try { assertSameOrigin(request); const authority = await wrapAuthority(request, "production"); await wrapBody(request, z.object({}).strict()); await readWrap(authority); const work = await runJobTick({ tenantId: authority.actor.tenantId, kinds: invoiceJobKinds, limit: 4 }); return wrapJson({ work, data: await readWrap(authority) }); } catch (error) { return wrapError(error); } }
