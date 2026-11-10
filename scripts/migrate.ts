import { migrate, pool } from "../src/server/store";
await migrate(); console.log("Opening Night PostgreSQL schema ready."); await pool.end();
