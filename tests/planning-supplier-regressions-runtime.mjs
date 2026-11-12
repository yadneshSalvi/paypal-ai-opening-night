// Existing supplier tests intentionally use this metadata origin. Transport
// remains confined to the new planning database; no 4619 listener is contacted.
import '../scripts/qa/planning-final-runtime.mjs';
process.env.APP_BASE_URL='http://127.0.0.1:4619';
process.env.SUPPLIER_SERVICE_BASE_URL=process.env.APP_BASE_URL;
