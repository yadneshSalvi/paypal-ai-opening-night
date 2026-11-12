/** Owned, credential-free production build; avoid forwarding --env-file into Next child NODE_OPTIONS. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parse } from 'dotenv';
const approved = parse(readFileSync('.private/qa.env'));
const allowed = new Set(['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING', 'DIRECT_URL', 'JUDGE_SESSION_SECRET', 'BRYNTUM_LICENSE_KEY', 'APP_BASE_URL', 'SUPPLIER_SERVICE_BASE_URL', 'OPENING_NIGHT_AI_QA', 'OPENING_NIGHT_QA_FIXTURE', 'OPENING_NIGHT_SUPPLIER_RECOVERY_QA']);
if (Object.keys(approved).some(key => !allowed.has(key))) throw new Error('The build accepts only its explicitly approved local configuration fields');
const database = new URL(approved.DATABASE_URL ?? '');
if (database.hostname !== '127.0.0.1' || database.port !== '55575' || !/^\/opening_terms_[a-f0-9]{12}$/.test(database.pathname) || !approved.JUDGE_SESSION_SECRET || !approved.BRYNTUM_LICENSE_KEY) throw new Error('The owned non-provider build configuration is required');
const env = { ...process.env, ...approved, NEXT_TELEMETRY_DISABLED: '1', NEXT_FONT_GOOGLE_MOCKED_RESPONSES: resolve('.private/accepted-font-cache/responses.cjs'), NODE_OPTIONS: '--import=' + resolve('scripts/qa/supplier-recovery-disabled-providers.mjs') };
for (const key of Object.keys(env)) if (/OPENAI|GEMINI|PAYPAL|CHANNEL3|ANTHROPIC|BLOB_READ_WRITE_TOKEN|CRON_SECRET/.test(key)) env[key] = '';
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'build'], { cwd: process.cwd(), env, stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
