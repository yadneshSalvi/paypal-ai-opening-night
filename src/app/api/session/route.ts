import { cookies } from "next/headers";
import { createSession } from "@/server/store";
import { assertSameOrigin, consoleData, errorResponse, SESSION_COOKIE } from "@/server/http";
import { env } from "@/server/env";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const jar = await cookies();
    const session = await createSession(jar.get(SESSION_COOKIE)?.value);
    if (!session.reused) jar.set(SESSION_COOKIE, session.token, { httpOnly: true, secure: env.isProduction, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7 });
    return Response.json(consoleData(session.show, session.actor), { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return errorResponse(e); }
}
