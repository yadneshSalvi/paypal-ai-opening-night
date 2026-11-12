import { tourAuthority, tourError, tourJson } from "@/server/tour/http";
import { readTourWorkspace } from "@/server/tour/service";
export const runtime = "nodejs";
export async function GET(request: Request) { try { return tourJson(await readTourWorkspace(await tourAuthority(request))); } catch (error) { return tourError(error); } }
