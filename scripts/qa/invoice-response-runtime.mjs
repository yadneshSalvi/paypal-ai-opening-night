import "./disabled-providers.mjs";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";

// This unit never uses the original invoice lane's database or credentials.
const values = dotenv.parse(readFileSync(new URL("../../.env", import.meta.url)));
const database = new URL(values.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(database.hostname) || database.port !== "55573" || !database.pathname.startsWith("/opening_retained_") || database.searchParams.has("options")) throw new Error("Invoice response tests require the isolated PG55573 database without a runtime search_path");
for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING", "DIRECT_URL"]) process.env[key] = database.href;
for (const key of ["JUDGE_SESSION_SECRET", "BRYNTUM_LICENSE_KEY", "APP_BASE_URL"]) process.env[key] = values[key] ?? "";
