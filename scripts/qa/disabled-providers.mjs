// Import before application env or Next. This is local fixture isolation, never a hosted mode.
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
if (process.env.VERCEL) throw new Error("Provider-disabled QA cannot run in a hosted environment");
for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "CHANNEL3_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET", "OPENING_NIGHT_PAYOUT_RECIPIENTS_JSON", "BLOB_READ_WRITE_TOKEN", "CRON_SECRET"]) process.env[key] = "";
for (const key of Object.keys(process.env)) if (/OPENAI|GEMINI|PAYPAL|CHANNEL3|ANTHROPIC|BLOB_READ_WRITE_TOKEN|CRON_SECRET/.test(key)) process.env[key] = "";
process.env.OPENING_NIGHT_AI_QA = "1";
process.env.OPENING_NIGHT_QA_FIXTURE = "1";
const actualFetch = globalThis.fetch;
const providerHost = /(^|\.)(openai\.com|paypal\.com|googleapis\.com|anthropic\.com|blob\.vercel-storage\.com)$/;
const isProviderHost = hostname => providerHost.test(hostname.toLowerCase().replace(/\.+$/, ""));
const blocked = () => { throw new Error("Actual provider transport is disabled in this QA process"); };
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (isProviderHost(url.hostname)) return blocked();
  return actualFetch(input, init);
};
// Axios/follow-redirects can use Node HTTP directly; a fetch-only block does not cover it.
function assertNodeTarget(input, options) {
  const values = [];
  for (const value of [input, options]) {
    if (typeof value === "string" || value instanceof URL) values.push(String(value));
    else if (value && typeof value === "object") {
      values.push(...[value.hostname, value.host, value.path, value.servername, value.headers?.host, value.headers?.Host].filter(item => typeof item === "string"));
      if (Array.isArray(value.headers)) for (let index = 0; index < value.headers.length - 1; index += 2) if (String(value.headers[index]).toLowerCase() === "host") values.push(String(value.headers[index + 1]));
    }
  }
  for (const value of values) {
    let hostname = value.split(":")[0]; try { if (/^https?:\/\//.test(value)) hostname = new URL(value).hostname; } catch { return blocked(); }
    if (isProviderHost(hostname)) return blocked();
  }
}
for (const client of [http, https]) for (const name of ["request", "get"]) {
  const original = client[name]; client[name] = function (input, options, ...rest) { assertNodeTarget(input, options); return Reflect.apply(original, this, [input, options, ...rest]); };
}
syncBuiltinESMExports();
globalThis.openingNightProviderEgressGuard = Object.freeze({ version: 2, fetch: true, nodeHttp: true, nodeHttps: true });
