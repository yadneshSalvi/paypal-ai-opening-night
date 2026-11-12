import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { tourAuthority, tourError, tourJson } from "@/server/tour/http";
import { recoverTourCommand } from "@/server/tour/service";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ command: string }> }) { try { const { command } = await context.params; if (!z.uuid().safeParse(command).success) throw new DomainError("TOUR_COMMAND_ID", "Use the exact saved command identity.", 400); return tourJson({ receipt: await recoverTourCommand(await tourAuthority(request), command), replayed: true }); } catch (error) { return tourError(error); } }
