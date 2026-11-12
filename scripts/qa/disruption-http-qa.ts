/** Controlled HTTP qualification on the owned 4564 build. Original native personas stay unchanged. */
import "./disruption-disabled-providers.mjs";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createSession, createCrewCapability, pool, getShow } from "../../src/server/store";
import { sessionTokenHash } from "../../src/server/session-records";
import { readDisruptionWorkspace } from "../../src/server/disruptions/service";
import { digest } from "../../src/domain/hash";
import type { Actor } from "../../src/domain/contracts";
import type { DisruptionCommand, DisruptionEnvelope } from "../../src/domain/disruptions";
import type { DisruptionWorkspace, DisruptionResult } from "../../src/server/disruptions/contracts";

const origin = "http://127.0.0.1:4564", cookie = "opening-night-disruption-4564-session";
const url = new URL(process.env.DATABASE_URL!);
if (url.hostname !== "127.0.0.1" || url.port !== "55564" || !/^\/opening_disruption_[a-f0-9]{12}$/.test(url.pathname)) throw new Error("Only the owned stage14 PostgreSQL cluster may be used");
const native = JSON.parse(await readFile(".artifacts/disruption-native-4564/fixture.json", "utf8")) as { bootstrapKey: string; access: Record<string, { token: string; actor: Actor; expiresAt: string }>; baseline: Record<string, { showDigest: string; workspaceDigest: string }> };
const nativeBefore = async () => {
  const result: Record<string, { showDigest: string; workspaceDigest: string }> = {};
  for (const name of ["producer", "support", "other"]) { const access = native.access[name]!; result[name] = { showDigest: digest(await getShow(access.actor.tenantId)), workspaceDigest: digest(await readDisruptionWorkspace({ actor: access.actor, sessionHash: sessionTokenHash(access.token) })) }; }
  return result;
};
assert.deepEqual(await nativeBefore(), native.baseline, "The original native fixture changed before HTTP qualification");
const directory = `.artifacts/disruption-http-${randomUUID()}`; await mkdir(directory, { mode: 0o700 });
const results: { name: string; status: "passed" | "failed"; elapsedMs: number; message?: string }[] = [];
const session = await createSession(undefined, `disruption-http:${randomUUID()}`), support = await createSession(undefined, `disruption-http-support:${randomUUID()}`), other = await createSession(undefined, `disruption-http-other:${randomUUID()}`);
await writeFile(`${directory}/producer-access.json`, JSON.stringify({ createdAt: new Date().toISOString(), session, support, other }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
// Explicit fixture enrollment exercises source reporting before a rental is approved.
// The production invite route continues to require a selected supplier plan.
const supplier = randomBytes(32).toString("base64url"), supplierActor: Actor = { id: `supplier:brightline:http:${randomUUID()}`, tenantId: session.actor.tenantId, roles: ["supplier"], supplierId: "brightline", personId: null };
await pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [sessionTokenHash(supplier), session.actor.tenantId, supplierActor]);
const crew = await createCrewCapability(session.actor, "sam");
await writeFile(`${directory}/scoped-access.json`, JSON.stringify({ supplier, supplierActor, crew }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
async function check(name: string, work: () => Promise<void>) {
  const began = performance.now();
  try { await work(); results.push({ name, status: "passed", elapsedMs: Math.round(performance.now() - began) }); }
  catch (error) { results.push({ name, status: "failed", elapsedMs: Math.round(performance.now() - began), message: error instanceof Error ? error.message : "Unknown failure" }); throw error; }
}
type RequestOptions = { token?: string; bearer?: boolean; scope?: string | null; origin?: string | null; body?: unknown; method?: string };
async function request(path: string, options: RequestOptions = {}) {
  const headers = new Headers();
  if (options.token) headers.set(options.bearer ? "authorization" : "cookie", options.bearer ? `Bearer ${options.token}` : `${cookie}=${options.token}`);
  if (options.scope !== null) headers.set("X-Opening-Night-Production", options.scope ?? session.actor.tenantId);
  if (options.origin !== null) headers.set("origin", options.origin ?? origin);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(origin + path, { method: options.method ?? (options.body === undefined ? "GET" : "POST"), headers, redirect: "manual", ...(options.body === undefined ? {} : { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }) });
  return { response, value: await response.json().catch(() => null) };
}
const options = (access = session): RequestOptions => ({ token: access.token, scope: access.actor.tenantId });
async function workspace(access = session) { const value = await request("/api/disruptions", options(access)); assert.equal(value.response.status, 200, JSON.stringify(value.value)); return value.value as DisruptionWorkspace; }
async function command(value: DisruptionCommand, access = session, original?: DisruptionEnvelope) {
  const envelope = original ?? { idempotencyKey: randomUUID(), expectedRevision: (await workspace(access)).revision, command: value };
  const result = await request("/api/disruptions/commands", { ...options(access), body: envelope });
  assert.equal(result.response.status, 200, JSON.stringify(result.value)); return result.value as DisruptionResult;
}
const sourceReport = (offer: DisruptionWorkspace["offers"][number]): DisruptionCommand => ({ type: "report", offerId: offer.id, offerRevision: offer.revision, executionId: null, availability: "unavailable", earliestAt: null, observedAt: new Date().toISOString(), reference: "Owned synthetic HTTP declaration", detail: "Fictional rehearsal input for the HTTP test. No actual supplier communication or physical equipment failure is claimed.", confirmed: true });
const readPreview = async (mode: "cancel_show" | "support_only", admissionRefundMinor: number, access = session) => { const result = await request("/api/disruptions/preview", { ...options(access), body: { mode, admissionRefundMinor } }); assert.equal(result.response.status, 200, JSON.stringify(result.value)); return result.value; };
try {
  await check("private loopback chooser, exact origin and independent original capabilities", async () => {
    const page = await fetch(origin + "/__disruption_fixture"); assert.equal(page.status, 200); assert.equal(page.headers.get("referrer-policy"), "same-origin"); assert.match(page.headers.get("cache-control") ?? "", /no-store/); assert.match(await page.text(), /No payment receipts, physical sign-offs/);
    const denied = await fetch(origin + "/__disruption_fixture", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "persona=producer&key=invalid", redirect: "manual" }); assert.equal(denied.status, 403);
    for (const persona of ["other", "supplier", "sam"]) {
      const selected = await fetch(origin + "/__disruption_fixture", { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ persona, key: native.bootstrapKey }), redirect: "manual" }); assert.equal(selected.status, 303);
      if (persona === "other") { assert.match(selected.headers.get("set-cookie") ?? "", new RegExp(`^${cookie}=`)); assert.doesNotMatch(selected.headers.get("set-cookie") ?? "", /opening-night-tour-4561|opening-night-ai-qa/); }
      else { assert.equal(selected.headers.get("set-cookie"), null); assert.match(selected.headers.get("location") ?? "", persona === "supplier" ? /^\/supplier\/access#/ : /^\/crew\/access#/); }
    }
  });
  await check("fault controls are exact-key scoped and cannot affect an unrelated HTTP tenant", async () => {
    const control = (action: string, key: string, requestOrigin = origin) => fetch(origin + "/__disruption_control", { method: "POST", headers: { origin: requestOrigin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action, key }), redirect: "manual" });
    assert.equal((await control("hold-receipt-lookup", "invalid")).status, 403); assert.equal((await control("hold-receipt-lookup", native.bootstrapKey, "http://localhost:4564")).status, 403);
    assert.equal((await control("hold-receipt-lookup", native.bootstrapKey)).status, 303);
    try { const unrelated = await request(`/api/disruptions/commands/${randomUUID()}`, options()); assert.equal(unrelated.response.status, 404); assert.equal(unrelated.value.code, "DISRUPTION_COMMAND_NOT_FOUND"); assert.match(await (await fetch(origin + "/__disruption_fixture")).text(), /Armed: <b>hold-receipt-lookup<\/b> · Waiting: <b>none/); }
    finally { assert.equal((await control("cancel", native.bootstrapKey)).status, 303); }
  });
  await check("anonymous access, changed production, missing scope and cross-origin mutations fail closed", async () => {
    const anonymous = await request("/api/disruptions", { scope: null }); assert.equal(anonymous.response.status, 401); assert.equal(anonymous.value.code, "SESSION_REQUIRED");
    assert.equal((await request("/api/disruptions", { ...options(), scope: other.actor.tenantId })).response.status, 409);
    const initial = await workspace(), envelope = { idempotencyKey: randomUUID(), expectedRevision: initial.revision, command: sourceReport(initial.offers[0]!) };
    for (const originValue of [null, "http://localhost:4564", "http://127.0.0.1:4561", "https://example.invalid"]) assert.equal((await request("/api/disruptions/commands", { ...options(), body: envelope, origin: originValue })).response.status, 403);
    assert.equal((await request("/api/disruptions/commands", { ...options(), body: envelope, scope: null })).response.status, 409);
    assert.equal((await workspace()).reports.length, 0);
  });
  await check("strict bounded commands do not echo unsupported authority fields", async () => {
    const initial = await workspace(), envelope = { idempotencyKey: randomUUID(), expectedRevision: initial.revision, command: sourceReport(initial.offers[0]!), forgedAuthority: "do-not-echo" };
    const invalid = await request("/api/disruptions/commands", { ...options(), body: envelope }); assert.equal(invalid.response.status, 400); assert.ok(!JSON.stringify(invalid.value).includes("do-not-echo"));
    assert.equal((await request("/api/disruptions/commands", { ...options(), body: "x".repeat(30001) })).response.status, 413);
  });
  for (const access of [session, support]) {
    const show = await getShow(access.actor.tenantId);
    const loaded = await request("/api/show", { ...options(access), body: { idempotencyKey: randomUUID(), expectedRevision: show.revision, command: { type: "load_incidents" } } }); assert.equal(loaded.response.status, 200, JSON.stringify(loaded.value));
  }
  await check("one exact command commits once under concurrency and recovers only in its original session", async () => {
    const initial = await workspace(), envelope: DisruptionEnvelope = { idempotencyKey: randomUUID(), expectedRevision: initial.revision, command: sourceReport(initial.offers[0]!) };
    const missing = await request(`/api/disruptions/commands/${envelope.idempotencyKey}`, options()); assert.equal(missing.response.status, 404); assert.equal(missing.value.code, "DISRUPTION_COMMAND_NOT_FOUND");
    const [first, duplicate] = await Promise.all([command(envelope.command, session, envelope), command(envelope.command, session, envelope)]);
    assert.deepEqual(first.receipt, duplicate.receipt); assert.equal((await workspace()).reports.length, 1);
    const read = await request(`/api/disruptions/commands/${envelope.idempotencyKey}`, options()); assert.equal(read.response.status, 200); assert.deepEqual(read.value.receipt, first.receipt); assert.match(read.response.headers.get("cache-control") ?? "", /private, no-store/);
    assert.doesNotMatch(JSON.stringify(read.value), /sessionHash|receipt_cipher|document_cipher|JUDGE_SESSION_SECRET/);
    assert.equal((await request(`/api/disruptions/commands/${envelope.idempotencyKey}`, options(other))).response.status, 404);
    const anotherToken = randomBytes(32).toString("base64url"); await pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [sessionTokenHash(anotherToken), session.actor.tenantId, session.actor]);
    assert.equal((await request(`/api/disruptions/commands/${envelope.idempotencyKey}`, { ...options(), token: anotherToken })).response.status, 404);
    const altered = { ...envelope, expectedRevision: envelope.expectedRevision + 1 }; assert.equal((await request("/api/disruptions/commands", { ...options(), body: altered })).response.status, 409);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM on_disruption_commands WHERE tenant_id=$1 AND command_id=$2", [session.actor.tenantId, envelope.idempotencyKey])).rows[0].n, 1);
  });
  await check("supplier access is own-unit scoped and cannot review financial decisions", async () => {
    const own = await request("/api/disruptions", { ...options(), token: supplier, bearer: true }); assert.equal(own.response.status, 200); assert.equal(own.value.access, "supplier"); assert.ok(own.value.offers.every((offer: { supplierId: string }) => offer.supplierId === "brightline")); assert.deepEqual(own.value.obligations, []); assert.deepEqual(own.value.remedies, []); assert.deepEqual(own.value.historicalDecisions, []);
    const current = await workspace(), otherOffer = current.offers.find(offer => offer.supplierId === "northside")!;
    assert.equal((await request("/api/disruptions/commands", { ...options(), token: supplier, bearer: true, body: { idempotencyKey: randomUUID(), expectedRevision: current.revision, command: sourceReport(otherOffer) } })).response.status, 403);
    assert.equal((await request("/api/disruptions/preview", { ...options(), token: supplier, bearer: true, body: { mode: "cancel_show", admissionRefundMinor: 3500 } })).response.status, 403);
    assert.equal((await request("/api/disruptions", { ...options(), token: crew, bearer: true })).response.status, 403);
  });
  for (const supplierId of ["northside", "sister"]) { const current = await workspace(); await command(sourceReport(current.offers.find(offer => offer.supplierId === supplierId)!)); }
  let assessment: DisruptionResult;
  await check("actual local engine retains all twelve alternatives and bounded source conclusions", async () => {
    assessment = await command({ type: "assess" }); const current = assessment.workspace, result = current.assessments.at(-1)!;
    assert.equal(result.generated, 12); assert.equal(result.conclusion, "no_feasible_candidate"); assert.equal(result.engineUnavailable, 0); assert.equal(current.assessmentIsCurrent, true); assert.equal(current.providerActionsEnabled, false); assert.match(result.scope, /bounded search/);
  });
  let preview = await readPreview("cancel_show", 3500);
  await check("preview exposes no fabricated money and does not mutate state", async () => {
    const before = await getShow(session.actor.tenantId); assert.equal(preview.capturedTickets, 0); assert.equal(preview.newRefundMinor, 0); assert.deepEqual(preview.lines, []);
    assert.equal((await request("/api/disruptions/preview", { ...options(), body: { mode: "cancel_show", admissionRefundMinor: 1000 } })).response.status, 400);
    assert.deepEqual(await getShow(session.actor.tenantId), before);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM on_payment_intents WHERE tenant_id=$1", [session.actor.tenantId])).rows[0].n, 0);
  });
  await check("a new source invalidates both the old assessment and exact amount preview", async () => {
    const current = await workspace(); await command(sourceReport(current.offers[0]!)); assert.equal((await workspace()).assessmentIsCurrent, false);
    const attempt = { type: "decide" as const, mode: "cancel_show" as const, assessmentId: assessment!.receipt.recordId!, previewDigest: preview.digest, admissionRefundMinor: 3500, detail: "Owned synthetic HTTP cancellation review; no actual human or supplier approval is claimed.", confirmed: true as const };
    let result = await request("/api/disruptions/commands", { ...options(), body: { idempotencyKey: randomUUID(), expectedRevision: (await workspace()).revision, command: attempt } }); assert.equal(result.response.status, 409); assert.equal(result.value.code, "STALE_DISRUPTION_ASSESSMENT");
    assessment = await command({ type: "assess" });
    result = await request("/api/disruptions/commands", { ...options(), body: { idempotencyKey: randomUUID(), expectedRevision: (await workspace()).revision, command: { ...attempt, assessmentId: assessment.receipt.recordId! } } }); assert.equal(result.response.status, 409); assert.equal(result.value.code, "CANCELLATION_PREVIEW_CHANGED");
    preview = await readPreview("cancel_show", 3500);
  });
  const beforeCancellation = await getShow(session.actor.tenantId);
  let cancellation: DisruptionResult;
  await check("full cancellation publishes the internal notice while retaining crew and all original records", async () => {
    cancellation = await command({ type: "decide", mode: "cancel_show", assessmentId: assessment!.receipt.recordId!, previewDigest: preview.digest, admissionRefundMinor: 3500, detail: "Owned synthetic HTTP decision: close remaining performances and retain all original supplier and crew obligations.", confirmed: true });
    const current = await getShow(session.actor.tenantId); assert.equal(current.cancellationDecision!.mode, "cancel_show"); assert.deepEqual(current.financialEvidence, beforeCancellation.financialEvidence); assert.deepEqual(current.sheets.slice(0, beforeCancellation.sheets.length), beforeCancellation.sheets); assert.deepEqual(current.crewNextCalls, beforeCancellation.crewNextCalls); assert.ok(current.tasks.find(task => task.id === "headliner")!.cancellation); assert.ok(!current.tasks.find(task => task.id === "strike")!.cancellation);
    const show = await request("/api/show", options()); assert.equal(show.response.status, 200); assert.ok(show.value.readiness.every((report: { ready: boolean; gates: { id: string; complete: boolean }[] }) => !report.ready && report.gates.find(gate => gate.id === "disruption")?.complete === false));
    const own = await request("/api/crew", { ...options(), token: crew, bearer: true }); assert.equal(own.response.status, 200); assert.ok(own.value.sheet.calls.some((call: { name: string }) => call.name.startsWith("Cancelled · "))); assert.doesNotMatch(JSON.stringify(own.value), /captureReference|refundReference|sessionHash|financialEvidence/);
  });
  await check("terminal cancellation cannot be replaced; stop and readback retain its original identity", async () => {
    const next = await readPreview("cancel_show", 3500); assert.equal(next.ready, false); assert.match(next.blockers.join(" "), /already has a full cancellation/);
    const id = cancellation!.receipt.recordId!; await command({ type: "stop_remedies", decisionId: id, detail: "Owned synthetic stop of unstarted instructions while retaining the current operating cancellation." });
    await command({ type: "reconcile_remedies", decisionId: id }); const current = await workspace(); assert.equal(current.decision!.id, id); assert.ok(current.decision!.remediesStoppedAt); assert.equal(current.historicalDecisions.length, 1); assert.equal(current.remedies.length, 0);
  });
  await check("support-only review separates headliner cancellation from still-required support clearance", async () => {
    const initial = await workspace(support); await command(sourceReport(initial.offers[0]!), support);
    const assessed = await command({ type: "assess" }, support), exact = await readPreview("support_only", 1000, support);
    await command({ type: "decide", mode: "support_only", assessmentId: assessed.receipt.recordId!, previewDigest: exact.digest, admissionRefundMinor: 1000, detail: "Owned synthetic support-only review: headliner and VIP perk cancelled; support still requires separate current clearance.", confirmed: true }, support);
    const current = await getShow(support.actor.tenantId); assert.ok(current.tasks.find(task => task.id === "headliner")!.cancellation); assert.ok(!current.tasks.find(task => task.id === "support")!.cancellation); assert.ok(!current.tasks.find(task => task.id === "strike")!.cancellation); assert.equal(current.state, "standby");
    assert.equal(current.tickets.length, 0); assert.equal(current.financialEvidence.length, 0); assert.equal(current.crewCues!.length, 0);
  });
  await check("revoked exact capability and foreign command recovery remain denied", async () => {
    const expired = randomBytes(32).toString("base64url"), actor = { ...session.actor, id: `producer:expired:${randomUUID()}` };
    await pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,clock_timestamp()-interval '1 second')", [sessionTokenHash(expired), actor.tenantId, actor]);
    assert.equal((await request("/api/disruptions", { ...options(), token: expired })).response.status, 401);
    assert.equal((await request(`/api/disruptions/commands/${cancellation!.receipt.commandId}`, options(other))).response.status, 404);
    assert.equal((await request("/api/disruptions", { ...options(), token: randomBytes(32).toString("base64url") })).response.status, 401);
  });
  await check("disruption page serves the actual production shell and current notice", async () => {
    const page = await fetch(origin + "/disruptions", { headers: { cookie: `${cookie}=${session.token}` } }); assert.equal(page.status, 200); const html = await page.text(); assert.match(html, /The show changed/); assert.match(html, /Disruption desk/);
  });
  await check("all original native histories and fixed capability expiries remain unchanged", async () => {
    assert.deepEqual(await nativeBefore(), native.baseline);
    for (const access of Object.values(native.access)) { const row = (await pool.query("SELECT actor,expires_at FROM on_sessions WHERE token_hash=$1", [sessionTokenHash(access.token)])).rows[0]; assert.deepEqual(row.actor, access.actor); assert.equal(row.expires_at.toISOString(), access.expiresAt); }
  });
} catch (error) { process.exitCode = 1; const message = error instanceof Error ? error.message : "HTTP qualification failed"; if (!results.some(result => result.status === "failed")) results.push({ name: "Qualification setup or sequence", status: "failed", elapsedMs: 0, message }); console.error(message); }
finally {
  const preserved = digest(await nativeBefore()) === digest(native.baseline);
  const report = { at: new Date().toISOString(), origin, directory, providerTransports: "disabled", actualProviderCalls: false, nativeFixturePreserved: preserved, passed: results.filter(result => result.status === "passed").length, failed: results.filter(result => result.status === "failed").length, results };
  await writeFile(`${directory}/results.json`, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ directory, passed: report.passed, failed: report.failed, nativeFixturePreserved: preserved }));
  await pool.end();
}
