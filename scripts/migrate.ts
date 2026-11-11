import { migrate, pool } from "../src/server/store";
import { paymentStore } from "../src/server/payment-store";
try { await migrate(); await paymentStore(); console.log("Opening Night production, durable-work and payment schemas ready."); }
finally { await pool.end(); }
