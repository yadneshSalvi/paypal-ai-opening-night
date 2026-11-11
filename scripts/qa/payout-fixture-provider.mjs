import "./voice-source-fixture-provider.mjs";
import { resolve } from "node:path";
import { createPayoutWireFixture } from "./payout-wire-fixture.mjs";
if (process.env.VERCEL || process.env.OPENING_NIGHT_AI_QA !== "1" || ["OPENAI_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET"].some(key => process.env[key])) throw new Error("Payout fixture requires an isolated local provider-disabled process");
// The private fake-provider history survives a local process restart. It is not actual provider evidence.
globalThis.openingNightPayoutFixture = createPayoutWireFixture({ storePath: resolve(process.cwd(), "../controlled-payout-wire.private.json") });
