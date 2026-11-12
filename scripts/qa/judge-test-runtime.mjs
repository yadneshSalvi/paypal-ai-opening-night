// Guided-demonstration suite preload: ANY outbound request fails the run.
// The director must be the thing that prevents provider traffic, so the
// ordinary environment (including real sandbox credentials, when present)
// stays loaded and only the network is closed.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
if (process.env.VERCEL) throw new Error("The guided demonstration suite is local only");
const state = { version: 1, attempts: [] };
const local = host => ["localhost", "127.0.0.1", "::1"].includes(String(host ?? "localhost"));
const refuse = (kind, target) => { state.attempts.push({ kind, target: String(target).slice(0, 120) }); throw new Error("JUDGE_EGRESS_BLOCKED: " + kind); };
globalThis.fetch = async input => refuse("fetch", typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
for (const module of [http, https]) for (const name of ["request", "get"]) module[name] = (...args) => refuse("node:" + name, typeof args[0] === "string" ? args[0] : args[0]?.href ?? args[0]?.hostname ?? "unknown");
// PostgreSQL on loopback is the only socket this suite may open.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) { const options = typeof args[0] === "object" ? args[0] : { port: args[0], host: typeof args[1] === "string" ? args[1] : undefined }; if (!options.path && !local(options.host)) refuse("socket", options.host); return connect.apply(this, args); };
syncBuiltinESMExports();
globalThis.openingNightJudgeEgressGuard = state;
