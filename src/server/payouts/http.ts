import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { boundedJson } from "../bounded-body";
export { settlementAuthority as payoutAuthority, settlementJson as payoutJson, settlementError as payoutError } from "../settlement/http";
export async function payoutBody<T>(request: Request, schema: z.ZodType<T>) {
  const value = schema.safeParse(await boundedJson(request, 20000));
  if (!value.success) throw new DomainError("INVALID_PAYOUT_COMMAND", "Review the exact recipient, liability and payout instruction before submitting.", 400);
  return value.data;
}
