/** Local N3 qualification only: exact owned PG, exact owned HTTP listeners, no other egress. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { selectedAudienceFixture } from "./audience-fixture.mjs";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
if (process.cwd() !== root || process.env.VERCEL || fs.existsSync(path.join(root, ".env"))) throw new Error("Audience qualification requires its exact isolated local checkout without .env");
for (const name of Object.keys(process.env)) if (/OPENAI|GEMINI|GOOGLE_API|PAYPAL|ANTHROPIC|CHANNEL3|BLOB_READ_WRITE_TOKEN|CRON_SECRET/.test(name)) delete process.env[name];
for (const name of ["DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING", "DIRECT_URL"]) if (process.env[name] && process.env[name] !== process.env.DATABASE_URL) throw new Error("Audience qualification has an unowned database descriptor");
const database = new URL(process.env.DATABASE_URL ?? "");
if (database.protocol !== "postgresql:" || database.hostname !== "127.0.0.1" || database.port !== "55579" || database.username !== "opening_audience_stage17" || database.pathname !== "/opening_audience_stage17" || database.search || !database.password || !process.env.JUDGE_SESSION_SECRET) throw new Error("Audience qualification requires its fresh owned PostgreSQL55579 role");
process.env.OPENING_NIGHT_AUDIENCE_QA = "1";
process.env.OPENING_NIGHT_QA_FIXTURE = "1";
process.env.OPENING_NIGHT_AI_QA = "1";
process.env.APP_BASE_URL = "http://127.0.0.1:4594";
const counts = { blocked: 0, postgresConnections: 0, ownedHttpConnections: 0, toolingIpcSuppressed: 0, literalLoopbackResolutions: 0 };
const listeners = new Set();
let ownedReviewClient = false;
if (process.env.OPENING_NIGHT_AUDIENCE_REVIEW_CLIENT) {
  const mode = process.env.OPENING_NIGHT_AUDIENCE_REVIEW_CLIENT;
  if (!["http", "native"].includes(mode)) throw new Error("Choose an explicitly owned audience review client");
  const selected = await selectedAudienceFixture(mode), directory = path.join(root, selected.base), current = JSON.parse(fs.readFileSync(path.join(directory, "active-listener.json"), "utf8")), fixture = selected.bytes, qualified = JSON.parse(fs.readFileSync(path.join(root, ".artifacts/audience-stage17/qualified-build.json"), "utf8"));
  if (current.version !== 1 || !Number.isInteger(current.pid) || current.pid <= 1 || current.origin !== "http://127.0.0.1:4594" || current.fixturePath !== selected.filename || current.fixtureSha256 !== createHash("sha256").update(fixture).digest("hex") || current.buildId !== qualified.buildId || current.sourceInputDigest !== qualified.inputHash) throw new Error("The exact audience review listener manifest is not qualified");
  const sockets = execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(current.pid), "-iTCP:4594", "-sTCP:LISTEN", "-Fpn"], { cwd: root, encoding: "utf8" });
  const working = execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(current.pid), "-d", "cwd", "-Fn"], { cwd: root, encoding: "utf8" });
  const command = execFileSync("/bin/ps", ["-p", String(current.pid), "-o", "args="], { cwd: root, encoding: "utf8" });
  if (!sockets.split("\n").includes(`p${current.pid}`) || !sockets.split("\n").includes("n127.0.0.1:4594") || !working.split("\n").includes("n" + root) || !command.includes("scripts/qa/audience-review-server.mjs")) throw new Error("Port4594 is not owned by this exact audience review source");
  ownedReviewClient = true;
}
function blocked() { counts.blocked++; throw new Error("Audience qualification denied unowned network transport"); }
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const options = args[0], port = Number(options && typeof options === "object" ? options.port : options), host = options && typeof options === "object" ? options.host : typeof args[1] === "string" ? args[1] : undefined;
  if (host !== "127.0.0.1" || port !== 4594 && !(port === 0 && process.env.OPENING_NIGHT_AUDIENCE_EPHEMERAL_HTTP === "1")) return blocked();
  this.once("listening", () => { const address = this.address(); if (address && typeof address !== "string") { listeners.add(address.port); this.once("close", () => listeners.delete(address.port)); } });
  return Reflect.apply(listen, this, args);
};
const toolingPipe = path.join(os.tmpdir(), `tsx-${process.geteuid ? process.geteuid() : os.userInfo().username}`, `${process.ppid}.pipe`);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = args[0];
  const target = Array.isArray(options) ? options[0] : options;
  const stack = new Error().stack ?? "";
  if ((target && typeof target === "object" ? target.path : target) === toolingPipe && /\/node_modules\/tsx\/dist\/client-(?:BQVF1NaW\.mjs|D6NvIMSC\.cjs):/.test(stack)) {
    counts.toolingIpcSuppressed++; queueMicrotask(() => this.emit("error", Object.assign(new Error("Optional tsx parent IPC suppressed in audience qualification"), { code: "ECONNREFUSED" }))); return this;
  }
  const port = Number(target && typeof target === "object" ? target.port : target), host = target && typeof target === "object" ? target.host : typeof args[1] === "string" ? args[1] : undefined;
  if (host !== "127.0.0.1" || !Number.isInteger(port)) return blocked();
  if (port === 55579) counts.postgresConnections++;
  else if (listeners.has(port) || ownedReviewClient && port === 4594) counts.ownedHttpConnections++;
  else return blocked();
  return Reflect.apply(connect, this, args);
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  let target; try { target = new URL(typeof input === "string" || input instanceof URL ? input : input.url); } catch { return blocked(); }
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !listeners.has(Number(target.port)) && !(ownedReviewClient && Number(target.port) === 4594) || target.username || target.password) return blocked();
  return nativeFetch(input, init);
};
tls.connect = blocked;
dgram.createSocket = blocked;
for (const owner of [dns, dnsPromises, dns.Resolver.prototype, dnsPromises.Resolver.prototype]) for (const name of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"]) if (typeof owner[name] === "function") owner[name] = blocked;
// Node's Server.listen calls lookup even for this literal IP. Resolve only the
// already allowed literal in memory; never invoke an OS resolver or allow localhost.
dns.lookup = function (hostname, options, callback) {
  if (hostname !== "127.0.0.1") return blocked();
  const done = typeof options === "function" ? options : callback;
  if (typeof done !== "function") return blocked();
  counts.literalLoopbackResolutions++;
  queueMicrotask(() => options?.all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4));
};
dnsPromises.lookup = async function (hostname, options) {
  if (hostname !== "127.0.0.1") return blocked();
  counts.literalLoopbackResolutions++;
  return options?.all ? [{ address: "127.0.0.1", family: 4 }] : { address: "127.0.0.1", family: 4 };
};
syncBuiltinESMExports();
globalThis.openingNightAudienceGuard = Object.freeze({ version: 1, counts, databasePort: 55579, appPort: 4594, controlledTransport: true, ownedReviewClient });
process.once("exit", () => {
  const evidence = path.join(root, ".artifacts/audience-stage17"); fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(evidence, `egress-${process.pid}.json`), JSON.stringify({ version: 1, pid: process.pid, at: new Date().toISOString(), ...counts, allowedDatabasePort: 55579, allowedHttpPorts: [...listeners], externalProviderOrModelConfigured: false }, null, 2) + "\n", { mode: 0o600 });
});
