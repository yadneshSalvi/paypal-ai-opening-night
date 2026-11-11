import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { boundedJson } from "../bounded-body";
export { settlementAuthority as wrapAuthority, settlementError as wrapError, settlementJson as wrapJson } from "../settlement/http";
export async function wrapBody<T>(request: Request, schema: z.ZodType<T>) { const parsed = schema.safeParse(await boundedJson(request, 32_000)); if (!parsed.success) throw new DomainError("WRAP_INVALID_REQUEST", "Review the complete account instructions and required confirmations.", 400); return parsed.data; }
