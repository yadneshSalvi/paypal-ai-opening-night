import { toolkitRequestSchema } from "@/domain/wrap/contracts";
import { assertSameOrigin } from "@/server/http";
import { wrapAuthority, wrapBody, wrapError, wrapJson } from "@/server/wrap/http";
import { executeToolkit } from "@/server/wrap/toolkit";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) { try { assertSameOrigin(request); return wrapJson(await executeToolkit(await wrapAuthority(request, "production"), await wrapBody(request, toolkitRequestSchema))); } catch (error) { return wrapError(error); } }
