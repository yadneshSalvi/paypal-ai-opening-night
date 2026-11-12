/** Exact source, installed dependencies, production bytes and private trace closure. No publication. */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { audienceProductionInputs, audienceSha256 } from "./audience-inputs.mjs";
import { selectedAudienceFixture } from "./audience-fixture.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, ""), base = "ae0980851e3aac49470e052af8c468b9bf4c94f6", destination = ".artifacts/audience-stage17/freeze.json";
if (process.cwd() !== root || execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim() !== root || process.env.VERCEL) throw new Error("Use the isolated local audience checkout");
const git = (...args) => execFileSync("git", ["-C", root, ...args], { cwd: root, encoding: "utf8" }).trim();
async function fileHash(path) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function inventory(directory, kind) {
  const records = [];
  async function walk(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const full = resolve(path, item.name), name = relative(root, full);
      if (kind === "build" && (name.startsWith(".next/cache/") || [".next/cache", ".next/trace", ".next/trace-build", ".next/lock"].includes(name) || name.startsWith(".next/diagnostics/"))) continue;
      if (item.isSymbolicLink()) {
        const target = await readlink(full), resolved = await realpath(full);
        if (!resolved.startsWith(root + "/node_modules/")) throw new Error("A frozen dependency link escapes this isolated checkout");
        records.push({ path: name, kind: "symlink", target, sha256: audienceSha256(target) }); continue;
      }
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) { const before = await lstat(full), sha256 = await fileHash(full), after = await lstat(full); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("A frozen input changed while being read"); records.push({ path: name, kind: "file", bytes: before.size, sha256 }); }
    }
  }
  await walk(resolve(root, directory)); return records.sort((a, b) => a.path.localeCompare(b.path));
}
async function verify(records) { for (const record of records) { const full = resolve(root, record.path); if (!full.startsWith(root + "/")) throw new Error("Unexpected frozen input path"); if (record.kind === "symlink") { assert.equal(await readlink(full), record.target); assert.equal(audienceSha256(await readlink(full)), record.sha256); } else { assert.equal((await lstat(full)).size, record.bytes); assert.equal(await fileHash(full), record.sha256); } } }
if (process.argv.includes("--verify")) {
  const frozen = JSON.parse(await readFile(destination, "utf8")); assert.equal(git("rev-parse", "HEAD"), frozen.commit);
  await verify(JSON.parse(await readFile(frozen.sourceManifest, "utf8")).records); await verify(JSON.parse(await readFile(frozen.dependencyManifest, "utf8")).records); await verify(JSON.parse(await readFile(frozen.buildManifest, "utf8")).records);
  console.log(JSON.stringify({ state: "verified", commit: frozen.commit, sourceHash: frozen.sourceHash, dependencyHash: frozen.dependencyHash, buildHash: frozen.buildHash })); process.exit(0);
}
assert.equal(git("status", "--porcelain"), "", "Commit the exact reviewed source before freezing");
const commit = git("rev-parse", "HEAD"); assert.equal(git("rev-parse", "HEAD^"), base);
const changed = git("diff", "--name-only", base, "HEAD").split("\n").filter(Boolean);
const owned = path => ["package.json", "src/server/store.ts", "tests/settlement-store.test.ts"].includes(path) || /^(src\/domain\/audience\/|src\/server\/audience\/|src\/components\/audience\/|src\/app\/audience\/|src\/app\/attendee\/|src\/app\/api\/audience\/|src\/app\/api\/attendee\/|src\/server\/migrations\/audience-v17\.ts$|scripts\/qa\/audience-|tests\/audience-|docs\/AUDIENCE|public\/audience\/fonts\/)/.test(path);
assert.ok(changed.length); assert.ok(changed.every(owned), "An unrelated source path is outside this unit");
const originalPackage = JSON.parse(execFileSync("git", ["-C", root, "show", base + ":package.json"], { cwd: root, encoding: "utf8" })), actualPackage = JSON.parse(await readFile("package.json", "utf8"));
for (const key of Object.keys(originalPackage).filter(key => key !== "scripts")) assert.deepEqual(actualPackage[key], originalPackage[key]);
for (const [name, value] of Object.entries(originalPackage.scripts)) assert.equal(actualPackage.scripts[name], value);
assert.ok(Object.keys(actualPackage.scripts).filter(name => !(name in originalPackage.scripts)).every(name => name === "test:audience" || name.startsWith("qa:audience:")));
const rootLock = await readFile("package-lock.json"), oldLock = execFileSync("git", ["-C", root, "show", base + ":package-lock.json"], { cwd: root, maxBuffer: 20_000_000 }); assert.equal(audienceSha256(rootLock), audienceSha256(oldLock));
const originalStore = execFileSync("git", ["-C", root, "show", base + ":src/server/store.ts"], { cwd: root, encoding: "utf8" });
const store = (await readFile("src/server/store.ts", "utf8")).replace('import { audienceMigration } from "./migrations/audience-v17";\n', "").replace('      const audience = await client.query("SELECT version FROM on_schema_migrations WHERE version=17");\n      if (!audience.rowCount) { await client.query(audienceMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(17)"); }\n', ""); assert.equal(store, originalStore);
const oldSettlement = execFileSync("git", ["-C", root, "show", base + ":tests/settlement-store.test.ts"], { cwd: root, encoding: "utf8" }); assert.equal(await readFile("tests/settlement-store.test.ts", "utf8"), oldSettlement.replace('rows[0].version, 16);', 'rows[0].version, 17);'));
const production = await audienceProductionInputs(root), build = JSON.parse(await readFile(".artifacts/audience-stage17/qualified-build.json", "utf8")), regressions = JSON.parse(await readFile(".artifacts/audience-stage17/qualified-regressions.json", "utf8")), http = JSON.parse(await readFile(".artifacts/audience-http-4594/qualification/result.json", "utf8")), selectedNative = await selectedAudienceFixture("native"), native = selectedNative.fixture;
assert.equal(build.state, "qualified"); assert.equal(build.inputHash, production.digest); assert.ok(["qualified", "qualified_reconciled"].includes(regressions.state)); assert.equal(regressions.sourceInputDigest, production.digest); assert.equal(http.state, "qualified"); assert.equal(http.passed, http.expectations); assert.equal(http.sourceInputDigest, production.digest); assert.equal(native.state, "ready"); assert.equal(native.sourceInputDigest, production.digest);
const stressReports = []; for (const name of await readdir(".artifacts/audience-stage17")) if (name.startsWith("stress-")) { const report = await readFile(".artifacts/audience-stage17/" + name + "/report.json", "utf8").catch(() => null); if (report) stressReports.push(JSON.parse(report)); }
const stress = stressReports.find(value => value.state === "qualified" && value.sourceInputDigest === production.digest && value.declaredTickets === 400 && value.committedInboxReceipts === 400 && value.independentlyReadPrivateInboxes === 400 && value.completedPasses === 40); assert.ok(stress, "An exact400-recipient controlled service measurement is required");
const directory = ".artifacts/audience-stage17/freeze-" + randomUUID(); await mkdir(directory, { mode: 0o700 });
const sourcePaths = [...new Set(git("ls-files", "-z").split("\0").filter(Boolean))].sort(), source = [];
for (const path of sourcePaths) { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Frozen source contains a non-regular input"); source.push({ path, kind: "file", bytes: stat.size, sha256: await fileHash(path) }); }
const dependencies = await inventory("node_modules", "dependency"), buildInputs = await inventory(".next", "build");
const secrets = [];
for (const line of (await readFile(".private/audience-stage17/runtime.env", "utf8")).split("\n")) if (/^(DATABASE_URL|JUDGE_SESSION_SECRET|BRYNTUM_LICENSE_KEY)=/.test(line)) { let value = line.slice(line.indexOf("=") + 1).trim(); try { value = JSON.parse(value); } catch {} if (value.length > 12) secrets.push(value); if (line.startsWith("DATABASE_URL=")) { const password = decodeURIComponent(new URL(value).password); if (password.length > 12) secrets.push(password); } }
for (const mode of ["native", "http"]) { const selected = await selectedAudienceFixture(mode), originals = [selected.fixture]; const first = await readFile(selected.base + "/fixture.json", "utf8").catch(() => null); if (first) originals.push(JSON.parse(first)); for (const fixture of originals) secrets.push(fixture.bootstrapKey, ...Object.values(fixture.access).map(access => access.token), ...Object.values(fixture.attendees).map(link => link.url.split("#")[1])); }
const secretHits = [], publicPathHits = [], traceHits = [];
for (const record of [...source.filter(record => record.path.startsWith("public/")), ...buildInputs.filter(record => record.kind === "file")]) {
  const bytes = await readFile(record.path);
  if (secrets.some(value => value && bytes.includes(Buffer.from(value)))) secretHits.push(record.path);
  if ((record.path.startsWith("public/") || record.path.startsWith(".next/static/")) && bytes.includes(Buffer.from(root))) publicPathHits.push(record.path);
  if (record.path.endsWith(".nft.json")) { const trace = JSON.parse(bytes); for (const target of trace.files ?? []) { const full = resolve(dirname(resolve(root, record.path)), target), name = relative(root, full); if (/^(?:\.private|\.artifacts|plans)\//.test(name) || /^\.env(?:\.|$)/.test(name)) traceHits.push({ trace: record.path, target: name }); } }
}
await writeFile(directory + "/privacy.json", JSON.stringify({ version: 1, secretHits, publicPrivateRootHits: publicPathHits, privateTraceHits: traceHits, secretValuesEmitted: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
assert.equal(secretHits.length + publicPathHits.length + traceHits.length, 0, "Private production closure failed; retained paths identify the issue");
const writeManifest = async (name, records) => { const file = directory + "/" + name + ".json", value = { version: 1, records, hash: audienceSha256(JSON.stringify(records)) }; await writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); return { file, hash: value.hash, entries: records.length }; };
const sourceRecord = await writeManifest("source", source), dependencyRecord = await writeManifest("dependencies", dependencies), buildRecord = await writeManifest("production-build", buildInputs);
const result = { version: 1, state: "frozen", commit, parent: base, createdAt: new Date().toISOString(), sourceInputDigest: production.digest, sourceManifest: sourceRecord.file, sourceHash: sourceRecord.hash, sourceFiles: sourceRecord.entries, dependencyManifest: dependencyRecord.file, dependencyHash: dependencyRecord.hash, dependencyEntries: dependencyRecord.entries, buildManifest: buildRecord.file, buildHash: buildRecord.hash, buildEntries: buildRecord.entries, buildId: build.buildId, rootLockSha256: audienceSha256(rootLock), changedPaths: changed, privacy: { secretHits: secretHits.length, publicPrivateRootHits: publicPathHits.length, privateTraceHits: traceHits.length }, regressions: { state: regressions.state, tests: regressions.tests, originalFullRunRemainsFailed: regressions.originalFullRunRemainsFailed ?? false }, http: { checks: http.expectations, requests: http.requests }, stress: { report: stress.directory + "/report.json", committedInboxReceipts: stress.committedInboxReceipts, independentlyReadPrivateInboxes: stress.independentlyReadPrivateInboxes, elapsedMs: stress.elapsedMs }, nativeFixture: selectedNative.filename, nativeFixtureSha256: audienceSha256(selectedNative.bytes), actualProviderCalls: 0, actualModelCalls: 0, actualExternalAudienceMessages: 0, actualHumanReviews: 0, physicalEntryClaims: 0 };
await writeFile(destination, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 }); console.log(JSON.stringify({ state: result.state, commit, sourceHash: result.sourceHash, dependencyHash: result.dependencyHash, buildHash: result.buildHash, privacy: result.privacy }));
