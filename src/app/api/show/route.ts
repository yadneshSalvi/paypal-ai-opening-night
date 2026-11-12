import { commandEnvelope, applyCommand, recordRescueRun } from "@/domain/commands";
import { DomainError } from "@/domain/contracts";
import { assertSameOrigin, consoleData, errorResponse, isProductionActor, requireActor } from "@/server/http";
import { getShow, pool, transactCommand } from "@/server/store";
import { generateCandidates } from "@/server/engine";
import { crewDutyKinds } from "@/domain/crew/contracts";
import { verifyCrewRecord } from "@/server/crew/signatures";
import { planningAuthority } from "@/server/intelligence/http";
import { requireSupplierRecoveryAuthority } from "@/server/supplier-recovery/store";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) { try { const actor = await requireActor(request); if (!isProductionActor(actor)) throw new DomainError("SCOPED_CLIENT_REQUIRED", "Open the dedicated crew, supplier or delivery client for this capability.", 403); return Response.json(consoleData(await getShow(actor.tenantId), actor), { headers: { "Cache-Control": "private, no-store" } }); } catch (e) { return errorResponse(e); } }
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request);
    if (!isProductionActor(actor)) throw new DomainError("SCOPED_CLIENT_REQUIRED", "Use the dedicated crew, supplier or delivery actions for this capability.", 403);
    if (Number(request.headers.get("content-length") ?? 0) > 30000) throw new DomainError("REQUEST_TOO_LARGE", "This request is too large.", 413);
    const parsed = commandEnvelope.safeParse(await request.json());
    if (!parsed.success) throw new DomainError("INVALID_COMMAND", "These instructions do not match the production command contract.", 400);
    const { command, expectedRevision, idempotencyKey } = parsed.data;
    if (command.type === "acknowledge" || command.type === "go" || command.type === "house_open" || command.type === "fact" && crewDutyKinds.includes(command.kind as typeof crewDutyKinds[number])) throw new DomainError("PERSON_CREW_CLIENT_REQUIRED", "Readbacks, technical sign-offs and live cues belong to the assigned person’s crew client.", 403);
    const authority = command.type === "approve" || command.type === "generate" ? await planningAuthority(request) : null;
    const authorityExpiry = authority ? await requireSupplierRecoveryAuthority(pool, authority, command.type === "approve" ? "producer" : "any") : undefined;
    const before = await getShow(actor.tenantId);
    if (command.type === "generate" && (!actor.roles.some(r => ["producer", "stage_manager"].includes(r)) || before.incidents.length === 0)) throw new DomainError("INCIDENT_REQUIRED", "Load and confirm the incident sources before computing recovery alternatives.");
    const candidates = command.type === "generate" ? await generateCandidates(before) : null;
    const result = await transactCommand(actor, idempotencyKey, expectedRevision, command, show => candidates ? recordRescueRun(show, actor, candidates) : applyCommand(show, actor, command, undefined, verifyCrewRecord), authority ? async client => { await requireSupplierRecoveryAuthority(client, authority, command.type === "approve" ? "producer" : "any", authorityExpiry); } : undefined);
    return Response.json({ ...consoleData(result.show, actor), replayed: result.replayed }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return errorResponse(e); }
}
