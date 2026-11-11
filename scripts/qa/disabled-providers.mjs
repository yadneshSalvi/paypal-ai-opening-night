// Import before application env or Next. This is local fixture isolation, never a hosted mode.
if (process.env.VERCEL) throw new Error("Provider-disabled QA cannot run in a hosted environment");
for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "CHANNEL3_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET", "BLOB_READ_WRITE_TOKEN", "CRON_SECRET"]) process.env[key] = "";
for (const key of Object.keys(process.env)) if (/OPENAI|GEMINI|PAYPAL|CHANNEL3|ANTHROPIC|BLOB_READ_WRITE_TOKEN|CRON_SECRET/.test(key)) process.env[key] = "";
process.env.OPENING_NIGHT_AI_QA = "1";
process.env.OPENING_NIGHT_QA_FIXTURE = "1";
const actualFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (/(^|\.)(openai\.com|paypal\.com|googleapis\.com|anthropic\.com|blob\.vercel-storage\.com)$/.test(url.hostname)) throw new Error("Actual provider transport is disabled in this QA process");
  return actualFetch(input, init);
};
