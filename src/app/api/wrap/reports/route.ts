import { reportRequestSchema } from "@/domain/wrap/contracts";
import { assertSameOrigin } from "@/server/http";
import { wrapAuthority, wrapBody, wrapError, wrapJson } from "@/server/wrap/http";
import { sealWrapReport } from "@/server/wrap/reports";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) { try { assertSameOrigin(request); return wrapJson(await sealWrapReport(await wrapAuthority(request, "production"), await wrapBody(request, reportRequestSchema))); } catch (error) { return wrapError(error); } }
