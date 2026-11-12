// Reuse the strict transport guard with only this unit's separately provisioned DB identity.
import assert from 'node:assert/strict';
const database=process.env.OPENING_NIGHT_N5_DATABASE,role=process.env.OPENING_NIGHT_N5_ROLE,port=process.env.OPENING_NIGHT_N5_PORT;
assert.match(database??'',/^opening_n5_[a-f0-9]{12}$/);
assert.match(role??'',/^n5_app_[a-f0-9]{12}$/);
assert.equal(port,'55575');
process.env.OPENING_NIGHT_MODEL_DATABASE=database;
process.env.OPENING_NIGHT_MODEL_ROLE=role;
process.env.OPENING_NIGHT_MODEL_TEST_PORT=port;
await import('./model-controlled-runtime.mjs');
