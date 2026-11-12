// Evaluation has no network,session,database or external-action authority. Import before application modules.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import path from "node:path";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import dgram from "node:dgram";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
if (process.env.VERCEL) throw new Error("Evaluation is local controlled computation only");
if (existsSync(new URL("../../.env",import.meta.url))) throw new Error("Evaluation refuses an application environment file");
for (const [name,value] of Object.entries(process.env)) {
  if (value && /PAYPAL|OPENAI|GEMINI|ANTHROPIC|DATABASE_URL|PGPASSWORD|JUDGE_SESSION_SECRET|BLOB_READ_WRITE_TOKEN|CRON_SECRET|CHANNEL3|GOOGLE_API_KEY/.test(name)) throw new Error(`Evaluation refuses credential or database configuration: ${name}`);
}
process.env.OPENING_NIGHT_AI_QA = "1";
process.env.OPENING_NIGHT_QA_FIXTURE = "1";
const state = { networkAttemptsBlocked: 0,toolingIpcSuppressed:0 };
const blocked = () => { state.networkAttemptsBlocked++; throw new Error("Evaluation network and database transport is disabled"); };
globalThis.fetch = blocked;
for (const client of [http,https]) for (const name of ["request","get"]) client[name] = blocked;
// tsx4.20.6 attempts optional parent IPC from these two pinned client modules.
// Return an unconnected socket with a local error only for that exact computed pipe+callsite.
// No Unix socket is opened, and no TCP/UDP/database exception is introduced.
const toolingPipe = path.join(os.tmpdir(),`tsx-${process.geteuid ? process.geteuid() : os.userInfo().username}`,`${process.ppid}.pipe`);
function connection(...args) {
  const stack = new Error().stack ?? "";
  if (args[0] === toolingPipe && /\/node_modules\/tsx\/dist\/client-(?:BQVF1NaW\.mjs|D6NvIMSC\.cjs):/.test(stack)) {
    state.toolingIpcSuppressed++;
    const socket = new net.Socket();
    queueMicrotask(() => socket.emit("error",Object.assign(new Error("Optional tooling IPC is suppressed during evaluation"),{code:"ECONNREFUSED"})));
    return socket;
  }
  return blocked();
}
net.connect = connection;
net.createConnection = connection;
net.Socket.prototype.connect = blocked;
tls.connect = blocked;
dgram.createSocket = blocked;
for (const target of [dns,dnsPromises,dns.Resolver.prototype,dnsPromises.Resolver.prototype]) for (const name of ["lookup","lookupService","resolve","resolve4","resolve6","resolveAny","resolveCaa","resolveCname","resolveMx","resolveNaptr","resolveNs","resolvePtr","resolveSoa","resolveSrv","resolveTxt","reverse"]) if (typeof target[name] === "function") target[name] = blocked;
syncBuiltinESMExports();
globalThis.openingNightEvaluationGuard = Object.freeze({ version: 2, state, noNetwork: true, noDatabase: true });
