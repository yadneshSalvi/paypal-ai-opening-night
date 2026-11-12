import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { planningAuthority, planningJson, planningError } from "@/server/intelligence/http";
import { recoverWorkbench } from "@/server/planning-workbench/service";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { const { id } = await context.params; if (!z.uuid().safeParse(id).success) throw new DomainError("WORKBENCH_COMMAND_INVALID", "Use the exact original command identity.", 400); return planningJson(await recoverWorkbench(await planningAuthority(request), id)); } catch (error) { return planningError(error); } }
