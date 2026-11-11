import { wrapEnvelopeSchema } from "@/domain/wrap/contracts";
import { assertSameOrigin } from "@/server/http";
import { wrapAuthority, wrapBody, wrapError, wrapJson } from "@/server/wrap/http";
import { executeWrap, readWrap } from "@/server/wrap/service";
export const runtime = "nodejs";
export async function GET(request: Request) { try { return wrapJson(await readWrap(await wrapAuthority(request, "production"))); } catch (error) { return wrapError(error); } }
export async function POST(request: Request) { try { assertSameOrigin(request); return wrapJson(await executeWrap(await wrapAuthority(request, "production"), await wrapBody(request, wrapEnvelopeSchema))); } catch (error) { return wrapError(error); } }
