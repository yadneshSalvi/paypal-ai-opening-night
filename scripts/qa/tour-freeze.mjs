/** Freeze a clean local candidate after validation; every output is create-once. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
const root = process.cwd(), output = '.artifacts/tour-native-4561';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
if (git('status', '--porcelain')) throw new Error('The candidate source must be committed and clean');
const validation = json('.artifacts/zoom-status-validation.json');
if (validation.tour.passed !== 95 || validation.tour.tests !== 95 || validation.tour.failed || validation.tour.exitCode !== 0 || validation.http.passed !== 16 || validation.http.failed || !validation.http.nativeFixturePreserved || !validation.build.success || !validation.typecheck.success || !validation.packages.success) throw new Error('Required bounded validation has not passed');
if (validation.commit !== git('rev-parse', 'HEAD')) throw new Error('Validation must identify this exact committed source');
const baseline = json(`${output}/native-baseline-at-freeze.json`), fixture = json(`${output}/fixture.json`);
if (fixture.state !== 'ready' || sha(fs.readFileSync(`${output}/fixture.json`)) !== baseline.fixtureSha256) throw new Error('The ready fixture changed after its baseline');
function manifest(folder, exclude = () => false) {
  const entries = [];
  function walk(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(directory, item.name), relative = path.relative(folder, full);
      if (exclude(relative)) continue;
      if (item.isDirectory()) walk(full);
      else if (item.isSymbolicLink()) {
        const target = fs.readlinkSync(full), resolved = fs.realpathSync(full);
        if (path.relative(root, resolved).startsWith('..')) throw new Error('A dependency link leaves the owned checkout');
        entries.push({ path: relative, type: 'symlink', target, sha256: sha(target) });
      } else if (item.isFile()) { const value = fs.readFileSync(full); entries.push({ path: relative, bytes: value.length, sha256: sha(value) }); }
    }
  }
  walk(folder); return { entries, digest: sha(JSON.stringify(entries)) };
}
const dependencies = manifest('node_modules');
const build = manifest('.next', value => value === 'cache' || value.startsWith('cache/') || value === 'trace' || value.startsWith('trace-'));
const sourceEntries = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean).sort().map(file => ({ path: file, bytes: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) }));
const source = { entries: sourceEntries, digest: sha(JSON.stringify(sourceEntries)) };
const traces = build.entries.filter(value => value.path.endsWith('.nft.json')), privatePaths = [];
for (const entry of traces) for (const file of json(path.join('.next', entry.path)).files ?? []) if (/(^|\/)\.env($|\.)|(^|\/)\.artifacts\/|(^|\/)plans\//.test(file)) privatePaths.push({ trace: entry.path, file });
if (privatePaths.length) throw new Error('A private input leaked into a deployment trace');
const env = parse(fs.readFileSync('.env')), credentials = json('.artifacts/tour-postgres/credentials.json');
const privateValues = [env.DATABASE_URL, new URL(env.DATABASE_URL).password, env.JUDGE_SESSION_SECRET, credentials.adminPassword, credentials.appPassword, fixture.bootstrapKey, fixture.producer.token, fixture.other.token, ...Object.values(fixture.crew).map(value => value.token)].filter(value => value?.length >= 16);
const secretLeaks = [];
for (const entry of build.entries.filter(value => value.type !== 'symlink')) {
  const contents = fs.readFileSync(path.join('.next', entry.path));
  if (privateValues.some(value => contents.includes(Buffer.from(value)))) secretLeaks.push(entry.path);
}
if (secretLeaks.length) throw new Error(`Private runtime material reached build files: ${secretLeaks.join(', ')}`);
for (const [name, value] of [['source', source], ['dependencies', dependencies], ['build', build]]) save(`${output}/${name}-manifest.json`, value);
const protectedFiles = ['package.json', 'package-lock.json', '.env', `${output}/fixture.json`, `${output}/public-summary.json`, `${output}/native-baseline-at-freeze.json`, '.artifacts/tour-postgres/intent-at-first-startup-failure.json', '.artifacts/zoom-status-failures.json', '.artifacts/zoom-status-validation.json'];
const frozen = {
  state: 'frozen_for_root_native_review', frozenAt: new Date().toISOString(), root,
  baseCommit: '8b3c0ebcac2ea831ddf97674fb08d71f8efa9c72', commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
  buildId: fs.readFileSync('.next/BUILD_ID', 'utf8').trim(), node: process.version, npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
  manifests: Object.fromEntries([['source', source], ['dependencies', dependencies], ['build', build]].map(([name, value]) => [name, { file: `${output}/${name}-manifest.json`, entries: value.entries.length, digest: value.digest }])),
  protectedFiles: Object.fromEntries(protectedFiles.map(file => [file, sha(fs.readFileSync(file))])),
  traceAudit: { files: traces.length, privatePaths, exclusions: ['.next/cache/**', '.next/trace', '.next/trace-*'] },
  buildPrivacy: { regularFiles: build.entries.filter(value => value.type !== 'symlink').length, privateValuesChecked: privateValues.length, secretLeaks },
  validation, failureRegister: '.artifacts/zoom-status-failures.json',
  preservation: '../tour-zoom-status-stage13/preserved-inputs-final.json',
  inheritedFreeze: '../tour-native-repair-work-4558/.artifacts/tour-native-4558-r2/freeze.json',
  inheritedNativeReview: '../tour-root-native-stage12/REVIEW.md',
  server: { origin: 'http://127.0.0.1:4561', startup: 'node scripts/qa/tour-review-server.mjs', cookie: fixture.cookie, pgPort: 55560, database: fixture.database, schema: fixture.schema, providerTransports: 'disabled' },
  nativeFixture: `${output}/fixture.json`, originalExpiry: fixture.producer.expiresAt,
  baseline: `${output}/native-baseline-at-freeze.json`,
  remaining: ['root native browser acceptance of synchronized zoom and command notice sequences', 'actual model/provider and financial qualification', 'hosted migration, integration, promotion and deployment', 'supplier interruption and cancellation', 'larger evaluations', 'inherited dependency remediation and cold installation', 'real-phone/research evidence or disclosed absence', 'film'],
  authority: 'Independent local candidate only. No old runtime/database, main, actual provider, push or deployment was changed.',
};
save(`${output}/freeze.json`, frozen);
console.log(JSON.stringify({ state: frozen.state, commit: frozen.commit, buildId: frozen.buildId, sourceFiles: source.entries.length, buildFiles: build.entries.length, dependencyEntries: dependencies.entries.length, traceFiles: traces.length, privateTracePaths: 0, freeze: `${output}/freeze.json` }));
