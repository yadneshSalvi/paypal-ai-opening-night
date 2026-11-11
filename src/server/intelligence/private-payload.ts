import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { env } from "../env";

/** A different derived key and authenticated context for every tenant and record. */
function key(tenantId: string) { return Buffer.from(hkdfSync("sha256", env.sessionSecret, tenantId, "opening-night/intelligence/v1", 32)); }
export function sealIntelligence(tenantId: string, context: string, value: unknown): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(tenantId), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
export function openIntelligence<T>(tenantId: string, context: string, envelope: string): T {
  const [version, iv, tag, content, extra] = envelope.split(".");
  if (version !== "v1" || !iv || !tag || !content || extra !== undefined) throw new Error("Invalid private planning envelope");
  const decipher = createDecipheriv("aes-256-gcm", key(tenantId), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(content, "base64url")), decipher.final()]).toString("utf8")) as T;
}
