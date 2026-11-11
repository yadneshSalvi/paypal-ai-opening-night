import { runJobTick } from "../src/server/job-runner";
import { pool } from "../src/server/store";

// A single bounded invocation. A deployment scheduler owns repetition and availability.
try { const result = await runJobTick(); console.log(JSON.stringify({ processed: result.processed, outcomes: result.results.map(item => ({ kind: item.kind, status: item.status })) })); }
finally { await pool.end(); }
