import { assertSameOrigin } from "@/server/http";
import { boundedJson } from "@/server/bounded-body";
import { tourAuthority, tourError, tourJson } from "@/server/tour/http";
import { executeTour } from "@/server/tour/service";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) { try { assertSameOrigin(request); const authority = await tourAuthority(request); return tourJson(await executeTour(authority, await boundedJson(request, 1500000))); } catch (error) { return tourError(error); } }
