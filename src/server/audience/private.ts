import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { DomainError } from "@/domain/contracts";
import { env } from "../env";

function key(tenantId: string) { return Buffer.from(hkdfSync("sha256", env.sessionSecret, tenantId, "opening-night/audience/v1", 32)); }
export function sealAudience(tenantId: string, purpose: string, value: unknown) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(tenantId), iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}
export function openAudience<T>(tenantId: string, purpose: string, envelope: string): T {
  try {
    if (envelope.length > 8_000_000) throw new Error("Audience record bound");
    const [version, iv, tag, body, extra] = envelope.split(".");
    if (version !== "v1" || !iv || !tag || !body || extra !== undefined) throw new Error("Audience envelope");
    const decipher = createDecipheriv("aes-256-gcm", key(tenantId), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(purpose)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8")) as T;
  } catch { throw new DomainError("AUDIENCE_RECORD_INTEGRITY", "The original private audience record could not be verified. Its retained history was preserved.", 503); }
}
