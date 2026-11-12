// Injected in-memory SDK transports only; actual fetch/HTTP/HTTPS egress stays blocked.
import './tour-disabled-providers.mjs';
process.env.OPENING_NIGHT_QA_FIXTURE = '';
if (globalThis.openingNightProviderEgressGuard?.version !== 2 || process.env.OPENING_NIGHT_AI_QA !== '1') throw new Error('Provider transport guard required');
