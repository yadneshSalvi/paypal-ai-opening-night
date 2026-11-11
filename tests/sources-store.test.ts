import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { digest } from "../src/domain/hash";
import type { SourceUpload } from "../src/domain/sources";
import type { IntelligenceAuthority } from "../src/server/intelligence/ledger";
import type { SourceProvider } from "../src/server/sources/compiler";
import { base } from "./helpers";
import { isolatedDatabase } from "./isolated-database";
import { sourceExample, sourceFixture } from "./source-fixture";

let fixture: Awaited<ReturnType<typeof isolatedDatabase>>, sources: typeof import("../src/server/sources/store"), compiler: typeof import("../src/server/sources/compiler");
before(async () => { fixture = await isolatedDatabase(); const store = await import("../src/server/store"); await store.migrate(); sources = await import("../src/server/sources/store"); compiler = await import("../src/server/sources/compiler"); });
after(async () => fixture?.close());
const code = (expected: string) => (error: unknown) => { assert.equal((error as { code?: string }).code, expected); return true; };
const upload = (): SourceUpload => ({ requestId: randomUUID(), title: "Lighting addendum", role: "rider", rights: { basis: "owned", owner: "Opening Night test fixture", note: "Fictional owned text" }, rightsConfirmed: true, replacesId: null });
async function workspace() {
  const { show, actor } = base(), sessionHash = digest(randomBytes(32).toString("base64url"));
  await fixture.pool.query("INSERT INTO on_shows(tenant_id,snapshot,revision) VALUES($1,$2,$3)", [show.tenantId, show, show.revision]);
  await fixture.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [sessionHash, show.tenantId, actor]);
  const authority = { actor, sessionHash } satisfies IntelligenceAuthority;
  return { show, authority };
}
function wire(options: { lost?: boolean; pending?: boolean; foreignId?: boolean; tool?: boolean; noResult?: boolean; wait?: Promise<void>; after?: () => Promise<void>; assumption?: boolean } = {}) {
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = []; let saved: Record<string, unknown>;
  const provider: SourceProvider = { configured: true, mode: "controlled_fixture", fetch: async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(url), ...(method === "POST" ? { body: JSON.parse(String(init?.body)) } : {}) });
    if (method === "POST") { saved = JSON.parse(String(init?.body)); await options.wait; await options.after?.(); }
    if (options.lost) throw new Error("Controlled lost response");
    if (method === "GET" && options.noResult) return new Response("", { status: 404 });
    const input = saved.input as { content: { text: string }[] }[], data = JSON.parse(input[0]!.content[0]!.text), sourceId = data.sources[0].id;
    const { graph } = sourceFixture(data.selectedProduction, sourceId);
    if (options.assumption) graph.tasks[0]!.amplified = { value: false, citations: [], assumption: "The paperwork call uses no amplified audio." };
    return Response.json({ id: method === "GET" && options.foreignId ? "resp_wrong" : "resp_source_fixture", model: "gpt-6.1-sol", store: false, status: options.pending && method === "POST" ? "queued" : "completed", metadata: saved.metadata, output: options.pending && method === "POST" ? [] : options.tool ? [{ type: "function_call", name: "approve", arguments: "{}" }] : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(graph) }] }], usage: { input_tokens: 100, output_tokens: 100 } }, { headers: { "x-request-id": "req_source_fixture" } });
  } };
  return { provider, calls };
}
async function prepare() { const current = await workspace(), source = await sources.uploadSource(current.authority, upload(), "lighting.txt", Buffer.from(sourceExample)); return { ...current, source, command: { requestId: randomUUID(), expectedRevision: current.show.revision, sourceIds: [source.id] } }; }
async function compilation(options: Parameters<typeof wire>[0] = {}) { const prepared = await prepare(), fake = wire(options), run = await compiler.startSourceCompilation(prepared.authority, prepared.command, fake.provider); return { ...prepared, fake, run }; }
function reviewCommand(run: Awaited<ReturnType<typeof compiler.startSourceCompilation>>) { return { commandId: randomUUID(), compilationId: run.id, compilationDigest: run.digest!, expectedRevision: run.baseRevision, reviewedSourceIds: run.sourceBindings.map(item => item.id), acceptedAssumptionIds: run.review!.assumptions.map(item => item.id), reviewed: true as const }; }
test("private original and extracted source save atomically with immutable hash, rights and idempotent upload identity", async () => {
  const { show, authority } = await workspace(), command = upload(), bytes = Buffer.from(sourceExample);
  const [a, b] = await Promise.all([sources.uploadSource(authority, command, "lighting.txt", bytes), sources.uploadSource(authority, command, "lighting.txt", bytes)]);
  assert.equal(a.id, b.id); const source = await sources.readSource(authority, a.id); assert.equal(source.state, "ready"); assert.equal(source.extraction?.units.length, 5);
  const file = await sources.readSourceFile(authority, a.id); assert.deepEqual(file.bytes, bytes); assert.equal(file.source.rights?.basis, "owned");
  const row = (await fixture.pool.query("SELECT * FROM on_source_documents WHERE id=$1", [a.id])).rows[0], object = (await fixture.pool.query("SELECT * FROM on_source_objects WHERE source_id=$1", [a.id])).rows[0];
  assert.ok(!JSON.stringify(row).includes("Lighting paperwork")); assert.ok(!JSON.stringify(object).includes(bytes.toString("base64")));
  await assert.rejects(sources.uploadSource(authority, command, "lighting.txt", Buffer.from(sourceExample + "Different bytes")), code("SOURCE_REQUEST_CHANGED"));
  await assert.rejects(fixture.pool.query("UPDATE on_source_documents SET content_hash='changed' WHERE id=$1", [a.id]), /Immutable source identity/);
  assert.equal(digest((await fixture.pool.query("SELECT snapshot FROM on_shows WHERE tenant_id=$1", [show.tenantId])).rows[0].snapshot), digest(show));
});
test("source versions supersede only the selected current version and preserve old private evidence", async () => {
  const { authority, source } = await prepare(), command = { ...upload(), replacesId: source.id };
  const next = await sources.uploadSource(authority, command, "revision.txt", Buffer.from(sourceExample + "\nSecond source version."));
  assert.equal(next.familyId, source.familyId); assert.equal(next.version, 2); assert.equal(next.current, true);
  const old = await sources.readSource(authority, source.id); assert.equal(old.current, false); assert.equal(old.extraction?.units.length, 5);
  await assert.rejects(sources.uploadSource(authority, { ...upload(), replacesId: source.id }, "again.txt", Buffer.from(sourceExample)), code("SOURCE_VERSION_CHANGED"));
  const fake = wire(); await assert.rejects(compiler.startSourceCompilation(authority, { requestId: randomUUID(), expectedRevision: 1, sourceIds: [source.id] }, fake.provider), code("SOURCE_NOT_CURRENT")); assert.equal(fake.calls.length, 0);
});
test("compiler saves one encrypted original request and real-engine review, never applying model output", async () => {
  const { show, authority, command, fake, run } = await compilation();
  assert.equal(run.state, "completed"); assert.equal(run.current, true); assert.equal(run.review?.canApply, true, JSON.stringify(run.review?.issues));
  const replay = await compiler.startSourceCompilation(authority, command, fake.provider); assert.deepEqual(replay, run); assert.equal(fake.calls.filter(call => call.method === "POST").length, 1);
  const row = (await fixture.pool.query("SELECT * FROM on_source_compilations WHERE id=$1", [run.id])).rows[0]; assert.equal(row.provider_store, false); assert.equal(row.resolved_model, "gpt-6.1-sol"); assert.ok(!JSON.stringify(row).includes("Lighting paperwork")); assert.ok(row.provider_output_cipher && row.request_cipher && row.result_cipher);
  assert.equal(digest((await fixture.pool.query("SELECT snapshot FROM on_shows WHERE tenant_id=$1", [show.tenantId])).rows[0].snapshot), digest(show));
  await assert.rejects(fixture.pool.query("UPDATE on_source_compilations SET result_cipher='changed' WHERE id=$1", [run.id]), /Terminal compilation/);
});
test("concurrent duplicate compilation returns one original identity and never sends a second POST", async () => {
  const prepared = await prepare(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }), fake = wire({ wait });
  const first = compiler.startSourceCompilation(prepared.authority, prepared.command, fake.provider);
  for (let n = 0; n < 100 && !fake.calls.length; n++) await new Promise(resolve => setTimeout(resolve, 5));
  const duplicate = await compiler.startSourceCompilation(prepared.authority, prepared.command, fake.provider); assert.equal(duplicate.state, "dispatching"); release(); const original = await first;
  assert.equal(duplicate.id, original.id); assert.equal(fake.calls.length, 1);
});
test("unknown POST outcomes hold the original request and block replacement compilation", async () => {
  const { authority, command, fake, run } = await compilation({ lost: true }); assert.equal(run.state, "indeterminate");
  assert.equal((await compiler.startSourceCompilation(authority, command, fake.provider)).id, run.id); assert.equal(fake.calls.length, 1);
  await assert.rejects(compiler.startSourceCompilation(authority, { ...command, requestId: randomUUID() }, fake.provider), code("COMPILATION_ALREADY_RUNNING")); assert.equal(fake.calls.length, 1);
});
test("original response polling survives reload, rejects foreign response identities and preserves unavailable outcomes", async () => {
  for (const options of [{ pending: true }, { pending: true, foreignId: true }, { pending: true, noResult: true }]) {
    const { authority, fake, run } = await compilation(options); assert.equal(run.state, "running");
    const read = await compiler.readSourceCompilation(authority, run.id, fake.provider); assert.equal(read.state, options.foreignId ? "indeterminate" : options.noResult ? "unavailable" : "completed");
    await compiler.readSourceCompilation(authority, run.id, fake.provider); assert.deepEqual(fake.calls.map(call => call.method), ["POST", "GET"]); assert.match(fake.calls[1]!.url, /resp_source_fixture$/);
  }
});
test("model tool calls fail without changing state; another tenant or same-actor replacement session cannot recover a compilation", async () => {
  const { authority, show, fake, run } = await compilation({ tool: true }); assert.equal(run.state, "failed"); const other = await workspace();
  await assert.rejects(compiler.readSourceCompilation(other.authority, run.id, fake.provider), code("COMPILATION_NOT_FOUND"));
  const hash = digest(randomUUID()); await fixture.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [hash, show.tenantId, authority.actor]);
  await assert.rejects(compiler.readSourceCompilation({ ...authority, sessionHash: hash }, run.id, fake.provider), code("COMPILATION_NOT_FOUND"));
  await fixture.pool.query("DELETE FROM on_sessions WHERE token_hash=$1", [authority.sessionHash]); await assert.rejects(compiler.readSourceCompilation(authority, run.id, fake.provider), code("PLANNING_SESSION_ENDED"));
  assert.equal(fake.calls.length, 1);
});
test("exact producer review accepts every source and assumption, commits once, and leaves publication/finance/crew unchanged", async () => {
  const { authority, show, fake, source, run } = await compilation({ assumption: true }), command = reviewCommand(run);
  assert.equal(run.review!.assumptions.length, 1);
  await assert.rejects(compiler.applySourceCompilation(authority, { ...command, acceptedAssumptionIds: [] }), code("SOURCE_ASSUMPTIONS_UNREVIEWED"));
  const result = await compiler.applySourceCompilation(authority, command), replay = await compiler.applySourceCompilation(authority, command);
  assert.equal(result.replayed, false); assert.equal(replay.replayed, true); assert.equal(result.show.revision, show.revision + 1); assert.equal(result.show.tasks.length, show.tasks.length + 1);
  assert.deepEqual(result.show.sheets, show.sheets); assert.deepEqual(result.show.financialEvidence, []); assert.deepEqual(result.show.acknowledgments, []); assert.deepEqual(result.show.facts, []); assert.equal(result.show.approvedPlan, null); assert.equal(result.show.planVersion, show.planVersion);
  assert.equal(fake.calls.length, 1); assert.equal((await fixture.pool.query("SELECT count(*) FROM on_source_reviews WHERE compilation_id=$1", [run.id])).rows[0].count, "1");
  await assert.rejects(sources.deleteSource(authority, source.id, source.contentHash), code("SOURCE_IN_APPROVED_GRAPH"));
  await assert.rejects(compiler.applySourceCompilation(authority, { ...command, commandId: randomUUID() }), code("SOURCE_ALREADY_APPLIED"));
});
test("source supersession and changed production revisions invalidate exact application without rerunning the provider", async () => {
  for (const reason of ["source", "revision"]) {
    const { authority, source, run, fake, show } = await compilation(), command = reviewCommand(run);
    if (reason === "source") await sources.uploadSource(authority, { ...upload(), replacesId: source.id }, "revision.txt", Buffer.from(sourceExample + "\nRevised note."));
    else { const changed = { ...show, revision: show.revision + 1 }; await fixture.pool.query("UPDATE on_shows SET snapshot=$1,revision=$2 WHERE tenant_id=$3", [changed, changed.revision, show.tenantId]); }
    const current = await compiler.readSourceCompilation(authority, run.id, fake.provider); assert.equal(current.current, false);
    await assert.rejects(compiler.applySourceCompilation(authority, command), code(reason === "source" ? "COMPILATION_SOURCE_CHANGED" : "COMPILATION_STALE")); assert.equal(fake.calls.length, 1);
  }
});
test("deletion purges private original and unapplied model derivatives while retaining immutable tombstones", async () => {
  const { authority, source, run, fake } = await compilation(); await sources.deleteSource(authority, source.id, source.contentHash);
  const deleted = await sources.readSource(authority, source.id); assert.equal(deleted.state, "deleted"); assert.equal(deleted.rights, null); assert.equal(deleted.extraction, null); assert.equal(deleted.title, "Deleted source");
  await assert.rejects(sources.readSourceFile(authority, source.id), code("SOURCE_DELETED"));
  const view = await compiler.readSourceCompilation(authority, run.id, fake.provider); assert.equal(view.state, "deleted"); assert.equal(view.review, null);
  const row = (await fixture.pool.query("SELECT request_cipher,provider_output_cipher,result_cipher,purged_at FROM on_source_compilations WHERE id=$1", [run.id])).rows[0]; assert.equal(row.request_cipher, null); assert.equal(row.provider_output_cipher, null); assert.equal(row.result_cipher, null); assert.ok(row.purged_at);
  assert.equal((await fixture.pool.query("SELECT count(*) FROM on_source_objects WHERE source_id=$1", [source.id])).rows[0].count, "0");
  assert.equal((await sources.deleteSource(authority, source.id, source.contentHash)).state, "deleted"); assert.equal(fake.calls.length, 1);
});
test("foreign, scoped and ended sessions cannot read original private files or compile against them", async () => {
  const { authority, source, command } = await prepare(), other = await workspace(), fake = wire();
  await assert.rejects(sources.readSourceFile(other.authority, source.id), code("SOURCE_NOT_FOUND"));
  await assert.rejects(compiler.startSourceCompilation(other.authority, command, fake.provider), code("SOURCE_NOT_FOUND"));
  await assert.rejects(sources.readSource({ ...authority, actor: { ...authority.actor, personId: "sam", roles: ["crew"] } }, source.id), code("PLANNING_ROLE_REQUIRED"));
  await fixture.pool.query("DELETE FROM on_sessions WHERE token_hash=$1", [authority.sessionHash]);
  await assert.rejects(sources.readSourceFile(authority, source.id), code("PLANNING_SESSION_ENDED")); assert.equal(fake.calls.length, 0);
});
