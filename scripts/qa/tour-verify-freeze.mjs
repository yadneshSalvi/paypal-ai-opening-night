/** Read-only input verification. Does not connect to PostgreSQL or any provider. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const freeze = JSON.parse(fs.readFileSync('.artifacts/tour-native-4561/freeze.json', 'utf8'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex'), failures = [], counts = {};
for (const [file, expected] of Object.entries(freeze.protectedFiles)) if (sha(fs.readFileSync(file)) !== expected) failures.push(file);
for (const [name, descriptor] of Object.entries(freeze.manifests)) {
  const manifest = JSON.parse(fs.readFileSync(descriptor.file, 'utf8')), directory = name === 'source' ? '.' : name === 'build' ? '.next' : 'node_modules';
  if (sha(JSON.stringify(manifest.entries)) !== descriptor.digest) failures.push(`${name} manifest`);
  for (const entry of manifest.entries) {
    const file = path.join(directory, entry.path);
    try { const value = entry.type === 'symlink' ? fs.readlinkSync(file) : fs.readFileSync(file); if (sha(value) !== entry.sha256) failures.push(file); }
    catch { failures.push(file); }
  }
  if (name !== 'source') {
    const expected = new Set(manifest.entries.map(entry => entry.path));
    const walk = current => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name), relative = path.relative(directory, full);
        if (name === 'build' && (relative === 'cache' || relative.startsWith('cache/') || relative === 'trace' || relative.startsWith('trace-'))) continue;
        if (entry.isDirectory()) walk(full); else if (!expected.has(relative)) failures.push(`added:${full}`);
      }
    };
    walk(directory);
  }
  counts[name] = manifest.entries.length;
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
if (git('rev-parse', 'HEAD') !== freeze.commit || git('rev-parse', 'HEAD^{tree}') !== freeze.tree || git('status', '--porcelain')) failures.push('source Git state');
console.log(JSON.stringify({ at: new Date().toISOString(), commit: freeze.commit, buildId: freeze.buildId, counts, failures, databaseTouched: false, providerCalls: false }));
if (failures.length) process.exitCode = 1;
