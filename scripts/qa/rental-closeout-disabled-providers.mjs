import './disabled-providers.mjs';
if (process.env.VERCEL) throw new Error('Rental closeout QA is local only');
process.env.OPENING_NIGHT_RENTAL_CLOSEOUT_QA = '1';
process.env.APP_BASE_URL = 'http://127.0.0.1:4580';
process.env.SUPPLIER_SERVICE_BASE_URL = 'http://127.0.0.1:4580';
