/** Sequential partitions, at most three test files per PostgreSQL partition. */
import './tour-disabled-providers.mjs';
import 'dotenv/config';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const wire = ['cohort-work', 'commerce-api', 'durable-work', 'payment-wire', 'remedy-work', 'supplier-work', 'wallet-work'].map(value => `tests/${value}.test.ts`);
const database = new URL(process.env.DATABASE_URL);
if (database.hostname !== '127.0.0.1' || database.port !== '55556') throw new Error('Only the owned stage12 PostgreSQL cluster may run this partition');
const all = readdirSync('tests').filter(value => /\.test\.tsx?$/.test(value)).map(value => `tests/${value}`).sort();
const directory = `.artifacts/regression-${randomUUID()}`; mkdirSync(directory, { mode: 0o700 });
const results = [];
for (const [partition, preload, files] of [['product', './scripts/qa/native-test-runtime.mjs', all.filter(value => !wire.includes(value))], ['controlled-sdk', './scripts/qa/tour-controlled-wire-runtime.mjs', wire]]) {
  const startedAt = new Date().toISOString(), args = ['--import', preload, '--import', 'tsx', '--test', '--test-concurrency=3', ...files];
  let output = ''; const child = spawn(process.execPath, args, { env: process.env });
  child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  const code = await new Promise(resolve => { child.once('error', error => { output += error.stack; resolve(1); }); child.once('exit', resolve); });
  const count = label => Number(output.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))?.[1] ?? 0);
  writeFileSync(`${directory}/${partition}.log`, output, { flag: 'wx', mode: 0o600 });
  const result = { partition, startedAt, finishedAt: new Date().toISOString(), exitCode: code, files, fileConcurrency: 3, tests: count('tests'), passed: count('pass'), failed: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'), providerTransports: 'disabled', actualProviderCalls: false, log: `${directory}/${partition}.log` };
  results.push(result); console.log(JSON.stringify(result));
  writeFileSync(`${directory}/${partition}.json`, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (code !== 0 || !result.tests || result.failed || result.cancelled) { process.exitCode = 1; break; }
}
writeFileSync(`${directory}/summary.json`, JSON.stringify({ directory, results }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
