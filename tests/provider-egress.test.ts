import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import https from "node:https";
test("provider-disabled preload blocks fetch, Node HTTP, HTTPS and Toolkit's real axios instance", async () => {
  assert.equal(process.env.OPENING_NIGHT_QA_FIXTURE, "1");
  for (const key of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPENAI_API_KEY", "GEMINI_API_KEY"]) assert.equal(process.env[key], "");
  for (const host of ["api.sandbox.paypal.com", "api-m.sandbox.paypal.com", "api.openai.com", "generativelanguage.googleapis.com"]) {
    assert.throws(() => fetch(`https://${host}/v1/blocked`), /disabled/);
    assert.throws(() => https.request(`https://${host}/v1/blocked`), /disabled/);
    assert.throws(() => http.request({ host: "proxy.invalid", path: `https://${host}/v1/blocked` }), /disabled/);
    assert.throws(() => fetch(new Request(`https://${host.toUpperCase()}./v1/blocked`)), /disabled/);
    assert.throws(() => https.request({ host: "127.0.0.1", servername: host + "." }), /disabled/);
    assert.throws(() => http.request({ host: "127.0.0.1", headers: ["Host", host.toUpperCase() + "."] }), /disabled/);
  }
  const require = createRequire(import.meta.url), toolkitRequire = createRequire(require.resolve("@paypal/agent-toolkit/openai")), axios = toolkitRequire("axios");
  await assert.rejects(axios.get("https://api.sandbox.paypal.com/v2/invoicing/invoices/never-dispatched", { proxy: false }), /disabled/);
});
