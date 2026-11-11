import { errorResponse } from "@/server/http";
import { runJobTick } from "@/server/job-runner";
import { authorizeWorker } from "@/server/worker-auth";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  try { authorizeWorker(request); return Response.json(await runJobTick(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export const POST = GET;
