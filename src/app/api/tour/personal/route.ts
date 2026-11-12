import { tourAuthority, tourError, tourJson } from "@/server/tour/http";
import { readPersonalTour } from "@/server/tour/service";
export const runtime = "nodejs";
export async function GET(request: Request) { try { return tourJson(await readPersonalTour(await tourAuthority(request, true))); } catch (error) { return tourError(error); } }
