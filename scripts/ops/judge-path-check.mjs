#!/usr/bin/env node
// Confirms that the hosted judge path is alive. It needs no credentials and prints no secret.
//
//   node scripts/ops/judge-path-check.mjs                      GET requests only
//   node scripts/ops/judge-path-check.mjs --create-session     also opens ONE new rehearsal and reads it back
//   node scripts/ops/judge-path-check.mjs --base http://localhost:4105 --until 2026-12-31 --json --strict
//
// Exit code 0: every check passed (warnings allowed unless --strict). Exit code 1: at least one check failed.
// --create-session counts against the shared new-rehearsal limit (30 per hour, 200 per day); use it sparingly.
import { pathToFileURL } from "node:url";

export const DEFAULT_BASE = "https://paypal-ai-opening-night.vercel.app";
export const DEFAULT_UNTIL = "2026-12-31";
export const SESSION_COOKIE = "opening-night-session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;

export function parseArguments(argv) {
  const options = { base: DEFAULT_BASE, until: DEFAULT_UNTIL, createSession: false, json: false, strict: false, timeoutMs: 30000 };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === "--create-session") options.createSession = true;
    else if (name === "--json") options.json = true;
    else if (name === "--strict") options.strict = true;
    else if (name === "--base" || name === "--until" || name === "--timeout") {
      const value = argv[++index];
      if (!value) throw new Error(`${name} needs a value`);
      if (name === "--base") options.base = value.replace(/\/+$/, "");
      else if (name === "--until") options.until = value;
      else options.timeoutMs = Number(value) * 1000;
    } else throw new Error(`Unknown option ${name}`);
  }
  if (!/^https?:\/\/[^/]+$/.test(options.base)) throw new Error("--base must be an origin such as https://example.vercel.app");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.until) || Number.isNaN(Date.parse(options.until))) throw new Error("--until must be a YYYY-MM-DD date");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("--timeout must be a positive number of seconds");
  return options;
}

/**
 * The scheduling components receive a license key in the page. Its first half is a readable, signed statement of
 * the license type and end date. Only that statement is decoded here; the key itself is never returned or printed.
 */
export function licenseStatements(html) {
  const found = new Map();
  for (const match of html.matchAll(/licenseKey\\?"\s*:\s*\\?"([A-Za-z0-9+/]+={0,2})\.[A-Za-z0-9+/]+={0,2}/g)) {
    try {
      const payload = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
      if (!payload || typeof payload !== "object" || typeof payload.type !== "string") continue;
      const statement = { type: payload.type, licenseEnd: typeof payload.licenseEnd === "string" ? payload.licenseEnd : null, supportEnd: typeof payload.supportEnd === "string" ? payload.supportEnd : null };
      found.set(JSON.stringify(statement), statement);
    } catch { /* Not a readable license statement. */ }
  }
  return [...found.values()];
}

/** A trial is usable through the end of its stated day; a purchased license does not end. */
export function licenseVerdict(statement, now, until) {
  if (!statement) return { level: "warn", detail: "No license statement was found in the page. Open a schedule view in a browser and confirm that it renders." };
  if (statement.type !== "trial") return { level: "pass", detail: `Purchased license (${statement.type}); it has no end date.` };
  if (!statement.licenseEnd || !/^\d{4}-\d{2}-\d{2}$/.test(statement.licenseEnd)) return { level: "fail", detail: "The trial license has no readable end date." };
  // The component compares against the end of that day in the viewer's own time zone. UTC-12 is the last place
  // on Earth where the day ends, so this is the latest instant at which any viewer still has a working trial.
  const lastUsable = Date.parse(`${statement.licenseEnd}T23:59:59.999-12:00`);
  const firstBlockedEverywhere = Date.parse(`${statement.licenseEnd}T23:59:59.999+14:00`);
  if (now > lastUsable) return { level: "fail", detail: `The trial license ended on ${statement.licenseEnd}. Schedule views are blocked for every viewer.` };
  const days = Math.max(0, Math.floor((firstBlockedEverywhere - now) / 86_400_000));
  if (statement.licenseEnd < until) return { level: "warn", detail: `Trial license ends on ${statement.licenseEnd} (about ${days} day${days === 1 ? "" : "s"} left), before ${until}. Schedule views will be blocked after that day unless the key is replaced.` };
  return { level: "pass", detail: `Trial license ends on ${statement.licenseEnd}, on or after ${until}.` };
}

