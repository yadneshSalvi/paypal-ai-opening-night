// Tests inject the real installed SDK over an in-memory fetch. Actual provider egress remains blocked.
import './disruption-disabled-providers.mjs';
process.env.OPENING_NIGHT_QA_FIXTURE = '';
if (globalThis.openingNightProviderEgressGuard?.version !== 2) throw new Error('Provider egress guard required');
