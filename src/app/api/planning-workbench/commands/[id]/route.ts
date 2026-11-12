import { workbenchUrl, workbenchJson, workbenchError } from "@/server/planning-workbench/http";
import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { planningAuthority } from "@/server/intelligence/http";
import { recoverWorkbench } from "@/server/planning-workbench/service";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { workbenchUrl(request); const { id } = await context.params; if (!z.uuid().safeParse(id).success) throw new DomainError("WORKBENCH_COMMAND_INVALID", "Use the exact original command identity.", 400); return workbenchJson(await recoverWorkbench(await planningAuthority(request), id)); } catch (error) { return workbenchError(error); } }
