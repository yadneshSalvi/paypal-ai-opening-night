import './disabled-providers.mjs';
if (process.env.VERCEL) throw new Error('Disruption QA is local only');
process.env.OPENING_NIGHT_DISRUPTION_QA = '1';
process.env.APP_BASE_URL = 'http://127.0.0.1:4564';
process.env.SUPPLIER_SERVICE_BASE_URL = 'http://127.0.0.1:4564';