export function sessionCookie(setCookieHeaders) {
  for (const header of setCookieHeaders) {
    const [pair, ...attributes] = header.split(";").map(part => part.trim());
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator) !== SESSION_COOKIE) continue;
    const named = Object.fromEntries(attributes.map(attribute => { const at = attribute.indexOf("="); return at < 0 ? [attribute.toLowerCase(), true] : [attribute.slice(0, at).toLowerCase(), attribute.slice(at + 1)]; }));
    return { value: pair.slice(separator + 1), maxAge: named["max-age"] === undefined ? null : Number(named["max-age"]), httpOnly: named.httponly === true, secure: named.secure === true, sameSite: typeof named.samesite === "string" ? named.samesite.toLowerCase() : null };
  }
  return null;
}

async function timed(url, init, timeoutMs) {
  const started = performance.now();
  const response = await fetch(url, { redirect: "manual", ...init, signal: AbortSignal.timeout(timeoutMs) });
  const headersMs = Math.round(performance.now() - started);
  const text = await response.text();
  return { response, text, headersMs, totalMs: Math.round(performance.now() - started) };
}

export async function runChecks(options, now = Date.now()) {
  const results = [];
  const record = (name, level, detail, timing) => { results.push({ name, level, detail, ...(timing ? { firstByteMs: timing.headersMs, totalMs: timing.totalMs } : {}) }); };
  const attempt = async (name, work) => { try { await work(); } catch (error) { record(name, "fail", error instanceof Error ? `${error.name}: ${error.message}` : "Request failed"); } };
  const json = text => { try { return JSON.parse(text); } catch { return null; } };

  await attempt("landing page", async () => {
    const landing = await timed(options.base + "/", {}, options.timeoutMs);
    const location = landing.response.headers.get("location") ?? "";
    if (landing.response.status >= 300 && landing.response.status < 400 && /vercel\.com\/(sso|login)/.test(location)) { record("landing page", "fail", "This address is behind Vercel sign-in. Judges need the public production address.", landing); return; }
    if (landing.response.status !== 200) { record("landing page", "fail", `Expected 200, received ${landing.response.status}.`, landing); return; }
    if (!/Opening Night/.test(landing.text) || !/rehearsal/i.test(landing.text)) { record("landing page", "fail", "The page loaded without the Opening Night start screen.", landing); return; }
    record("landing page", "pass", "200 with the start screen.", landing);
    const expected = { "x-content-type-options": /^nosniff$/i, "x-frame-options": /^DENY$/i, "referrer-policy": /^strict-origin-when-cross-origin$/i, "permissions-policy": /microphone=\(self\)/ };
    if (options.base.startsWith("https://")) expected["strict-transport-security"] = /max-age=\d+/;
    const missing = Object.entries(expected).filter(([name, pattern]) => !pattern.test(landing.response.headers.get(name) ?? "")).map(([name]) => name);
    record("security headers", missing.length ? "fail" : "pass", missing.length ? `Missing or changed: ${missing.join(", ")}.` : `${Object.keys(expected).length} required headers present.`);
    const statements = licenseStatements(landing.text);
    if (statements.length > 1) record("schedule license", "warn", "More than one license statement was found in the page.");
    const verdict = licenseVerdict(statements[0] ?? null, now, options.until);
    record("schedule license", verdict.level, verdict.detail);
  });

  await attempt("health", async () => {
    const health = await timed(options.base + "/api/health", {}, options.timeoutMs), body = json(health.text);
    record("health", health.response.status === 200 && body?.status === "ok" && body?.application === "opening-night" ? "pass" : "fail", `${health.response.status} ${body?.status ?? "unreadable body"}.`, health);
  });

  await attempt("anonymous read is refused", async () => {
    const show = await timed(options.base + "/api/show", {}, options.timeoutMs), body = json(show.text);
    record("anonymous read is refused", show.response.status === 401 && body?.code === "SESSION_REQUIRED" ? "pass" : "fail", `${show.response.status} ${body?.code ?? "unreadable body"}; a visitor without a rehearsal is asked to open one.`, show);
  });

  await attempt("background worker is configured", async () => {
    const tick = await timed(options.base + "/api/jobs/tick", {}, options.timeoutMs), body = json(tick.text);
    const configured = tick.response.status === 401 && body?.code === "WORKER_AUTH_REQUIRED";
    record("background worker is configured", configured ? "pass" : "fail", configured ? "The worker endpoint exists and refuses callers without its capability. This does not prove the schedule is firing; see the hosting logs for that." : `${tick.response.status} ${body?.code ?? "unreadable body"}.`, tick);
  });

  await attempt("evaluation report", async () => {
    const report = await timed(options.base + "/evaluation", {}, options.timeoutMs);
    record("evaluation report", report.response.status === 200 ? "pass" : "fail", `${report.response.status}.`, report);
  });

  if (!options.createSession) { record("new rehearsal", "skip", "Not requested. Add --create-session to open one new rehearsal and read it back."); return results; }

  await attempt("new rehearsal", async () => {
    const created = await timed(options.base + "/api/session", { method: "POST", headers: { Origin: options.base } }, options.timeoutMs), body = json(created.text);
    if (created.response.status === 429) { record("new rehearsal", "warn", `New rehearsals are at their shared limit; retry after ${created.response.headers.get("retry-after") ?? "a while"} seconds. Existing rehearsals are unaffected.`, created); return; }
    if (created.response.status !== 200 || !body?.show) { record("new rehearsal", "fail", `${created.response.status} ${body?.code ?? "unreadable body"}.`, created); return; }
    const cookie = sessionCookie(created.response.headers.getSetCookie());
    if (!cookie) { record("new rehearsal", "fail", "The rehearsal opened without its session cookie.", created); return; }
    record("new rehearsal", "pass", `Opened: ${body.show.title}, ${body.show.tasks?.length ?? "?"} tasks, show date ${body.show.showDate}, revision ${body.show.revision}.`, created);
    const attributes = cookie.maxAge === SESSION_SECONDS && cookie.httpOnly && cookie.sameSite === "lax" && (cookie.secure || !options.base.startsWith("https://"));
    record("session cookie", attributes ? "pass" : "fail", `Lifetime ${cookie.maxAge === null ? "not stated" : `${cookie.maxAge / 86400} days`}, HttpOnly ${cookie.httpOnly}, Secure ${cookie.secure}, SameSite ${cookie.sameSite}.`);
    const headers = { Cookie: `${SESSION_COOKIE}=${cookie.value}` };
    const read = await timed(options.base + "/api/show", { headers }, options.timeoutMs), saved = json(read.text);
    const same = read.response.status === 200 && saved?.show?.tenantId === body.show.tenantId && saved?.show?.revision === body.show.revision;
    record("read the new rehearsal", same ? "pass" : "fail", same ? `Saved state read back: ${saved.show.tasks.length} tasks, server time ${saved.serverAt}.` : `${read.response.status} ${saved?.code ?? "state did not match"}.`, read);
    const page = await timed(options.base + "/", { headers }, options.timeoutMs);
    record("console page with the rehearsal", page.response.status === 200 && page.text.includes(body.show.tenantId) ? "pass" : "fail", `${page.response.status}; the server rendered the production console for this rehearsal.`, page);
  });
  return results;
}

export function exitCode(results, strict) {
  if (results.some(result => result.level === "fail")) return 1;
  return strict && results.some(result => result.level === "warn") ? 1 : 0;
}

async function main() {
  let options;
  try { options = parseArguments(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  const startedAt = new Date().toISOString(), results = await runChecks(options);
  if (options.json) console.log(JSON.stringify({ base: options.base, startedAt, until: options.until, createdSession: options.createSession, results }, null, 2));
  else {
    console.log(`Opening Night judge path · ${options.base} · ${startedAt}`);
    const label = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" };
    for (const result of results) console.log(`${label[result.level]}  ${result.name}${result.firstByteMs === undefined ? "" : ` (${result.firstByteMs} ms to first byte, ${result.totalMs} ms total)`}\n      ${result.detail}`);
    const count = level => results.filter(result => result.level === level).length;
    console.log(`\n${count("pass")} passed, ${count("warn")} warning${count("warn") === 1 ? "" : "s"}, ${count("fail")} failed, ${count("skip")} skipped.`);
  }
  process.exit(exitCode(results, options.strict));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
