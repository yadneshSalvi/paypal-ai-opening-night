import QRCode from "qrcode";
import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";
import { boundedJson } from "@/server/bounded-body";
import { deliveryOverview, issueDelivery } from "@/server/delivery-service";
import { checkoutOrigin } from "@/server/payment-service";
export const runtime = "nodejs";
const schema = z.object({ idempotencyKey: z.uuid(), expectedRevision: z.number().int().positive() }).strict();
export async function POST(request: Request, context: { params: Promise<{ execution: string }> }) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request); const execution = z.uuid().safeParse((await context.params).execution);
    if (!execution.success) throw new DomainError("EXECUTION_NOT_FOUND", "This rental execution is invalid.", 404);
    const parsed = schema.safeParse(await boundedJson(request, 1000)); if (!parsed.success) throw new DomainError("DELIVERY_ISSUE_INVALID", "Review the current reservation before issuing its handoff code.", 400);
    const issued = await issueDelivery(actor, execution.data, parsed.data.idempotencyKey, parsed.data.expectedRevision);
    const handoff = issued.token ? checkoutOrigin(request.url) + `/delivery/access?execution=${execution.data}#handoff=` + issued.token : null;
    const svg = handoff ? await QRCode.toString(handoff, { type: "svg", errorCorrectionLevel: "M", margin: 4, width: 380 }) : null;
    return Response.json({ data: await deliveryOverview(actor, execution.data), handoff, image: svg ? "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64") : null, recoveredWithoutCode: !issued.token }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
