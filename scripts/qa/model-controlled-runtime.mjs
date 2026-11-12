// Import after the unit's restricted local configuration and before application modules.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import dgram from "node:dgram";
import os from "node:os";
import path from "node:path";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import pg from "pg";
if (process.env.VERCEL) throw new Error("Controlled model tests cannot run on a hosted deployment");
if (existsSync(new URL("../../.env", import.meta.url))) throw new Error("Controlled model tests refuse an application environment file; load the isolated allowlisted configuration explicitly");
for (const [name, value] of Object.entries(process.env)) if (value && /OPENAI|GEMINI|PAYPAL|ANTHROPIC|CHANNEL3|GOOGLE_API_KEY|BLOB_READ_WRITE_TOKEN|CRON_SECRET/.test(name)) throw new Error(`Controlled tests refuse external credentials: ${name}`);
const configured = new URL(process.env.DATABASE_URL ?? "postgresql://127.0.0.1:55580/unconfigured");
const port = Number(process.env.OPENING_NIGHT_MODEL_TEST_PORT ?? "55580");
if (configured.hostname !== "127.0.0.1" || Number(configured.port) !== port || !Number.isInteger(port) || port < 1024) throw new Error("Controlled tests require their one explicitly configured local database port");
const database = process.env.OPENING_NIGHT_MODEL_DATABASE, role = process.env.OPENING_NIGHT_MODEL_ROLE;
if (process.env.DATABASE_URL && (!database || !role || decodeURIComponent(configured.pathname.slice(1)) !== database || decodeURIComponent(configured.username) !== role)) throw new Error("Controlled tests require their exact isolated database and role");
process.env.OPENING_NIGHT_AI_QA = "1"; process.env.OPENING_NIGHT_QA_FIXTURE = "1";
const state = { blockedExternalPaths: 0, blockedDatabaseIdentities: 0, ownDatabaseConnections: 0, suppressedToolingIpc: 0 };
const block = () => { state.blockedExternalPaths++; throw new Error("Model controlled tests forbid this transport"); };
globalThis.fetch = block;
for (const client of [http, https]) for (const name of ["get", "request"]) client[name] = block;
const originalConnect = net.Socket.prototype.connect;
const originalPgConnect = pg.Client.prototype.connect;
pg.Client.prototype.connect = function (...args) {
  const parameters = this.connectionParameters;
  if (!database || !role || parameters.database !== database || parameters.user !== role || parameters.host !== "127.0.0.1" || Number(parameters.port) !== port) { state.blockedDatabaseIdentities++; throw new Error("Model runtime refuses a different database or role before connecting"); }
  return Reflect.apply(originalPgConnect, this, args);
};
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args, first = normalized[0];
  const target = first && typeof first === "object" ? first : { port: first, host: normalized[1] };
  if (target.host === "127.0.0.1" && Number(target.port) === port && /\/node_modules\/pg\/lib\/connection\.js:/.test(new Error().stack ?? "")) {
    state.ownDatabaseConnections++; return Reflect.apply(originalConnect, this, args);
  }
  return block();
};
const optionalPipe = path.join(os.tmpdir(), `tsx-${process.geteuid ? process.geteuid() : os.userInfo().username}`, `${process.ppid}.pipe`);
function connection(...args) {
  if (args[0] === optionalPipe && /\/node_modules\/tsx\/dist\/client-(?:BQVF1NaW\.mjs|D6NvIMSC\.cjs):/.test(new Error().stack ?? "")) {
    state.suppressedToolingIpc++;
    const socket = new net.Socket(); queueMicrotask(() => socket.emit("error", Object.assign(new Error("Optional tooling IPC suppressed"), { code: "ECONNREFUSED" }))); return socket;
  }
  return block();
}
net.connect = connection; net.createConnection = connection; tls.connect = block; dgram.createSocket = block;
for (const target of [dns, dnsPromises, dns.Resolver.prototype, dnsPromises.Resolver.prototype]) for (const name of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"]) if (typeof target[name] === "function") target[name] = block;
syncBuiltinESMExports();
globalThis.openingNightModelControlledGuard = Object.freeze({ version: 2, port, database: database ?? null, role: role ?? null, state, externalProviders: false });
if (process.env.OPENING_NIGHT_MODEL_GUARD_AUDIT) process.once("exit", () => {
  mkdirSync(process.env.OPENING_NIGHT_MODEL_GUARD_AUDIT, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(process.env.OPENING_NIGHT_MODEL_GUARD_AUDIT, `${process.pid}.json`), JSON.stringify({ at: new Date().toISOString(), port, ...state }) + "\n", { flag: "wx", mode: 0o600 });
});
