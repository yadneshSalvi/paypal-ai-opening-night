import { cookies } from "next/headers";
import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { boundedJson } from "@/server/bounded-body";
import { assertSameOrigin, errorResponse, requireActor, SESSION_COOKIE } from "@/server/http";
import { changeRehearsal, listRehearsals, rehearsalRequest } from "@/server/rehearsal-service";
import { env } from "@/server/env";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
function failure(error: unknown) { const response = errorResponse(error); response.headers.set("Cache-Control", "private, no-store"); return response; }
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    const query = z.object({ offset: z.coerce.number().int().min(0).max(50000).default(0) }).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) throw new DomainError("REHEARSAL_PAGE_REQUIRED", "Choose a valid saved-rehearsal page.", 400);
    return Response.json({ rehearsals: await listRehearsals(actor, query.data.offset) }, { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request);
    const parsed = rehearsalRequest.safeParse(await boundedJson(request, 2048));
    if (!parsed.success) throw new DomainError("REHEARSAL_REVIEW_REQUIRED", "Give the rehearsal a name and choose an action from this saved workspace.", 400);
    const result = await changeRehearsal(actor, parsed.data);
    if (result.token) (await cookies()).set(SESSION_COOKIE, result.token, { httpOnly: true, secure: env.isProduction, sameSite: "lax", path: "/", expires: new Date(result.expiresAt) });
    return Response.json({ selectedTenantId: result.tenantId, rehearsals: await listRehearsals(result.actor), replayed: result.replayed }, { headers, status: parsed.data.type === "create" && !result.replayed ? 201 : 200 });
  } catch (error) { return failure(error); }
}
