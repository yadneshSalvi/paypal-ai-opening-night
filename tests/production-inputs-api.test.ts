import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { inputHarness } from "./production-inputs-harness";
const shared = inputHarness();
const origin = "http://127.0.0.1:4615";
after(async () => { await (await shared).close(); });
const request = (token: string, body?: unknown, query = "", originValue = origin) => new Request(origin + "/api/production-inputs" + query, { method: body === undefined ? "GET" : "POST", headers: { Origin: originValue, Authorization: "Bearer " + token, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
test("the exact API rejects foreign origins, role escalation, cross-production queries and oversized commands", async () => {
  const h = await shared, api = await import("../src/app/api/production-inputs/route"), p = await h.production(), source = await h.source(p, "A controlled input API source. No independent identity or authority is claimed.");
  assert.equal((await api.GET(request("missing"))).status, 401);
  const response = await api.GET(request(p.token)); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /private, no-store/); assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await api.GET(request(p.token, undefined, "?token=not-a-query-capability"))).status, 400);
  assert.equal((await api.GET(request(p.token, undefined, "?commandId=" + source.request.commandId + "&commandId=" + randomUUID()))).status, 400);
  for (const foreign of ["null", "http://localhost:4615", "https://example.test"]) assert.equal((await api.POST(request(p.token, source.request, "", foreign))).status, 403);
  const injected = await api.POST(request(p.token, { ...source.request, roles: ["producer"], marker: "must-not-echo-this-source-value" })); assert.equal(injected.status, 400); assert.doesNotMatch(await injected.text(), /must-not-echo/);
  assert.equal((await api.POST(request(p.token, { padding: "x".repeat(260000) }))).status, 413);
  const crew = await h.store.createCrewCapability(p.actor, "priya"); assert.equal((await api.GET(request(crew))).status, 403);
});
test("the actual route runs source → typed proposal → installed-engine preview → separate approval and original receipt GET", async () => {
  const h = await shared, api = await import("../src/app/api/production-inputs/route"), p = await h.production(), source = await h.source(p, "Controlled venue access window: 10:00 on 14 November to 00:30 on 15 November 2026 in Chicago. This is an owned test declaration.");
  const { atVenue } = await import("../src/domain/time");
  const proposalRequest = await h.envelope(p, { type: "propose", sourceReviewed: true, draft: { title: "HTTP declared venue access", rationale: "Exercise the complete actual producer service and exact source/authority admission boundary.", roster: [], venue: { accessWindow: { value: { from: atVenue("10:00"), until: atVenue("00:30", "2026-11-15") }, citations: [source.citation] } } } });
  const proposed = await api.POST(request(p.token, proposalRequest)); assert.equal(proposed.status, 200); const proposalReceipt = (await proposed.json()).receipt;
  const previewRequest = await h.envelope(p, { type: "preview", proposalId: proposalReceipt.result.proposalId, proposalDigest: proposalReceipt.result.digest });
  const previewed = await api.POST(request(p.token, previewRequest)); assert.equal(previewed.status, 200);
  const view = await h.service.productionInputWorkspace(p.authority), preview = view.proposals[0]!.latestPreview!; assert.equal(preview.engine.status, "passed");
  assert.equal((await h.store.getShow(p.actor.tenantId)).productionInputs, undefined);
  const approval = await h.approve(p, preview), committed = await api.POST(request(p.token, approval)); assert.equal(committed.status, 200); const saved = await committed.json();
  const recovered = await api.GET(request(p.token, undefined, "?commandId=" + approval.commandId)); assert.equal(recovered.status, 200); assert.deepEqual((await recovered.json()).receipt, saved.receipt);
  assert.equal((await h.service.productionInputWorkspace(p.authority)).editions.length, 1);
  assert.deepEqual((await (await api.POST(request(p.token, approval))).json()).receipt, saved.receipt);
});
test("receipt absence waits behind the serialized production transaction", async () => {
  const h = await shared, api = await import("../src/app/api/production-inputs/route"), p = await h.production(), lock = await h.database.pool.connect(); let read: Promise<Response> | undefined, resolved = false;
  try {
    await lock.query("BEGIN"); await lock.query("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR UPDATE", [p.actor.tenantId]);
    read = api.GET(request(p.token, undefined, "?commandId=" + randomUUID())).then(response => { resolved = true; return response; });
    let waiting = false; for (let i = 0; i < 100; i++) { waiting = Boolean((await h.database.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT snapshot FROM on_shows WHERE tenant_id=%FOR UPDATE'")).rowCount); if (waiting) break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(waiting, true); assert.equal(resolved, false); await lock.query("COMMIT");
    const response = await read; assert.equal(response.status, 404); assert.equal((await response.json()).code, "INPUT_COMMAND_NOT_FOUND");
  } finally { await lock.query("ROLLBACK"); lock.release(); if (read) await read; }
});
test("a same-token microsecond expiry change while waiting refuses the original never-dispatched command", async () => {
  const h = await shared, api = await import("../src/app/api/production-inputs/route"), p = await h.production(), source = await h.source(p, "A controlled pending command; exact original expiry is part of its authority.");
  const command = { ...source.request, commandId: randomUUID() }, lock = await h.database.pool.connect(); let running: Promise<Response> | undefined;
  try {
    await lock.query("BEGIN"); await lock.query("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR UPDATE", [p.actor.tenantId]); running = api.POST(request(p.token, command));
    let waiting = false; for (let i = 0; i < 100; i++) { waiting = Boolean((await h.database.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT snapshot FROM on_shows WHERE tenant_id=%FOR UPDATE'")).rowCount); if (waiting) break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(waiting, true); await h.database.pool.query("UPDATE on_sessions SET expires_at=expires_at+interval '1 microsecond' WHERE token_hash=$1", [p.authority.sessionHash]); await lock.query("COMMIT");
    const response = await running; assert.equal(response.status, 401); assert.equal((await response.json()).code, "INPUT_ACCESS_CHANGED");
    assert.equal((await h.database.pool.query("SELECT 1 FROM on_production_input_commands WHERE tenant_id=$1 AND command_id=$2", [p.actor.tenantId, command.commandId])).rowCount, 0);
  } finally { await lock.query("ROLLBACK"); lock.release(); if (running) await running; }
});
test("expiry during the actual engine preview rolls back its new preview and receipt", async () => {
  const h = await shared, p = await h.production(); await h.database.pool.query("UPDATE on_sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1", [p.authority.sessionHash]);
  const source = await h.source(p, "A short original controlled producer expiry. Declared venue curfew 22:00 Chicago.");
  const { atVenue } = await import("../src/domain/time");
  const proposal = await h.proposal(p, { title: "Expiry during actual engine proof", rationale: "The exact original authority must remain current after a slow pure engine computation.", roster: [], venue: { amplifiedCurfew: { value: atVenue("22:00"), citations: [source.citation] } } });
  const envelope = await h.envelope(p, { type: "preview", proposalId: proposal.proposal.id, proposalDigest: proposal.proposal.digest });
  let engineRan = false;
  await assert.rejects(h.service.executeProductionInput(p.authority, envelope, async (...args) => { await new Promise(resolve => setTimeout(resolve, 1100)); const result = await h.engine.commitGraphEngine(...args); engineRan = true; return result; }), { code: "INPUT_ACCESS_ENDED" });
  assert.equal(engineRan, true); assert.equal((await h.database.pool.query("SELECT 1 FROM on_production_input_previews WHERE tenant_id=$1", [p.actor.tenantId])).rowCount, 0);
  assert.equal((await h.database.pool.query("SELECT 1 FROM on_production_input_commands WHERE tenant_id=$1 AND command_id=$2", [p.actor.tenantId, envelope.commandId])).rowCount, 0);
});
