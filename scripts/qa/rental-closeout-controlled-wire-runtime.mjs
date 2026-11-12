// Real installed SDK with a controlled transport; actual provider egress stays blocked.
import './rental-closeout-disabled-providers.mjs';
process.env.OPENING_NIGHT_QA_FIXTURE = '';
if (globalThis.openingNightProviderEgressGuard?.version !== 2) throw new Error('Provider egress guard required');
