import { z } from "zod";
import { assertSameOrigin } from "@/server/http";
import { wrapAuthority, wrapBody, wrapError, wrapJson } from "@/server/wrap/http";
import { readInvoiceReview } from "@/server/wrap/service";
export const runtime = "nodejs";
export async function POST(request: Request) { try { assertSameOrigin(request); const authority = await wrapAuthority(request, "production"), value = await wrapBody(request, z.object({ invoiceId: z.uuid(), operation: z.enum(["create", "send", "cancel"]) }).strict()); return wrapJson(await readInvoiceReview(authority, value.invoiceId, value.operation)); } catch (error) { return wrapError(error); } }
