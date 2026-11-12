// Same installed SDK and immutable commerce services; only an explicitly supplied in-memory fetch is usable.
import "./audience-disabled-runtime.mjs";
if (globalThis.openingNightAudienceGuard?.version !== 1) throw new Error("Exact audience egress guard required");
process.env.OPENING_NIGHT_QA_FIXTURE = "";
process.env.OPENING_NIGHT_AUDIENCE_CONTROLLED_WIRE = "1";
