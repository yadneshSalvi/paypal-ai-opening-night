import { z } from "zod";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import { applyCommand } from "@/domain/commands";
import { approvedRental } from "@/domain/payment-authority";
import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";
import { getShow, transactCommand } from "@/server/store";
import { paymentOverview } from "@/server/payment-service";
import { currentRentalExecution } from "@/domain/supplier-contracts";
import { supplierScope } from "@/server/supplier-storage";
import { callSupplierService } from "@/server/supplier-protocol";
import { boundedJson } from "@/server/bounded-body";
export const runtime = "nodejs";
const bodySchema = z.object({ idempotencyKey: z.string().uuid(), expectedRevision: z.number().int().positive(), planDigest: z.string().length(64), fact: z.enum(["supplier_confirmed", "return_accepted", "rejected_returned"]), detail: z.string().trim().min(12).max(1200) }).strict();
function requireSupplier(actor: Actor) { if (!actor.roles.includes("supplier") || !supplierScope(actor)) throw new DomainError("SUPPLIER_REQUIRED", "An enrolled supplier-scoped capability is required.", 403); }
async function projection(show: ShowSnapshot, actor: Actor) { const { offer, plan } = approvedRental(show); if (offer.supplierId !== supplierScope(actor)) throw new DomainError("SUPPLIER_CHANGED", "The current recovery uses another supplier.", 403); return { revision: show.revision, planVersion: show.planVersion, planDigest: plan.digest, show: show.title, venue: show.venue, clock: show.clock, offer, facts: show.facts.filter(f => f.planVersion === show.planVersion && ["supplier_confirmed", "delivery_accepted", "return_accepted"].includes(f.kind)).map(({ actorId, ...fact }) => ({ ...fact, actor: actorId.split(":")[0] })), payments: offer.supplierId === "brightline" ? await paymentOverview(actor) : [], execution: currentRentalExecution(show) ? { id: currentRentalExecution(show)!.id, state: currentRentalExecution(show)!.state, deliveryAt: currentRentalExecution(show)!.deliveryAt, acceptedAt: currentRentalExecution(show)!.acceptedAt, lastCode: currentRentalExecution(show)!.lastCode } : null, operatingMode: show.cancellationDecision?.mode ?? null, protocol: show.commercialProtocol ?? 1 }; }
export async function GET(request: Request) { try { const actor = await requireActor(request); requireSupplier(actor); return Response.json(await projection(await getShow(actor.tenantId), actor), { headers: { "Cache-Control": "private, no-store" } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request); requireSupplier(actor);
    const parsed = bodySchema.safeParse(await boundedJson(request, 5000)); if (!parsed.success) throw new DomainError("INVALID_SUPPLIER_ACTION", "Review the current supplier offer and confirmation.", 400);
    const input = parsed.data;
    const before = await getShow(actor.tenantId);
    if (before.commercialProtocol === 2) {
      const execution = currentRentalExecution(before);
      if (!execution || execution.supplierId !== supplierScope(actor) || before.approvedPlan?.digest !== input.planDigest) throw new DomainError("STALE_SUPPLIER_OFFER", "The current owned supplier execution changed.");
      // The enrolled service replays any saved legacy return receipt. Every new
      // accepted return is directed to the exact original-unit closeout review.
      await callSupplierService(execution.supplierId, { version: 1, requestId: input.idempotencyKey, tenantId: actor.tenantId, actorId: actor.id, action: input.fact === "supplier_confirmed" ? { type: "confirm", executionId: execution.id, expectedRevision: input.expectedRevision } : { type: input.fact === "rejected_returned" ? "return_rejected" : "return", executionId: execution.id, expectedRevision: input.expectedRevision, detail: input.detail } }, AbortSignal.timeout(20000));
      return Response.json(await projection(await getShow(actor.tenantId), actor), { headers: { "Cache-Control": "private, no-store" } });
    }
    if (input.fact === "rejected_returned") throw new DomainError("SIGNED_DELIVERY_REQUIRED", "A rejected return requires the signed delivery workflow.");
    const fact = input.fact;
    const result = await transactCommand(actor, input.idempotencyKey, input.expectedRevision, input, show => { if (show.approvedPlan?.digest !== input.planDigest || approvedRental(show).offer.supplierId !== "brightline") throw new DomainError("STALE_SUPPLIER_OFFER", "The current approved supplier terms changed."); return applyCommand(show, actor, { type: "fact", kind: fact, detail: input.detail }); });
    return Response.json(await projection(result.show, actor), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
