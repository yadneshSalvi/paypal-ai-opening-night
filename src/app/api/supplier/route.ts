import { z } from "zod";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import { applyCommand } from "@/domain/commands";
import { approvedRental } from "@/domain/payment-authority";
import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";
import { getShow, transactCommand } from "@/server/store";
import { paymentOverview } from "@/server/payment-service";
export const runtime = "nodejs";
const bodySchema = z.object({ idempotencyKey: z.string().uuid(), expectedRevision: z.number().int().positive(), planDigest: z.string().length(64), fact: z.enum(["supplier_confirmed", "return_accepted"]), detail: z.string().trim().min(12).max(1200) }).strict();
function requireSupplier(actor: Actor) { if (!actor.roles.includes("supplier") || !actor.id.startsWith("supplier:brightline:")) throw new DomainError("SUPPLIER_REQUIRED", "A Brightline-scoped supplier capability is required.", 403); }
async function projection(show: ShowSnapshot, actor: Actor) { const { offer, plan } = approvedRental(show); if (offer.supplierId !== "brightline") throw new DomainError("SUPPLIER_CHANGED", "The current recovery uses another supplier.", 403); return { revision: show.revision, planVersion: show.planVersion, planDigest: plan.digest, show: show.title, venue: show.venue, clock: show.clock, offer, facts: show.facts.filter(f => f.planVersion === show.planVersion && ["supplier_confirmed", "delivery_accepted", "return_accepted"].includes(f.kind)).map(({ actorId, ...fact }) => ({ ...fact, actor: actorId.split(":")[0] })), payments: await paymentOverview(actor) }; }
export async function GET(request: Request) { try { const actor = await requireActor(request); requireSupplier(actor); return Response.json(await projection(await getShow(actor.tenantId), actor), { headers: { "Cache-Control": "private, no-store" } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request); requireSupplier(actor);
    const raw = await request.text(); if (raw.length > 5000) throw new DomainError("REQUEST_TOO_LARGE", "This supplier instruction is too large.", 413);
    const parsed = bodySchema.safeParse(JSON.parse(raw)); if (!parsed.success) throw new DomainError("INVALID_SUPPLIER_ACTION", "Review the current supplier offer and confirmation.", 400);
    const input = parsed.data;
    const result = await transactCommand(actor, input.idempotencyKey, input.expectedRevision, input, show => { if (show.approvedPlan?.digest !== input.planDigest || approvedRental(show).offer.supplierId !== "brightline") throw new DomainError("STALE_SUPPLIER_OFFER", "The current approved supplier terms changed."); return applyCommand(show, actor, { type: "fact", kind: input.fact, detail: input.detail }); });
    return Response.json(await projection(result.show, actor), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
