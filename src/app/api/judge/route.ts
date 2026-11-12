import { cookies } from "next/headers";
import { after } from "next/server";
import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { JUDGE_BEAT_IDS } from "@/domain/judge/contracts";
import { boundedJson } from "@/server/bounded-body";
import { env } from "@/server/env";
import { assertSameOrigin, currentActor, errorResponse, requireActor, SESSION_COOKIE } from "@/server/http";
import { advanceDemonstration, prepareSoldTickets, startDemonstration } from "@/server/judge/director";
import { judgeView } from "@/server/judge/view";
import { sessionTokenHash } from "@/server/session-records";

export const runtime = "nodejs";
// One advance call is budgeted to about 18 seconds of work and is resumable; this leaves room for a slow database.
export const maxDuration = 60;

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("reset") }).strict(),
  z.object({ action: z.literal("advance"), beatId: z.enum(JUDGE_BEAT_IDS), idempotencyKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9._:-]+$/) }).strict(),
]);
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try { return Response.json(await judgeView(await currentActor(), new URL(request.url).origin), { headers }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const origin = assertSameOrigin(request);
    const parsed = requestSchema.safeParse(await boundedJson(request, 2000));
    if (!parsed.success) throw new DomainError("INVALID_JUDGE_REQUEST", "This request does not match the guided demonstration contract.", 400);
    const jar = await cookies();
    if (parsed.data.action === "advance") {
      const actor = await requireActor(request), token = jar.get(SESSION_COOKIE)?.value;
      if (!token || request.headers.get("authorization")) throw new DomainError("PRODUCER_REQUIRED", "The guided demonstration belongs to its producer session.", 403);
      await advanceDemonstration({ actor, sessionHash: sessionTokenHash(token) }, parsed.data.beatId, parsed.data.idempotencyKey, origin);
      return Response.json(await judgeView(actor, origin), { headers });
    }
    // start and reset both mint a NEW private demonstration and switch this browser to it. Nothing earlier is deleted or changed.
    if (parsed.data.action === "reset") await requireActor(request);
    const created = await startDemonstration(jar.get(SESSION_COOKIE)?.value);
    jar.set(SESSION_COOKIE, created.token, { httpOnly: true, secure: env.isProduction, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7 });
    // The 80 replayed ticket captures start after this response; a judge's first advance resumes whatever remains.
    after(() => prepareSoldTickets({ actor: created.actor, sessionHash: sessionTokenHash(created.token) }, origin));
    return Response.json(await judgeView(created.actor, origin), { headers });
  } catch (error) { return errorResponse(error); }
}
