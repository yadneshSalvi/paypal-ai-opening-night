/** Compiled loopback HTTP → actual services/engine/PG. No browser, model or provider calls. */
import "./supplier-admin-runtime.mjs";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { digest } from "../../src/domain/hash";
import { plusMinutes } from "../../src/domain/time";
import { PRODUCTION_SCOPE_HEADER } from "../../src/domain/rehearsal-contracts";
import type { AdminResult, AdminWorkspace, NegotiationRound } from "../../src/domain/supplier-admin/contracts";
import type { SupplierAdminCommand, SupplierAdminEnvelope } from "../../src/domain/supplier-admin/commands";
const directory = ".private/supplier-admin/http", resultFile = directory + "/RESULT.json";
if (existsSync(resultFile)) throw new Error("The original compiled HTTP result is retained; do not repeat its mutations.");
const fixture = JSON.parse(await readFile(directory + "/fixture.json", "utf8"));
if (fixture.state !== "ready" || fixture.mode !== "http" || fixture.origin !== "http://127.0.0.1:4619") throw new Error("Original prepared HTTP-only fixture required");
const origin = fixture.origin as string, pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 }), checks: string[] = [], journal: unknown[] = [];
let requests = 0;
async function request(path: string, persona?: string, body?: unknown, extra: Record<string, string> = {}) {
  const access = persona ? fixture.access[persona] : null; requests++;
  const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { ...(access ? { Authorization: "Bearer " + access.token, [PRODUCTION_SCOPE_HEADER]: access.actor.tenantId } : {}), ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json" }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000), redirect: "error" });
  const value = await response.json(); return { response, value };
}
async function workspace(persona: string): Promise<AdminWorkspace> { const result = await request("/api/supplier-admin", persona); assert.equal(result.response.status, 200); return result.value; }
async function act(persona: string, command: SupplierAdminCommand, expect = "completed") {
  const state = await workspace(persona), envelope: SupplierAdminEnvelope = { commandId: randomUUID(), expectedRevision: state.revision, sessionFingerprint: state.sessionFingerprint, expiresAt: state.expiresAt, command };
  const file = `${directory}/command-${envelope.commandId}.json`; await writeFile(file, JSON.stringify({ phase: "retained_before_dispatch", persona, envelope, requestDigest: digest(envelope) }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const result = await request("/api/supplier-admin/commands", persona, envelope); assert.equal(result.response.status, 200); const value = result.value as AdminResult;
  assert.equal(value.receipt.status, expect, value.receipt.message); assert.equal(value.receipt.commandId, envelope.commandId); assert.equal(value.receipt.requestDigest, digest(envelope));
  journal.push({ persona, envelope, receipt: value.receipt }); return { ...value, envelope };
}
async function fixedSessions() { return (await pool.query("SELECT token_hash,tenant_id,actor,expires_at::text AS expiry FROM on_sessions ORDER BY token_hash")).rows; }
async function productionCommand(command: unknown) {
  const state = await request("/api/show", "producer"); assert.equal(state.response.status, 200);
  const result = await request("/api/show", "producer", { idempotencyKey: randomUUID(), expectedRevision: state.value.show.revision, command }); assert.equal(result.response.status, 200, result.value.error); return result.value;
}
try {
  const initialSessions = await fixedSessions(), before = (await request("/api/show", "producer")).value.show;
  const originalExecution = before.rentalExecutions.find((value: { id: string }) => value.id === fixture.original.executionId), originalMoney = digest(before.financialEvidence), originalQuotes = (await pool.query("SELECT document FROM on_supplier_quotes WHERE tenant_id=$1 AND supplier_id IN ('brightline','northside','sister') ORDER BY id", [fixture.access.producer.actor.tenantId])).rows;
  assert.equal((await request("/api/supplier-admin")).response.status, 401); checks.push("anonymous access refused");
  for (const path of ["/suppliers/manage", "/suppliers/manage/owner"]) {
    requests++; const response = await fetch(origin + path, { signal: AbortSignal.timeout(15000), redirect: "error" }), html = await response.text();
    assert.equal(response.status, 200); assert.match(html, /The supplier desk\./); assert.match(html, /name="referrer" content="same-origin"/);
  }
  checks.push("both administration documents served from the compiled application");
  const connected = await request("/api/supplier-admin/session", "owner", {}), ownerCookie = connected.response.headers.get("set-cookie") ?? "";
  assert.equal(connected.response.status, 200); assert.equal(connected.value.expiresAt, fixture.access.owner.expiresAt); assert.equal(connected.value.connected, true);
  assert.ok(ownerCookie.startsWith("opening-night-supplier-admin-owner=" + fixture.access.owner.token + ";")); assert.match(ownerCookie, /HttpOnly/i); assert.match(ownerCookie, /SameSite=strict/i); assert.match(ownerCookie, /Path=\/api\/supplier-admin(?:;|$)/i);
  const cookieHeaders = { Cookie: ownerCookie.split(";")[0]!, [PRODUCTION_SCOPE_HEADER]: fixture.access.owner.actor.tenantId }, connectedRead = await request("/api/supplier-admin", undefined, undefined, { ...cookieHeaders, "x-opening-supplier-admin-role": "supplier" });
  assert.equal(connectedRead.response.status, 200); assert.equal(connectedRead.value.actorId, fixture.access.owner.actor.id);
  assert.equal((await request("/api/supplier-admin", undefined, undefined, cookieHeaders)).response.status, 401); checks.push("separate HttpOnly owner connection retained original full expiry and cannot adopt producer access");
  const ownerBefore = await workspace("owner"), supplierId = fixture.supplierId as `enrolled-${string}`;
  assert.equal(ownerBefore.cards.length, 1); assert.equal(ownerBefore.cards[0]!.status, "invited"); assert.equal(ownerBefore.originalServices.length, 0); checks.push("independent own-supplier scope");
  await act("owner", { type: "admit", supplierId, enrollmentId: ownerBefore.cards[0]!.enrollmentId, detail: "Separate controlled supplier owner accepts its original fixed admission. No external company participation is claimed.", confirmed: true }); checks.push("separate owner accepted original admission");
  const wrong = await act("producer", { type: "rotate_key", supplierId, previousKeyId: null, detail: "Producer must not rotate the independently admitted supplier's signing authority.", confirmed: true }, "refused"); assert.equal(wrong.receipt.code, "SUPPLIER_ADMIN_SCOPE"); checks.push("producer cannot impersonate supplier signer");
  const key = await act("owner", { type: "rotate_key", supplierId, previousKeyId: null, detail: "Controlled owner explicitly creates its independent key for bounded signed replies.", confirmed: true });
  const state = key.workspace, delivery = plusMinutes(state.clock, 20), latest = plusMinutes(state.clock, 40), deadline = plusMinutes(state.clock, 15);
  const inventory = await act("owner", { type: "inventory", supplierId, previousId: null, unitId: "COMPILED-CW-01", label: "Compiled controlled touring desk", model: "Declared compatible LX touring desk", owned: true, available: true, availableFrom: state.clock, availableUntil: state.accessUntil, compatible: true, qualifiedDriver: true, conditionVerified: true,
    capabilityEvidence: "Controlled owned capability source: cue import, data outputs and power configuration. No physical certification is claimed.", driverEvidence: "Controlled qualified-driver source; no real participant is named or claimed.", conditionEvidence: "Controlled pre-dispatch condition source; actual delivery and inspection remain unobserved.", reference: "Compiled controlled owned inventory record", detail: "The separate supplier declares this individually identified unit and future availability; original commitments remain retained.", confirmed: true });
  const terms = await act("owner", { type: "terms", supplierId, previousId: null, inventoryId: inventory.receipt.recordId, feeMinor: 48000, depositMinor: 30000, earliestDelivery: delivery, latestDelivery: latest, scenarioDeadline: deadline, validForMinutes: 15,
    cancellation: "A quote reserves nothing. An unpaid provisional hold may be released separately. Payment and physical acceptance require their original authorities.", reference: "Compiled controlled immutable terms", detail: "Supplier owner publishes the exact current delivery, fee and deposit terms as a new immutable controlled source.", confirmed: true }); checks.push("owned inventory and immutable current term editions");
  const supplierBounds = { feeMinMinor: 40000, feeMaxMinor: 48000, depositMinMinor: 20000, depositMaxMinor: 30000, earliestDelivery: delivery, latestDelivery: latest, maxRounds: 2 };
  const mandate = await act("owner", { type: "supplier_mandate", supplierId, inventoryId: inventory.receipt.recordId, termsId: terms.receipt.recordId, keyId: key.receipt.recordId, bounds: supplierBounds, validForMinutes: 15, detail: "Separate controlled supplier review bounds fee, deposit, delivery, two rounds and a fixed real expiry.", confirmed: true });
  const producer = await workspace("producer"), rfq = await act("producer", { type: "request_quotes", supplierId, supplierMandateId: mandate.receipt.recordId, reviewDigest: producer.reviewDigest, bounds: { ...supplierBounds, feeMinMinor: 0, feeMaxMinor: 46000, depositMinMinor: 0, depositMaxMinor: 25000 }, validForMinutes: 15, detail: "Producer separately reviews current source and original accepted obligations under these exact commercial bounds.", confirmed: true });
  const reply = await act("producer", { type: "negotiate", supplierId, rfqId: rfq.receipt.recordId, previousRoundId: null, feeMinor: 45000, depositMinor: 25000, deliveryAt: delivery, confirmed: true }), round = reply.workspace.cards[0]!.rfqs[0]!.rounds[0]!;
  assert.equal(round.data.outcome.kind, "quote"); if (round.data.outcome.kind !== "quote") throw new Error("Current bounded quote missing"); const quote = round.data.outcome.quote;
  assert.equal(round.verified, true); assert.equal(quote.offer.feeMinor, 45000); assert.equal(quote.offer.depositMinor, 25000); checks.push("separate mandates produced one actual signed bounded quote");
  const admission = await act("producer", { type: "accept_quote", supplierId, rfqId: rfq.receipt.recordId, roundId: round.id, quoteDigest: quote.termsDigest, confirmed: true });
  const recovered = await request("/api/supplier-admin/commands/" + admission.receipt.commandId, "producer"); assert.equal(recovered.value.receipt.requestDigest, admission.receipt.requestDigest);
  const replay = await request("/api/supplier-admin/commands", "producer", admission.envelope); assert.equal(replay.value.replayed, true); assert.equal(replay.value.receipt.recordId, admission.receipt.recordId); checks.push("immutable original GET and exact replay");
  const generated = await productionCommand({ type: "generate" }), candidates = generated.show.runs.at(-1).candidates, candidate = candidates.find((value: { family: string; patch: { offerId: string } }) => value.family === "doors" && value.patch.offerId === quote.offer.id);
  assert.equal(candidate.report.engine.status, "passed"); assert.equal(candidate.report.status, "feasible_with_approval"); checks.push("compiled server ran actual isolated licensed engine");
  const approved = await productionCommand({ type: "approve", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: candidate.approvals.map((value: { id: string }) => value.id) }); assert.equal(approved.show.approvedPlan.digest, candidate.digest); checks.push("separate actual current-source plan approval");
  const held = await act("producer", { type: "reserve", supplierId, quoteId: quote.id, planDigest: candidate.digest, acceptCaptureTerms: true, confirmed: true });
  const heldShow = (await request("/api/show", "producer")).value.show, execution = heldShow.rentalExecutions.find((value: { id: string }) => value.id === held.receipt.recordId);
  assert.equal(execution.quoteId, quote.id); assert.equal(execution.state, "held"); assert.equal(execution.paymentRootId, null); assert.equal(execution.authorizationId, null); checks.push("actual reservation held exact unit without payment or receipt");
  assert.equal(digest(heldShow.financialEvidence), originalMoney); assert.equal(digest(heldShow.rentalExecutions.find((value: { id: string }) => value.id === fixture.original.executionId)), digest(originalExecution)); assert.equal(digest((await pool.query("SELECT document FROM on_supplier_quotes WHERE tenant_id=$1 AND supplier_id IN ('brightline','northside','sister') ORDER BY id", [fixture.access.producer.actor.tenantId])).rows), digest(originalQuotes)); checks.push("all original money quotes signatures and accepted rental preserved");
  const rotated = await act("owner", { type: "rotate_key", supplierId, previousKeyId: key.receipt.recordId, detail: "Controlled owner rotates its independent signer while retaining every historical signature and original held unit.", confirmed: true });
  assert.equal(rotated.workspace.cards[0]!.rfqs[0]!.rounds[0]!.verified, true); assert.equal(rotated.workspace.cards[0]!.rfqs[0]!.status, "admitted_source_changed");
  const refused = await act("producer", { type: "reserve", supplierId, quoteId: quote.id, planDigest: candidate.digest, acceptCaptureTerms: true, confirmed: true }, "refused"); assert.equal(refused.receipt.code, "MANAGED_RFQ_SOURCE_CHANGED"); checks.push("key rotation preserves history and refuses new stale commitment");
  assert.equal(digest(await fixedSessions()), digest(initialSessions)); checks.push("all fixed capabilities and full expiries unchanged");
  assert.match(refused.workspace.cards[0]!.enrollment.merchant.message, /no matching verified merchant/i); checks.push("managed merchant absence remains explicit");
  const result = { state: "qualified", checks, checksPassed: checks.length, requests, at: new Date().toISOString(), actualProviderCalls: 0, actualModelCalls: 0, actualExternalMessages: 0, actualPhysicalHandoffs: 0, fixture: "http only; native original baseline remains separate", managedQuoteId: quote.id, managedExecutionId: execution.id, sourceMutationAttribution: journal };
  await writeFile(resultFile, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 }); console.log(JSON.stringify({ state: result.state, checks: checks.length, requests, actualProviderCalls: 0, actualModelCalls: 0 }));
} catch (error) {
  await writeFile(resultFile, JSON.stringify({ state: "failed", at: new Date().toISOString(), checksPassed: checks, requests, journal, failure: error instanceof Error ? { name: error.name, message: error.message } : { name: "Unknown failure" }, policy: "Retain original fixture and command files. No automatic POST replay or reseed." }, null, 2) + "\n", { flag: "wx", mode: 0o600 }); throw error;
} finally { await pool.end(); }
