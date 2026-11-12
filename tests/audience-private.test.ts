import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openAudience, sealAudience } from "../src/server/audience/private";

test("recoverable invitation ciphertext is randomized and authenticated to its exact tenant and record purpose", () => {
  const tenant = randomUUID(), purpose = "audience:capability:" + randomUUID(), value = { note: "Explicit controlled cryptography input", key: "controlled-private-value-must-remain-encrypted" };
  const one = sealAudience(tenant, purpose, value), two = sealAudience(tenant, purpose, value);
  assert.notEqual(one, two); assert.equal(one.includes(value.key), false); assert.deepEqual(openAudience(tenant, purpose, one), value);
  for (const [otherTenant, otherPurpose] of [[randomUUID(), purpose], [tenant, purpose + "-other"], [tenant, "audience:draft:" + randomUUID()]]) assert.throws(() => openAudience(otherTenant!, otherPurpose!, one), { code: "AUDIENCE_RECORD_INTEGRITY", status: 503 });
});

test("truncated, altered and oversized private envelopes fail without disclosing plaintext or key material", () => {
  const tenant = randomUUID(), purpose = "audience-command:" + randomUUID(), secret = "controlled-private-test-value", envelope = sealAudience(tenant, purpose, { secret }), parts = envelope.split(".");
  const body = Buffer.from(parts[3]!, "base64url"); body[0] = body[0]! ^ 1;
  for (const corrupted of ["v0" + envelope.slice(2), envelope.slice(0, 30), [...parts.slice(0, 3), body.toString("base64url")].join("."), envelope + ".extra", "x".repeat(8_000_001)]) {
    assert.throws(() => openAudience(tenant, purpose, corrupted), (error: unknown) => { assert.ok(error instanceof Error); assert.equal(error.message.includes(secret), false); assert.match(error.message, /retained history was preserved/); return (error as Error & { code?: string }).code === "AUDIENCE_RECORD_INTEGRITY"; });
  }
});
