// Installed SDK plus explicitly supplied controlled transport; actual providers stay blocked.
import './supplier-recovery-disabled-providers.mjs';
process.env.OPENING_NIGHT_QA_FIXTURE = '';
if (globalThis.openingNightProviderEgressGuard?.version !== 2) throw new Error('Provider egress guard required');
