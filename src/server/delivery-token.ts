import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { supplierIds } from "@/domain/supplier-contracts";
import { env } from "./env";

const tokenSchema = z.object({ v: z.literal(1), tenantId: z.uuid(), executionId: z.uuid(), deliveryId: z.uuid(), supplierId: z.enum(supplierIds), unitId: z.string().min(1).max(100), planVersion: z.number().int().positive(), planDigest: z.string().regex(/^[a-f0-9]{64}$/), version: z.number().int().positive(), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.iso.datetime() }).strict();
export type DeliveryToken = z.infer<typeof tokenSchema>;
function sign(payload: string) { return createHmac("sha256", env.sessionSecret).update("opening-night:delivery:v1:" + payload).digest("base64url"); }
export const deliveryNonceHash = (nonce: string) => createHash("sha256").update(nonce).digest("hex");
export function issueDeliveryToken(input: Omit<DeliveryToken, "v" | "nonce">) {
  const content: DeliveryToken = { v: 1, ...input, nonce: randomBytes(32).toString("base64url") };
  tokenSchema.parse(content);
  const payload = Buffer.from(JSON.stringify(content)).toString("base64url");
  return { token: payload + "." + sign(payload), content, nonceHash: deliveryNonceHash(content.nonce) };
}
export function verifyDeliveryToken(token: string, now = Date.now()): DeliveryToken {
  const invalid = () => new DomainError("DELIVERY_QR_INVALID", "This handoff code is invalid, changed or expired. Ask the supplier for its current code.", 403);
  if (token.length > 1800 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
  const [payload, actual] = token.split("."); const expected = sign(payload!);
  if (!timingSafeEqual(Buffer.from(actual!), Buffer.from(expected))) throw invalid();
  let parsed: z.ZodSafeParseResult<DeliveryToken>;
  try { parsed = tokenSchema.safeParse(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))); } catch { throw invalid(); }
  if (!parsed.success || Date.parse(parsed.data.expiresAt) <= now) throw invalid();
  return parsed.data;
}
