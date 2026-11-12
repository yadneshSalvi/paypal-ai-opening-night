import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { parse } from 'dotenv';
const file=new URL('../.private/local-only.env',import.meta.url);
assert.equal(statSync(file).mode&0o777,0o600);
const config=parse(readFileSync(file));
for(const key of ['DATABASE_URL','JUDGE_SESSION_SECRET','BRYNTUM_LICENSE_KEY','APP_BASE_URL']){assert.ok(config[key]);process.env[key]=config[key];}
const url=new URL(process.env.DATABASE_URL);
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55575');assert.equal(url.pathname,'/opening_planning_final');assert.equal(url.username,'opening_planning_final_app');
process.env.OPENING_NIGHT_MODEL_DATABASE='opening_planning_final';
process.env.OPENING_NIGHT_MODEL_ROLE='opening_planning_final_app';
process.env.OPENING_NIGHT_MODEL_TEST_PORT='55575';
process.env.OPENING_NIGHT_MODEL_GUARD_AUDIT=new URL('../.private/planning-workbench/transport',import.meta.url).pathname;
await import('../scripts/qa/model-controlled-runtime.mjs');
