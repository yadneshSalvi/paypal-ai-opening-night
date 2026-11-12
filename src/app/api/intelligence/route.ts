import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { startIntelligenceSchema } from "@/domain/intelligence";
import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningDispatchAuthority, planningBody, planningJson, planningError } from "@/server/intelligence/http";
import { readIntelligenceRun, startIntelligence } from "@/server/intelligence/provider";
import { intelligenceWorkspace } from "@/server/intelligence/tools";
import { readIntelligenceConversation, requirePlanningAuthority, withPlanningTransaction } from "@/server/intelligence/ledger";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  try { assertSameOrigin(request); const authority = await planningDispatchAuthority(request); return planningJson(await startIntelligence(authority, await planningBody(request, startIntelligenceSchema))); }
  catch (error) { return planningError(error); }
}
export async function GET(request: Request) {
  try {
    const authority = await planningAuthority(request), query = new URL(request.url).searchParams;
    const parsed = z.strictObject({ runId: z.string().uuid().optional(), requestId: z.string().uuid().optional(), conversationId: z.string().uuid().optional() }).safeParse(Object.fromEntries(query));
    if (!parsed.success || Object.keys(parsed.data).length > 1) throw new DomainError("INVALID_PLANNING_SELECTOR", "Choose one saved planning identity.", 400);
    const { runId, requestId, conversationId } = parsed.data;
    if (runId) return planningJson(await readIntelligenceRun(authority, runId));
    if (conversationId) return planningJson(await readIntelligenceConversation(authority, conversationId));
    if (requestId) {
      const id = await withPlanningTransaction(async db => {
        await requirePlanningAuthority(db, authority);
        return (await db.query<{ id: string }>("SELECT id FROM on_intelligence_runs WHERE request_id=$1 AND tenant_id=$2 AND actor_id=$3", [requestId, authority.actor.tenantId, authority.actor.id])).rows[0]?.id;
      });
      if (!id) throw new DomainError("PLANNING_NOT_FOUND", "This planning request is not in your current workspace.", 404);
      return planningJson(await readIntelligenceRun(authority, id));
    }
    return planningJson(await intelligenceWorkspace(authority));
  } catch (error) { return planningError(error); }
}
