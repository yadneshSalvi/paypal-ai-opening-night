import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { tourAuthority, tourError, tourJson } from "@/server/tour/http";
import { readTourEdition } from "@/server/tour/service";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ record: string; revision: string }> }) { try { const params = await context.params; if (!z.uuid().safeParse(params.record).success || !/^[1-9]\d{0,5}$/.test(params.revision)) throw new DomainError("TOUR_EDITION_SELECTOR", "Choose an exact retained edition.", 400); return tourJson(await readTourEdition(await tourAuthority(request), params.record, Number(params.revision))); } catch (error) { return tourError(error); } }
