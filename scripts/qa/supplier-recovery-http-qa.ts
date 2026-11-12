/** Compiled HTTP qualification on distinct controlled identities; native fixture stays untouched. */
import "./supplier-recovery-disabled-providers.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { digest } from "../../src/domain/hash";
import { plusMinutes } from "../../src/domain/time";
import { rentalExecutionDigest } from "../../src/domain/rental-closeout";
import type { ConsoleData, ShowSnapshot } from "../../src/domain/contracts";
import type { SupplierRecoveryEnvelope, SupplierRecoveryResult, SupplierRecoveryWorkspace } from "../../src/server/supplier-recovery/contracts";
import type { SupplierTermInput } from "../../src/domain/supplier-recovery-command";

const directory = ".artifacts/supplier-recovery-http-4586", path = directory + "/http-proof.json";
const fixture = JSON.parse(await readFile(directory + "/fixture.json", "utf8")), nativeBytes = await readFile(".artifacts/supplier-recovery-native-4586/fixture.json"), native = JSON.parse(nativeBytes.toString());
const qualified = native.state === "ready" ? null : JSON.parse(await readFile(".artifacts/supplier-recovery-native-4586/preparation-qualified.json", "utf8"));
const inspected = qualified?.state === "ready_from_readonly_inspection" && qualified.fixtureSha256 === createHash("sha256").update(nativeBytes).digest("hex") && qualified.databaseMutations === 0;
if (fixture.state !== "ready" || native.state !== "ready" && !inspected || fixture.origin !== "http://127.0.0.1:4586" || fixture.access.producer.actor.tenantId === native.access.producer.actor.tenantId || fixture.database !== native.database || fixture.schema !== "terms_runtime" || native.schema !== fixture.schema) throw new Error("Distinct original HTTP and native fixtures in the owned schema are required");
if (existsSync(path)) throw new Error("The original HTTP run is retained; no reset or unreviewed retry is supported");
const proof: { state: string; startedAt: string; finishedAt?: string; failure?: string; nativePreserved?: boolean; checks: { name: string; at: string }[]; requests: unknown[]; commands: unknown[]; actualProviderRequests: number } = { state: "running", startedAt: new Date().toISOString(), checks: [], requests: [], commands: [], actualProviderRequests: 0 };
await writeFile(path, JSON.stringify(proof, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const save = async () => { await writeFile(path + ".next", JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 }); await rename(path + ".next", path); };
async function request(url: string, persona?: string, body?: unknown, extra: Record<string, string> = {}) {
  const response = await fetch(new URL(url, fixture.origin), { method: body === undefined ? "GET" : "POST", headers: { ...(persona ? { Authorization: "Bearer " + fixture.access[persona].token, "x-opening-night-production": fixture.access[persona].actor.tenantId } : {}), ...(body === undefined ? {} : { Origin: fixture.origin, "Content-Type": "application/json" }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000), redirect: "manual" });
  proof.requests.push({ path: url, persona: persona ?? "anonymous", method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { bodyDigest: digest(body) }), status: response.status }); await save();
  return response;
}
async function read(persona = "producer"): Promise<SupplierRecoveryWorkspace> { const response = await request("/api/supplier-recovery", persona); assert.equal(response.status, 200); return response.json(); }
async function show(): Promise<ShowSnapshot> { const response = await request("/api/show", "producer"); assert.equal(response.status, 200); return (await response.json() as ConsoleData).show; }
async function send(persona: string, command: SupplierRecoveryEnvelope["command"]) {
  const current = await read(persona), envelope: SupplierRecoveryEnvelope = { commandId: randomUUID(), expectedRevision: current.revision, command };
  proof.commands.push({ envelope, persona }); await save();
  const response = await request("/api/supplier-recovery/commands", persona, envelope), result = await response.json() as SupplierRecoveryResult;
  assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.receipt.requestDigest, digest(envelope));
  proof.commands.push({ commandId: envelope.commandId, receipt: result.receipt }); await save();
  return { envelope, result };
}
const check = async (name: string, work: () => Promise<void>) => { await work(); proof.checks.push({ name, at: new Date().toISOString() }); await save(); };
async function nativeSnapshot() {
  const result = {} as Record<string, unknown>;
  for (const endpoint of ["/api/show", "/api/rental-closeout", "/api/supplier-recovery"]) {
    const response = await fetch(new URL(endpoint, native.origin), { headers: { Authorization: "Bearer " + native.access.producer.token }, signal: AbortSignal.timeout(20000) }); assert.equal(response.status, 200);
    const data = await response.json(); delete data.serverAt;
    // Readiness reports are computed projections, unlike the stored show. Their
    // observation timestamp changes on each GET without any production write.
    if (endpoint === "/api/show") for (const report of data.readiness) delete report.computedAt;
    result[endpoint] = data;
  }
  return result;
}
try {
  const nativeBefore = await nativeSnapshot(), before = await show();
  const original = before.rentalExecutions!.find(item => item.id === fixture.original.executionId)!;
  const originalDigest = rentalExecutionDigest(original), originalMoney = digest(before.financialEvidence);
  await check("native baseline retains the actual original plan with replacement work unperformed", async () => {
    const workspace = (nativeBefore["/api/supplier-recovery"] as SupplierRecoveryWorkspace);
    assert.equal(workspace.cards.filter(card => card.reference).length, 0); assert.equal(workspace.requests.filter(row => row.expiresAt !== null).length, 0); assert.equal(workspace.requests.filter(row => row.expiresAt === null && row.status === "applied").length, 1); assert.equal(workspace.preview?.retained[0]?.verifiedFeeMinor, 48000);
  });
  await check("first entry and role boundaries are private and create no authority", async () => {
    const anonymous = await request("/api/supplier-recovery"); assert.equal(anonymous.status, 401); assert.match(anonymous.headers.get("cache-control")!, /no-store/);
    assert.equal((await request("/api/supplier-recovery", "sam")).status, 403);
    assert.equal((await read("other")).preview!.retained.length, 0);
    assert.deepEqual((await read("northside")).cards.map(card => card.supplierId), ["northside"]);
    assert.deepEqual((await read("supplier")).cards.map(card => card.supplierId), ["brightline"]);
  });
  const supplier = await read("northside"), card = supplier.cards[0]!;
  const terms: SupplierTermInput = { type: "publish_terms", offerId: card.offerId, previousTermId: null, sourceReportId: card.report?.id ?? null, deliveryAt: plusMinutes(supplier.clock, 20), expiresAt: plusMinutes(supplier.clock, 15), validForMinutes: 15, feeMinor: card.feeMinor, depositMinor: card.depositMinor, compatible: true, qualifiedDriver: true, conditionVerified: true, capabilityEvidence: "Controlled HTTP capability sheet: compatible desk and exact touring output requirements.", driverEvidence: "Controlled HTTP qualified driver roster; no actual driver participation claimed.", conditionEvidence: "Controlled HTTP pre-dispatch checklist; physical acceptance remains pending.", reference: "Controlled HTTP current Northside terms", detail: "Controlled enrolled supplier offers its own original unit on these explicit new terms.", confirmed: true };
  await check("origin, size, strict body, producer scope and supplier ownership reject before mutation", async () => {
    const envelope = { commandId: randomUUID(), expectedRevision: supplier.revision, command: terms };
    assert.equal((await request("/api/supplier-recovery/commands", "northside", envelope, { Origin: "http://localhost:4586" })).status, 403);
    assert.equal((await request("/api/supplier-recovery/commands", "northside", { ...envelope, unreviewed: true })).status, 400);
    assert.equal((await request("/api/supplier-recovery/commands", "northside", { ...envelope, extra: "x".repeat(31000) })).status, 413);
    assert.equal((await request("/api/supplier-recovery/commands", "supplier", envelope)).status, 403);
    assert.equal((await request("/api/supplier-recovery/commands", undefined, envelope, { Cookie: fixture.cookie + "=" + fixture.access.producer.token })).status, 409);
    assert.equal((await read("northside")).history.length, 0);
  });
  let published!: Awaited<ReturnType<typeof send>>;
  await check("the supplier publishes one current immutable edition with two independent clocks", async () => {
    published = await send("northside", terms); const source = published.result.workspace.cards[0]!.reference!;
    assert.equal(source.id, published.result.receipt.recordId); assert.equal(source.source, "controlled_supplier_terms"); assert.ok(Date.parse(source.validUntil) <= Date.parse(fixture.access.northside.expiresAt));
    assert.equal(published.result.workspace.cards[0]!.scenarioDeadline, terms.expiresAt); assert.equal(published.result.workspace.cards[0]!.usable, true);
  });
  await check("exact receipt and retry recover one edition, while changed bytes and other capabilities cannot adopt it", async () => {
    const replay = await request("/api/supplier-recovery/commands", "northside", published.envelope); assert.equal(replay.status, 200); assert.deepEqual((await replay.json()).receipt, published.result.receipt);
    const recovered = await request("/api/supplier-recovery/commands/" + published.envelope.commandId, "northside"); assert.equal(recovered.status, 200); assert.deepEqual((await recovered.json()).receipt, published.result.receipt);
    assert.equal((await request("/api/supplier-recovery/commands/" + published.envelope.commandId, "producer")).status, 404);
    const missing = await request("/api/supplier-recovery/commands/" + randomUUID(), "northside"); assert.equal(missing.status, 404); assert.equal((await missing.json()).code, "SUPPLIER_RECOVERY_RECEIPT_NOT_FOUND");
    assert.equal((await request("/api/supplier-recovery/commands", "northside", { ...published.envelope, command: { ...terms, feeMinor: terms.feeMinor + 1 } })).status, 409);
    assert.equal((await read("northside")).history.filter(receipt => receipt.action === "publish_terms").length, 1);
  });
  let requested!: Awaited<ReturnType<typeof send>>;
  await check("separate producer review binds the disruption, new source and every original obligation", async () => {
    const current = await read(); assert.equal(current.preview!.ready, true); assert.equal(current.preview!.retained[0]!.verifiedFeeMinor, 48000); assert.equal(current.preview!.retained[0]!.depositMinor, 30000);
    assert.equal(current.preview!.supplierTerms.find(item => item.supplierId === "northside")!.termsId, published.result.receipt.recordId);
    requested = await send("producer", { type: "request_quotes", previewDigest: current.preview!.digest, detail: "Controlled HTTP producer reviews every original promise and the current source before one replacement collection.", confirmed: true });
    const row = requested.result.workspace.requests[0]!; assert.equal(row.id, requested.result.receipt.recordId); assert.equal(row.status, "collecting"); assert.ok(Date.parse(row.expiresAt!) <= Date.parse(fixture.access.producer.expiresAt));
    assert.equal((await request("/api/supplier-recovery/work", "alternate", { rfqId: row.id })).status, 403);
  });
  await check("real enrolled HTTP services return one signed current quote and two explicit refusals", async () => {
    const response = await request("/api/supplier-recovery/work", "producer", { rfqId: requested.result.receipt.recordId }); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.work.status, "complete");
    const row = (result.workspace as SupplierRecoveryWorkspace).requests[0]!; assert.equal(row.status, "applied"); assert.equal(row.outcomes.length, 3); assert.equal(row.outcomes.filter(item => item.kind === "quote").length, 1); assert.equal(row.outcomes.filter(item => item.kind === "declined").length, 2);
    const current = await show(); assert.equal(current.approvedPlan, null); assert.equal(rentalExecutionDigest(current.rentalExecutions!.find(item => item.id === original.id)!), originalDigest); assert.equal(digest(current.financialEvidence), originalMoney);
  });
  let approved!: ShowSnapshot;
  await check("the installed engine commits real candidates before a separate exact producer approval", async () => {
    let current = await show(); const generate = { idempotencyKey: randomUUID(), expectedRevision: current.revision, command: { type: "generate" } }; proof.commands.push(generate); await save();
    const response = await request("/api/show", "producer", generate); assert.equal(response.status, 200); current = (await response.json() as ConsoleData).show;
    const candidates = current.runs.at(-1)!.candidates, candidate = candidates.find(item => item.family === "doors" && item.patch.offerId.includes("northside"))!;
    assert.equal(candidates.length, 12); assert.equal(candidate.report.engine?.status, "passed"); assert.equal(candidate.report.status, "feasible_with_approval"); assert.equal(candidate.patch.tasks.find(task => task.id === "rental-authorized")!.start, current.clock);
    const approve = { idempotencyKey: randomUUID(), expectedRevision: current.revision, command: { type: "approve", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: candidate.approvals.map(item => item.id) } }; proof.commands.push(approve); await save();
    const approvedResponse = await request("/api/show", "producer", approve); assert.equal(approvedResponse.status, 200); approved = (await approvedResponse.json() as ConsoleData).show; assert.equal(approved.approvedPlan!.digest, candidate.digest);
  });
  await check("a distinct original-capability replacement hold preserves every old financial binding", async () => {
    const offer = approved.offers.find(item => item.supplierId === "northside")!;
    const body = { idempotencyKey: randomUUID(), expectedRevision: approved.revision, quoteId: offer.serviceQuote!.id, planDigest: approved.approvedPlan!.digest, acceptCaptureTerms: true }; proof.commands.push(body); await save();
    const response = await request("/api/suppliers/northside/holds", "producer", body); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    const replacement = result.reservation.execution; assert.notEqual(replacement.id, original.id); assert.equal(replacement.state, "held"); assert.equal(replacement.authorizationId, null); assert.equal(replacement.acceptedAt, null);
    const replay = await request("/api/suppliers/northside/holds", "producer", body); assert.equal(replay.status, 200); assert.equal((await replay.json()).reservation.execution.id, replacement.id);
    assert.equal((await request("/api/suppliers/northside/holds", "alternate", body)).status, 409);
    const current = await show(); assert.equal(current.rentalExecutions!.length, 2); assert.equal(rentalExecutionDigest(current.rentalExecutions!.find(item => item.id === original.id)!), originalDigest); assert.equal(digest(current.financialEvidence), originalMoney);
  });
  await check("compiled pages and static assets serve while the private chooser exposes no capability", async () => {
    const response = await request("/recovery"); assert.equal(response.status, 200); const page = await response.text(); assert.match(page, /Opening Night/);
    const assets = [...new Set([...page.matchAll(/(?:src|href)="([^\"]*\/_next\/static\/[^\"]+)"/g)].map(value => value[1]!))].slice(0, 3); assert.ok(assets.length >= 2);
    for (const asset of assets) { const response = await request(asset); assert.equal(response.status, 200); await response.arrayBuffer(); }
    const chooser = await request("/__supplier_recovery_fixture"); assert.equal(chooser.status, 200); const content = await chooser.text(); assert.ok(!content.includes(native.bootstrapKey)); for (const item of Object.values(native.access) as { token: string }[]) assert.ok(!content.includes(item.token));
  });
  proof.nativePreserved = digest(nativeBefore) === digest(await nativeSnapshot()); assert.equal(proof.nativePreserved, true); proof.state = "passed"; proof.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ proof: path, checks: proof.checks.length, requests: proof.requests.length, nativePreserved: proof.nativePreserved, actualProviderRequests: 0 }));
} catch (error) { proof.state = "failed"; proof.failure = error instanceof Error ? error.message : "HTTP qualification failed"; proof.finishedAt = new Date().toISOString(); await save(); throw error; }
