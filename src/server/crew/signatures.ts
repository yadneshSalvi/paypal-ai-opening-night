import { createHmac, timingSafeEqual } from "node:crypto";
import { canonical } from "@/domain/hash";
import type { CrewRecord, CrewSigner, CrewVerifier, UnsignedCrewRecord } from "@/domain/crew/contracts";
import { env } from "../env";

// This module is imported by server entry points only. The context separates
// crew attestations from sessions, delivery QR signatures and supplier messages.
export function crewSignatureTools(secret: string): { sign: CrewSigner; verify: CrewVerifier } {
  const sign = (record: UnsignedCrewRecord) => createHmac("sha256", secret).update("opening-night:crew-record:v1\0").update(canonical(record)).digest("hex");
  return { sign, verify(record: CrewRecord) {
    if (!record || typeof record.signature !== "string" || !/^[a-f0-9]{64}$/.test(record.signature)) return false;
    const { signature, ...payload } = record;
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(sign(payload), "hex"));
  } };
}
export const signCrewRecord: CrewSigner = record => crewSignatureTools(env.sessionSecret).sign(record);
export const verifyCrewRecord: CrewVerifier = record => crewSignatureTools(env.sessionSecret).verify(record);
