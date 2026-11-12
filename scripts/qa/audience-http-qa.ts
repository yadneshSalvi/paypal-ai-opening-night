/** Compiled production HTTP lifecycle. Separate controlled fixture; never mutates native review state. */
import "./audience-review-client-runtime.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { digest } from "../../src/domain/hash";
import type { AudienceCommand, AudienceEnvelope, AudienceMessageView } from "../../src/domain/audience/contracts";
import { parseAttendeeView, parseAudienceMessage, parseAudienceResult, parseAudienceWorkspace } from "../../src/components/audience/validation";
import { audienceSha256 } from "./audience-inputs.mjs";
import { selectedAudienceFixture } from "./audience-fixture.mjs";

const selected = await selectedAudienceFixture("http"), directory = selected.base, fixture = selected.fixture, origin = "http://127.0.0.1:4594", run = directory + "/qualification";
if (process.env.VERCEL || fixture.state !== "ready" || fixture.origin !== origin || !(globalThis as typeof globalThis & { openingNightAudienceGuard?: { ownedReviewClient: boolean } }).openingNightAudienceGuard?.ownedReviewClient) throw new Error("Exact owned compiled HTTP fixture required");
if (existsSync(run)) throw new Error("The original HTTP qualification is preserved. Inspect its exact receipts; no automatic rerun or reseed is supported.");
await mkdir(run, { mode: 0o700 });
const expectations = ["private entry and exact local fonts", "ordinary attendee bearer isolation and original receipt", "all declared cancellation and unknown views", "same origin and unrelated API denial", "unreceived exact-access collision denial", "before-dispatch absence then explicit unchanged retry", "separate exact approval", "bounded reserved pass is not delivery", "lost work reply GET-first recovery without resending", "remaining explicit pass and per-recipient inboxes", "committed command reply loss recovers original", "corrupted preview rejects while original remains exact", "held original GET releases without mutation", "controlled unreadable attendee denial changes no capability", "explicit stop retains completed partial history", "all original non-audience rows and expiries preserved"];
await writeFile(run + "/expectations.json", JSON.stringify({ version: 1, expectations, sha256: digest(expectations), sourceInputDigest: fixture.sourceInputDigest, fixtureSha256: audienceSha256(selected.bytes), selectedFixture: selected.filename, actualExternalActions: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const requests: unknown[] = [], passed: string[] = []; let sequence = 0;
const record = async (name: string, value: unknown) => writeFile(run + "/" + String(++sequence).padStart(3, "0") + "-" + name + ".json", JSON.stringify({ at: new Date().toISOString(), value }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: "-c search_path=" + fixture.schema, max: 2 });
async function originalRows() {
  const result: Record<string, { rows: number; digest: string }> = {};
  const tables = (await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name NOT LIKE 'on_audience_%' ORDER BY table_name")).rows;
  for (const table of tables) {
    assert.match(table.table_name, /^[a-z0-9_]+$/);
    const rows = (await pool.query('SELECT to_jsonb(t) AS row FROM "' + table.table_name + '" t ORDER BY to_jsonb(t)::text')).rows.map(row => row.row);
    result[table.table_name] = { rows: rows.length, digest: digest(rows) };
  }
  return result;
}
const before = await originalRows(); await record("original-rows-before", before);
type Persona = string;
async function request(path: string, persona: Persona | null = "main", init: RequestInit = {}) {
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  const headers = new Headers(init.headers);
  if (persona) { headers.set("authorization", "Bearer " + fixture.access[persona].token); headers.set("x-opening-night-production", fixture.access[persona].actor.tenantId); }
  if (init.method === "POST") { if (!headers.has("origin")) headers.set("origin", origin); if (!headers.has("content-type")) headers.set("content-type", "application/json"); }
  try {
    const response = await fetch(origin + path, { ...init, headers, redirect: "manual", cache: "no-store" });
    requests.push({ path, method: init.method ?? "GET", persona, status: response.status }); return response;
  } catch (error) { requests.push({ path, method: init.method ?? "GET", persona, response: "missing", error: error instanceof Error ? error.name : "unknown" }); throw error; }
}
async function workspace(persona: Persona = "main") { const response = await request("/api/audience", persona); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store"); return parseAudienceWorkspace(await response.json()); }
async function message(id: string) { const response = await request("/api/audience/messages/" + id); assert.equal(response.status, 200); return parseAudienceMessage(await response.json()); }
async function prepare(command: AudienceCommand): Promise<AudienceEnvelope> {
  const state = await workspace(); return { commandId: randomUUID(), expectedRevision: state.revision, sessionFingerprint: state.sessionFingerprint, sessionExpiresAt: state.expiresAt, command };
}
async function dispatch(envelope: AudienceEnvelope) { await record("retained-original-command", envelope); return request("/api/audience/commands", "main", { method: "POST", body: JSON.stringify(envelope) }); }
async function command(command: AudienceCommand) {
  const envelope = await prepare(command), response = await dispatch(envelope); assert.equal(response.status, 200);
  const result = parseAudienceResult(await response.json()); assert.equal(result.receipt.commandId, envelope.commandId); assert.equal(result.receipt.requestDigest, digest(envelope)); return { envelope, result };
}
async function control(action: string) {
  const response = await request("/__audience_control", null, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ key: fixture.bootstrapKey, action }).toString() }); assert.equal(response.status, 303);
}
async function original(envelope: AudienceEnvelope) {
  const response = await request("/api/audience/commands/" + envelope.commandId); assert.equal(response.status, 200);
  const result = parseAudienceResult(await response.json()); assert.equal(result.receipt.requestDigest, digest(envelope)); assert.equal(result.workspace.sessionFingerprint, envelope.sessionFingerprint); assert.equal(result.workspace.expiresAt, envelope.sessionExpiresAt); return result;
}
async function work(view: AudienceMessageView, id: string) {
  const pass = view.passes.find(item => item.id === id)!; assert.ok(pass);
  const read = await request("/api/audience/commands/" + pass.id); assert.equal(read.status, 200);
  const saved = parseAudienceResult(await read.json()); assert.equal(saved.receipt.action, "deliver_message"); assert.equal(saved.receipt.recordId, pass.id);
  await record("retained-original-pass", { commandId: pass.id, originalRequestDigest: saved.receipt.requestDigest, proof: pass.proof, sessionFingerprint: view.sessionFingerprint, sessionExpiresAt: view.expiresAt });
  return request("/api/audience/work", "main", { method: "POST", body: JSON.stringify({ commandId: pass.id, proof: pass.proof }) });
}
async function attendee(name: string) {
  const link = fixture.attendees[name], response = await request("/api/attendee", null, { headers: { authorization: "Bearer " + link.url.split("#")[1] } }); assert.equal(response.status, 200); return parseAttendeeView(await response.json());
}
const pass = async (index: number, evidence: unknown = {}) => { passed.push(expectations[index]!); await record("passed-check", { expectation: expectations[index], evidence }); };
let state: "qualified" | "failed" = "failed";
try {
  const entry = await request("/attendee", null); assert.equal(entry.status, 200); const html = await entry.text(); assert.ok(html.includes("Opening Night"));
  for (const access of Object.values(fixture.access) as { token: string }[]) assert.equal(html.includes(access.token), false); assert.equal(html.includes(fixture.bootstrapKey), false);
  const landing = await request("/__audience_fixture", null), landingHtml = await landing.text(); assert.equal(landingHtml.includes(fixture.bootstrapKey), false); assert.match(landingHtml, /type="password"/);
  const fonts = JSON.parse(await readFile(".private/audience-font-cache/provenance.json", "utf8"));
  for (const font of fonts.records) { const response = await request(font.publicPath, null); assert.equal(response.status, 200); assert.equal(audienceSha256(Buffer.from(await response.arrayBuffer())), font.sha256); }
  await pass(0, { faces: fonts.records.length, credentialValuesInUnauthenticatedEntry: 0 });
  const vip = await attendee("main-vip"); assert.equal(vip.receipt.grossMinor, 5000); assert.equal(vip.receipt.admissionMinor, 3500); assert.equal(vip.receipt.perkMinor, 1500); assert.equal(vip.receipt.confirmedRefundMinor, 1500); assert.equal(vip.receipt.remainingAdmissionMinor, 3500); assert.equal(vip.inbox[0]!.sourceIsCurrent, false);
  assert.equal((await request("/api/attendee", "main")).status, 401);
  assert.equal((await request("/api/audience", null, { headers: { authorization: "Bearer " + fixture.attendees["main-vip"].url.split("#")[1] } })).status, 401);
  assert.equal((await request("/api/audience", "crew")).status, 403); await pass(1);
  const unknown = await attendee("unknown-vip"), cancelled = await attendee("cancelled-vip"), support = await attendee("support-vip");
  assert.equal(unknown.receipt.verification, "verified"); assert.equal(unknown.receipt.admission, "unverified"); assert.equal(unknown.receipt.confirmedRefundMinor, 0); assert.equal(unknown.receipt.instructions[0]!.status, "unknown");
  assert.equal(cancelled.event.program, "cancelled"); assert.equal(cancelled.receipt.confirmedRefundMinor, 5000); assert.equal(cancelled.receipt.admission, "refunded");
  assert.equal(support.event.program, "support_only"); assert.equal(support.event.scheduleStatus, "under_review"); assert.equal(support.receipt.confirmedRefundMinor, 2500); await pass(2);
  for (const path of ["/api/session", "/api/payments", "/api/commands", "/.private/audience-stage17/runtime.env", "/.artifacts/audience-http-4594/fixture.json", "/_next/server/app/page.js", "/audience/fonts/%2e%2e%2f.private/runtime.env"]) assert.equal((await request(path, null)).status, 404);
  const first = await workspace(), recipients = first.capabilities.filter(item => item.sessionMatches && item.state === "active").map(item => item.id); assert.equal(recipients.length, 2);
  const wrongOrigin = await request("/api/audience/commands", "main", { method: "POST", headers: { origin: "http://localhost:4594" }, body: "{}" }); assert.equal(wrongOrigin.status, 403); await pass(3);
  const initial = await prepare({ type: "draft_message", kind: "event_update", recipientIds: recipients, sourceDigest: first.sourceDigest, templateVersion: "audience-v1", note: "Controlled compiled HTTP review. Each ticket retains its original amounts. No actual human approval or external audience contact is claimed.", validForMinutes: 15 });
  const alternate = await workspace("alternate"); assert.equal(alternate.actorId, first.actorId); assert.equal(alternate.expiresAt, first.expiresAt); assert.notEqual(alternate.sessionFingerprint, first.sessionFingerprint);
  const collision = await request("/api/audience/commands", "alternate", { method: "POST", body: JSON.stringify(initial) }); assert.equal(collision.status, 403); assert.equal((await collision.json()).code, "AUDIENCE_ORIGINAL_SESSION_REQUIRED"); await pass(4);
  await control("command-before-dispatch"); const missing = await dispatch(initial); assert.equal(missing.status, 503);
  const absent = await request("/api/audience/commands/" + initial.commandId); assert.equal(absent.status, 404); assert.equal((await absent.json()).code, "AUDIENCE_RECEIPT_NOT_FOUND");
  const retry = await dispatch(initial); assert.equal(retry.status, 200); const drafted = parseAudienceResult(await retry.json()); assert.equal(drafted.receipt.requestDigest, digest(initial));
  let current = await message(drafted.receipt.recordId); assert.equal(current.approval, null); assert.equal(current.deliveries.length, 0); await pass(5, { originalBodySha256: digest(initial), explicitSameBodyRetryAfter404: true });
  await command({ type: "approve_message", draftId: current.draft.id, draftDigest: current.draft.digest, previewDigest: current.preview.digest, controlledInboxOnly: true, confirmed: true }); current = await message(current.draft.id); assert.ok(current.approval); assert.equal(current.deliveries.length, 0); await pass(6, { draftDigest: current.draft.digest, approvalDigest: current.approval.digest });
  const reserved = await command({ type: "deliver_message", approvalId: current.approval.id, approvalDigest: current.approval.digest, limit: 1, confirmed: true }); current = await message(current.draft.id); assert.equal(current.deliveries.length, 0); assert.equal(current.passes[0]!.state, "pending"); await pass(7);
  await control("work-reply-lost"); let lost = false; try { const response = await work(current, reserved.result.receipt.recordId); await response.json(); } catch { lost = true; } assert.equal(lost, true);
  const recoveredPass = await original(reserved.envelope); assert.equal(recoveredPass.receipt.action, "deliver_message"); current = await message(current.draft.id); assert.equal(current.deliveries.length, 1); assert.equal(current.passes.find(item => item.id === reserved.result.receipt.recordId)!.processed, 1); await pass(8, { completedOriginalPass: 1, remainingRecipients: 1, workResent: false });
  const residual = await command({ type: "deliver_message", approvalId: current.approval!.id, approvalDigest: current.approval!.digest, limit: 1, confirmed: true }); current = await message(current.draft.id);
  const worked = await work(current, residual.result.receipt.recordId); assert.equal(worked.status, 200); parseAudienceResult(await worked.json()); current = await message(current.draft.id); assert.equal(current.deliveries.length, 2); assert.equal(new Set(current.deliveries.map(item => item.capabilityId)).size, 2);
  for (const name of ["main-vip", "main-standard"]) { const read = await attendee(name), own = current.deliveries.find(item => item.capabilityId === read.capabilityId)!; assert.ok(read.inbox.some(item => item.digest === own.digest && item.body === own.body)); assert.equal(read.inbox.filter(item => item.sourceIsCurrent).length, 1); } await pass(9);
  const lostEnvelope = await prepare({ type: "draft_message", kind: "event_update", recipientIds: recipients, sourceDigest: (await workspace()).sourceDigest, templateVersion: "audience-v1", note: "Controlled committed response loss: this saved draft remains unapproved.", validForMinutes: 15 });
  await control("command-reply-lost"); let responseLost = false; try { const response = await dispatch(lostEnvelope); await response.json(); } catch { responseLost = true; } assert.equal(responseLost, true);
  const recovered = await original(lostEnvelope); assert.equal(recovered.receipt.action, "draft_message"); const originalDraft = await message(recovered.receipt.recordId); assert.equal(originalDraft.approval, null); await pass(10, { originalCommandResent: false, recoveredRequestDigest: recovered.receipt.requestDigest });
  await control("message-hash-corrupted"); const corrupt = await request("/api/audience/messages/" + recovered.receipt.recordId); assert.equal(corrupt.status, 200); await assert.rejects(parseAudienceMessage(await corrupt.json()), /hash failed verification/);
  const intact = await message(recovered.receipt.recordId); assert.deepEqual(intact.draft, originalDraft.draft); await pass(11);
  await control("receipt-lookup-held"); const waiting = request("/api/audience/commands/" + lostEnvelope.commandId);
  for (let index = 0; index < 40; index++) { const body = await (await request("/__audience_fixture", null)).text(); if (body.includes("Held read: <b>yes</b>")) break; if (index === 39) throw new Error("Original receipt GET did not reach its declared hold"); await new Promise(resolve => setTimeout(resolve, 20)); }
  await control("release"); const released = await waiting; assert.equal(released.status, 200); assert.equal(parseAudienceResult(await released.json()).receipt.commandId, lostEnvelope.commandId); await pass(12);
  await control("attendee-read-denied"); const denied = await request("/api/attendee", null, { headers: { authorization: "Bearer " + fixture.attendees["main-standard"].url.split("#")[1] } }); assert.equal(denied.status, 401); await assert.rejects(denied.json()); assert.equal((await attendee("main-standard")).receipt.verification, "verified"); await pass(13, { transportDenialOnly: true, databaseRevocationClaim: false });
  let stopView = await message(recovered.receipt.recordId);
  await command({ type: "approve_message", draftId: stopView.draft.id, draftDigest: stopView.draft.digest, previewDigest: stopView.preview.digest, controlledInboxOnly: true, confirmed: true }); stopView = await message(stopView.draft.id);
  const firstStopPass = await command({ type: "deliver_message", approvalId: stopView.approval!.id, approvalDigest: stopView.approval!.digest, limit: 1, confirmed: true }); stopView = await message(stopView.draft.id);
  const partial = await work(stopView, firstStopPass.result.receipt.recordId); assert.equal(partial.status, 200); parseAudienceResult(await partial.json()); stopView = await message(stopView.draft.id);
  const remaining = await command({ type: "deliver_message", approvalId: stopView.approval!.id, approvalDigest: stopView.approval!.digest, limit: 1, confirmed: true });
  await command({ type: "stop_message", approvalId: stopView.approval!.id, approvalDigest: stopView.approval!.digest, detail: "Controlled compiled HTTP producer explicitly stops the remaining inbox after its original partial receipt.", confirmed: true }); stopView = await message(stopView.draft.id);
  assert.equal(stopView.deliveries.length, 1); assert.ok(stopView.stoppedAt); assert.equal(stopView.passes.find(item => item.id === remaining.result.receipt.recordId)!.state, "interrupted"); await pass(14);
  const after = await originalRows(); assert.deepEqual(after, before); await record("original-rows-after", after); await pass(15, { originalTableRowsUnchanged: true, financialOrSessionMutation: false }); state = "qualified";
} catch (error) {
  await record("first-failure", { name: error instanceof Error ? error.name : "Unknown", message: error instanceof Error ? error.message : "Unknown failure", passed });
  console.error("Compiled audience qualification failed; original private requests, outcomes and first failure were retained."); process.exitCode = 1;
} finally {
  const result = { version: 1, state, expectations: expectations.length, passed: passed.length, requests: requests.length, expectationHash: digest(expectations), sourceInputDigest: fixture.sourceInputDigest, actualProviderRequests: 0, actualExternalMessages: 0, actualHumanReviews: 0, physicalEntryClaims: 0, completedAt: new Date().toISOString() };
  await record("requests", requests); await writeFile(run + "/result.json", JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 }); await pool.end(); console.log(JSON.stringify(result));
}
