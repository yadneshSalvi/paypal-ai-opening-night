import { runJobTick } from "../src/server/job-runner";
import { pool } from "../src/server/store";
import { closeCommerceLocks } from "../src/server/commerce-storage";

// A single bounded invocation. A deployment scheduler owns repetition and availability.
try { const result = await runJobTick(); console.log(JSON.stringify({ processed: result.processed, outcomes: result.results.map(item => ({ kind: item.kind, status: item.status })) })); }
finally { await closeCommerceLocks(); await pool.end(); }
