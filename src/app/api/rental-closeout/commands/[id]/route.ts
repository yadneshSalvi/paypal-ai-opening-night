import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { planningAuthority, planningError, planningJson } from "@/server/intelligence/http";
import { recoverCloseoutCommand } from "@/server/rental-closeout/service";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { const authority = await planningAuthority(request), { id } = await context.params; if (!z.uuid().safeParse(id).success) throw new DomainError("RENTAL_CLOSEOUT_COMMAND_ID", "Select the exact original rental instruction.", 400); return planningJson(await recoverCloseoutCommand(authority, id)); } catch (error) { return planningError(error); } }
