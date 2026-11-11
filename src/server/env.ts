import { config } from "dotenv";
import { existsSync } from "node:fs";
import { commerceLockDatabaseUrl } from "./database-connections";

// Local provisioning's .env is authoritative. Vercel supplies its own environment.
if (!process.env.VERCEL && existsSync(".env")) {
  if (process.env.OPENING_NIGHT_AI_QA === "1" || process.env.OPENING_NIGHT_QA_FIXTURE === "1") {
    // A QA preload must remain provider-disabled before and after dotenv runs.
    const parsed = config({ path: ".env", override: true, quiet: true, processEnv: {} }).parsed ?? {};
    for (const key of ["DATABASE_URL", "JUDGE_SESSION_SECRET", "BRYNTUM_LICENSE_KEY"]) if (parsed[key]) process.env[key] = parsed[key];
    for (const key of Object.keys(process.env)) if (/OPENAI|GEMINI|PAYPAL|CHANNEL3|ANTHROPIC|BLOB_READ_WRITE_TOKEN|CRON_SECRET/.test(key)) process.env[key] = "";
  } else config({ path: ".env", override: true, quiet: true });
}
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing required configuration: ${name}`); return value; }
export const env = {
  get databaseUrl() { return required("DATABASE_URL"); },
  get commerceLockDatabaseUrl() { return commerceLockDatabaseUrl(process.env); },
  get sessionSecret() { return required("JUDGE_SESSION_SECRET"); },
  get bryntumLicense() { return process.env.BRYNTUM_LICENSE_KEY ?? ""; },
  get isProduction() { return Boolean(process.env.VERCEL); },
  // Local qualification only. Hosted deployments cannot label actual records
  // as fixtures through this flag.
  get controlledQa() { return !process.env.VERCEL && process.env.OPENING_NIGHT_QA_FIXTURE === "1" && ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET"].every(key => !process.env[key]); },
};
