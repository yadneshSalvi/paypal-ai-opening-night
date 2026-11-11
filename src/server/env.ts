import { config } from "dotenv";
import { existsSync } from "node:fs";
import { commerceLockDatabaseUrl } from "./database-connections";

// Local provisioning's .env is authoritative. Vercel supplies its own environment.
if (!process.env.VERCEL && existsSync(".env")) config({ path: ".env", override: true, quiet: true });
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing required configuration: ${name}`); return value; }
export const env = {
  get databaseUrl() { return required("DATABASE_URL"); },
  get commerceLockDatabaseUrl() { return commerceLockDatabaseUrl(process.env); },
  get sessionSecret() { return required("JUDGE_SESSION_SECRET"); },
  get bryntumLicense() { return process.env.BRYNTUM_LICENSE_KEY ?? ""; },
  get isProduction() { return Boolean(process.env.VERCEL); },
};
