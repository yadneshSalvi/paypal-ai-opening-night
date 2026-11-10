import { commandEnvelope, applyCommand, recordRescueRun } from "@/domain/commands";
import { DomainError } from "@/domain/contracts";
import { assertSameOrigin, consoleData, errorResponse, requireActor } from "@/server/http";
import { getShow, transactCommand } from "@/server/store";
import { generateCandidates } from "@/server/engine";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) { try { const actor = await requireActor(request); return Response.json(consoleData(await getShow(actor.tenantId), actor), { headers: { "Cache-Control": "private, no-store" } }); } catch (e) { return errorResponse(e); } }
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request);
    if (Number(request.headers.get("content-length") ?? 0) > 30000) throw new DomainError("REQUEST_TOO_LARGE", "This request is too large.", 413);
    const parsed = commandEnvelope.safeParse(await request.json());
    if (!parsed.success) throw new DomainError("INVALID_COMMAND", "These instructions do not match the production command contract.", 400);
    const { command, expectedRevision, idempotencyKey } = parsed.data;
    const before = await getShow(actor.tenantId);
    if (command.type === "generate" && (!actor.roles.some(r => ["producer", "stage_manager"].includes(r)) || before.incidents.length === 0)) throw new DomainError("INCIDENT_REQUIRED", "Load and confirm the incident sources before computing recovery alternatives.");
    const candidates = command.type === "generate" ? await generateCandidates(before) : null;
    const result = await transactCommand(actor, idempotencyKey, expectedRevision, command, show => candidates ? recordRescueRun(show, actor, candidates) : applyCommand(show, actor, command));
    return Response.json({ ...consoleData(result.show, actor), replayed: result.replayed }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return errorResponse(e); }
}
