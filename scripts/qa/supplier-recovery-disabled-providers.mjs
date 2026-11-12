import './disabled-providers.mjs';
if (process.env.VERCEL) throw new Error('Supplier recovery QA is local only');
process.env.OPENING_NIGHT_SUPPLIER_RECOVERY_QA = '1';
process.env.APP_BASE_URL = 'http://127.0.0.1:4586';
process.env.SUPPLIER_SERVICE_BASE_URL = 'http://127.0.0.1:4586';
