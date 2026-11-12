/** Complete inherited regressions plus N3. All children use this exact source and owned PG55579. */
import "./audience-disabled-runtime.mjs";
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { audienceProductionInputs, audienceSha256 } from "./audience-inputs.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
if (process.cwd() !== root || execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim() !== root) throw new Error("Use this exact isolated audience checkout");
const original = await audienceProductionInputs(root), directory = ".artifacts/audience-stage17/regressions-" + randomUUID();
await mkdir(directory, { recursive: true, mode: 0o700 });
const controlled = ["cohort-work", "commerce-api", "durable-work", "payment-wire", "remedy-work", "supplier-work", "wallet-work", "disruptions-store", "rental-closeout-store", "rental-closeout-api", "supplier-recovery-store", "supplier-recovery-api"].map(name => "tests/" + name + ".test.ts");
const all = (await readdir("tests")).filter(name => /\.test\.tsx?$/.test(name)).map(name => "tests/" + name).sort(), audience = all.filter(name => name.startsWith("tests/audience-"));
const partitions = [
  { name: "audience", preload: "./scripts/qa/audience-native-test-runtime.mjs", files: audience, concurrency: 1 },
  { name: "product", preload: "./scripts/qa/audience-product-test-runtime.mjs", files: all.filter(name => !controlled.includes(name) && !audience.includes(name)), concurrency: 2 },
  { name: "controlled-sdk", preload: "./scripts/qa/audience-inherited-sdk-runtime.mjs", files: controlled, concurrency: 2 },
];
const requested = process.argv.slice(2);
if (requested.length > 1 || requested.some(name => !partitions.some(partition => partition.name === name))) throw new Error("Optional partition is audience, product or controlled-sdk");
const selected = requested.length ? partitions.filter(partition => requested.includes(partition.name)) : partitions;
const inputs = []; for (const path of all) { const bytes = await readFile(path); inputs.push({ path, sha256: audienceSha256(bytes), bytes: bytes.length }); }
await writeFile(directory + "/prepared.json", JSON.stringify({ version: 1, createdAt: new Date().toISOString(), sourceInputDigest: original.digest, testInputs: inputs, testInputHash: audienceSha256(JSON.stringify(inputs)), partitions, mode: "fresh owned local schemas; actual providers/models disabled; controlled SDK seams are labeled separately" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const results = [];
for (const partition of selected) {
  const args = ["--import", partition.preload, "--import", "tsx", "--test", "--test-concurrency=" + partition.concurrency, ...partition.files], file = await open(directory + "/" + partition.name + ".log", "wx", 0o600), startedAt = new Date().toISOString();
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, OPENING_NIGHT_AUDIENCE_EPHEMERAL_HTTP: "1" }, stdio: ["ignore", file.fd, file.fd] });
  const code = await new Promise(done => { child.once("error", () => done(-1)); child.once("close", value => done(value ?? -1)); }); await file.close();
  const output = await readFile(directory + "/" + partition.name + ".log", "utf8"), count = label => Number(output.match(new RegExp("^# " + label + " (\\d+)$", "m"))?.[1] ?? 0);
  const result = { partition: partition.name, startedAt, completedAt: new Date().toISOString(), exitCode: code, files: partition.files.length, fileConcurrency: partition.concurrency, tests: count("tests"), passed: count("pass"), failed: count("fail"), skipped: count("skipped"), cancelled: count("cancelled"), log: directory + "/" + partition.name + ".log", logSha256: audienceSha256(output) };
  results.push(result); await writeFile(directory + "/" + partition.name + ".json", JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 }); console.log(JSON.stringify(result));
  if (code !== 0 || !result.tests || result.failed || result.cancelled || result.skipped) { process.exitCode = 1; break; }
}
const current = await audienceProductionInputs(root);
const summary = { version: 1, state: results.length === selected.length && results.every(result => result.exitCode === 0 && result.tests === result.passed && !result.skipped) && original.digest === current.digest ? "qualified" : "failed", coverage: requested.length ? "partition" : "full", sourceInputDigest: original.digest, inputsUnchanged: original.digest === current.digest, directory, tests: results.reduce((sum, result) => sum + result.tests, 0), passed: results.reduce((sum, result) => sum + result.passed, 0), skipped: results.reduce((sum, result) => sum + result.skipped, 0), results, completedAt: new Date().toISOString(), actualProviderRequests: 0, actualModelRequests: 0, actualExternalAudienceMessages: 0 };
await writeFile(directory + "/summary.json", JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
if (summary.state === "qualified" && summary.coverage === "full") { const next = ".artifacts/audience-stage17/qualified-regressions.next-" + randomUUID(); await writeFile(next, JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 }); await rename(next, ".artifacts/audience-stage17/qualified-regressions.json"); } else if (summary.state !== "qualified") process.exitCode = 1;
console.log(JSON.stringify({ state: summary.state, tests: summary.tests, passed: summary.passed, directory, inputsUnchanged: summary.inputsUnchanged }));
