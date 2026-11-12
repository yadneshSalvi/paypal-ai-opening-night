import './disabled-providers.mjs';
if (process.env.VERCEL) throw new Error('Tour fixture mode is local only');
process.env.OPENING_NIGHT_TOUR_QA = '1';
