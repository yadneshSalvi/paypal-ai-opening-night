import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { digest } from "@/domain/hash";
import type { SupplierQuote } from "@/domain/supplier-contracts";
import type { NegotiationDecline } from "@/domain/supplier-admin/contracts";
const bytes = (purpose: string, value: unknown) => Buffer.from(`opening-night:supplier-admin:${purpose}:v1:${digest(value)}`);
export function generateSupplierKey() {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { publicKey, privateKey, fingerprint: digest({ algorithm: "Ed25519", publicKey }) };
}
export function signManagedQuote(content: Omit<SupplierQuote, "signature">, privateKey: string): SupplierQuote { return { ...content, signature: sign(null, bytes("quote", content), privateKey).toString("base64url") }; }
export function verifyManagedQuoteSignature(quote: SupplierQuote) {
  try {
    const { signature, ...content } = quote, { termsDigest, ...terms } = content;
    const source = quote.adminSource;
    if (!source || source.supplierId !== quote.supplierId || digest(terms) !== termsDigest || digest({ algorithm: "Ed25519", publicKey: source.publicKey }) !== source.keyFingerprint || !/^[A-Za-z0-9_-]{86}$/.test(signature) || source.publicKey.length > 120) return false;
    return verify(null, bytes("quote", content), createPublicKey({ key: Buffer.from(source.publicKey, "base64url"), type: "spki", format: "der" }), Buffer.from(signature, "base64url"));
  } catch { return false; }
}
export function signManagedDecline(content: Omit<NegotiationDecline, "signature">, privateKey: string): NegotiationDecline { return { ...content, signature: sign(null, bytes("decline", content), privateKey).toString("base64url") }; }
export function verifyManagedDecline(decline: NegotiationDecline) {
  try { const { signature, ...content } = decline; return verify(null, bytes("decline", content), createPublicKey({ key: Buffer.from(decline.source.publicKey, "base64url"), type: "spki", format: "der" }), Buffer.from(signature, "base64url")); } catch { return false; }
}
