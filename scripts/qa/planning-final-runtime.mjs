// New owned database only. Existing installed SDKs receive explicit in-memory
// transports; all actual external transports remain blocked by the first guard.
import '../../tests/planning-workbench-runtime.mjs';
import './disabled-providers.mjs';
if (!globalThis.openingNightModelControlledGuard || globalThis.openingNightProviderEgressGuard?.version !== 2) throw new Error('Both local transport guards are required');
process.env.OPENING_NIGHT_QA_FIXTURE = '';
process.env.OPENING_NIGHT_SUPPLIER_ADMIN_QA = '1';
process.env.APP_BASE_URL = 'http://127.0.0.1:4623';
process.env.SUPPLIER_SERVICE_BASE_URL = process.env.APP_BASE_URL;
