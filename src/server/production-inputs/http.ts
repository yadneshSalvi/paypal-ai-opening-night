import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { inputEnvelopeSchema } from "@/domain/production-inputs/contracts";
import { boundedJson } from "../bounded-body";
import { errorResponse } from "../http";
export function inputJson(value: unknown) { return Response.json(value, { headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } }); }
export function inputError(error: unknown) { const response = errorResponse(error); response.headers.set("Cache-Control", "private, no-store"); response.headers.set("Referrer-Policy", "no-referrer"); return response; }
export async function inputBody(request: Request) {
  const parsed = inputEnvelopeSchema.safeParse(await boundedJson(request, 250000));
  if (!parsed.success) throw new DomainError("INVALID_INPUT_COMMAND", "Review the typed fields, exact source quotations and separate confirmations before sending this instruction.", 400);
  return parsed.data;
}
export function inputQuery(request: Request) {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== "commandId") || query.getAll("commandId").length > 1) throw new DomainError("INPUT_QUERY", "Read this workspace or one original command identity.", 400);
  const commandId = query.get("commandId");
  if (commandId !== null && !z.uuid().safeParse(commandId).success) throw new DomainError("INPUT_COMMAND_ID", "Use the original command identity.", 400);
  return commandId;
}
