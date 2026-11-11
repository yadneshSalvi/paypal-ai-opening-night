import { Pool } from "pg";
import "../../src/server/env";
const schema = process.argv[2]; const tenantId = process.argv[3];
if (!schema || !/^on_test_[a-f0-9]{32}$/.test(schema) || !tenantId) throw new Error("An isolated worker fixture schema and tenant are required");
const connectionString = process.env.DATABASE_URL;
if (!connectionString || !["localhost", "127.0.0.1"].includes(new URL(connectionString).hostname)) throw new Error("Worker fixtures only run on local PostgreSQL");
const pool = new Pool({ connectionString, options: "-c search_path=" + schema, max: 1 });
(globalThis as typeof globalThis & { openingNightPool?: Pool }).openingNightPool = pool;
const { claimJob } = await import("../../src/server/jobs");
const claimed = await claimJob(tenantId);
process.stdout.write(JSON.stringify(claimed) + "\n");
// The parent kills this owned test process immediately after the durable claim.
setInterval(() => {}, 1000);
