import test from "node:test";
import assert from "node:assert/strict";
import "../src/server/env";

test("crew imports need no merchant credentials, providers are reused per merchant, and controlled QA blocks every access", async () => {
  const names = ["PAYPAL_ENVIRONMENT", "PAYPAL_API_BASE_URL", "PAYPAL_PROJECT_ISOLATED", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET", "OPENING_NIGHT_QA_FIXTURE", "VERCEL"] as const;
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Network access is forbidden in the provider lifetime test."); };
  try {
    for (const name of names) delete process.env[name];
    process.env.PAYPAL_ENVIRONMENT = "sandbox";
    process.env.PAYPAL_API_BASE_URL = "https://api-m.sandbox.paypal.com";
    process.env.PAYPAL_PROJECT_ISOLATED = "true";
    const { providers } = await import("../src/server/paypal-providers");
    assert.equal(requests, 0);
    assert.throws(() => providers.venue, /Missing payment configuration/);

    process.env.OPENING_NIGHT_QA_FIXTURE = "1";
    const qaRejected = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "PROVIDER_QA_DISABLED" && "status" in error && error.status === 403);
    assert.throws(() => providers.venue, qaRejected);
    assert.throws(() => providers.brightline, qaRejected);

    delete process.env.OPENING_NIGHT_QA_FIXTURE;
    process.env.PAYPAL_CLIENT_ID = "controlled-venue-client";
    process.env.PAYPAL_CLIENT_SECRET = "controlled-venue-secret";
    process.env.OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID = "controlled-supplier-client";
    process.env.OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET = "controlled-supplier-secret";
    const venue = providers.venue, supplier = providers.brightline;
    assert.equal(providers.venue, venue);
    assert.equal(providers.brightline, supplier);
    assert.notEqual(venue, supplier);
    assert.notEqual(venue.client, supplier.client);
    assert.equal(requests, 0);

    for (const name of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET"]) delete process.env[name];
    process.env.OPENING_NIGHT_QA_FIXTURE = "1";
    assert.throws(() => providers.venue, qaRejected, "a cached merchant is also inaccessible in controlled QA");
    assert.throws(() => providers.brightline, qaRejected);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});
