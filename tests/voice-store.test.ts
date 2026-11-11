import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { digest } from "../src/domain/hash";
import { voiceModels } from "../src/domain/voice";
import { withRun } from "./helpers";
import { isolatedDatabase } from "./isolated-database";
import type { IntelligenceAuthority } from "../src/server/intelligence/ledger";
import type { VoiceProvider } from "../src/server/intelligence/voice";

let fixture: Awaited<ReturnType<typeof isolatedDatabase>>, voice: typeof import("../src/server/intelligence/voice");
before(async () => { fixture = await isolatedDatabase(); const store = await import("../src/server/store"); await store.migrate(); voice = await import("../src/server/intelligence/voice"); });
after(async () => { await fixture?.close(); });
async function workspace() {
  const { show, actor } = withRun(), sessionHash = digest(randomBytes(32).toString("base64url"));
  await fixture.pool.query("INSERT INTO on_shows(tenant_id,snapshot,revision) VALUES($1,$2,$3)", [show.tenantId, show, show.revision]);
  await fixture.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [sessionHash, show.tenantId, actor]);
  return { authority: { actor, sessionHash } satisfies IntelligenceAuthority, show };
}
const code = (expected: string) => (error: unknown) => { assert.equal((error as { code?: string }).code, expected); return true; };
function wire(options: { lost?: boolean; reject?: boolean; badReceipt?: boolean; beforeDispatch?: () => Promise<void>; wait?: Promise<void> } = {}) {
  const requests: { name: string; input: unknown }[] = [], pcm = Buffer.alloc(4800, 3);
  const provider: VoiceProvider = { configured: true, mode: "controlled_fixture", fetch: async (_url, init) => {
    const form = init?.body as FormData; requests.push({ name: "transcribe", input: { file: (form.get("file") as File).name, type: (form.get("file") as File).type, model: form.get("model") } });
    await options.wait; if (options.lost) throw new Error("Controlled lost response"); if (options.reject) return new Response("", { status: 422 });
    return Response.json({ text: "Check Tom's qualification before changing the call.", languages: [{ code: "en" }] }, { headers: { "x-request-id": "req_transcription_fixture" } });
  }, speech: { generate: async (input, observer) => {
    requests.push({ name: "speech", input });
    await observer.session?.("sess_fixture", voiceModels.speak); await options.beforeDispatch?.(); await observer.dispatch(); await observer.response?.("resp_fixture");
    await observer.chunk?.(0, "event_one", pcm);
    if (options.lost) throw new Error("Controlled partial stream lost");
    const receipt = { model: voiceModels.speak, voice: "marin", sessionId: "sess_fixture", responseId: "resp_fixture", transcript: input.text, sampleRate: 24000 as const, byteLength: pcm.length, contentHash: options.badReceipt ? "b".repeat(64) : voice.byteHash(pcm), latencyMs: 10, usage: { audio_tokens: 15 } };
    await observer.complete?.(receipt); return { pcm, receipt };
  } } };
  return { provider, requests, pcm };
}
test("native transcription retries return one retained encrypted result with corrected WebM metadata", async () => {
  const { authority, show } = await workspace(), scope = randomUUID(), fake = wire(), bytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(30)]);
  const first = await voice.transcribeVoice(authority, scope, bytes, fake.provider), replay = await voice.transcribeVoice(authority, scope, bytes, fake.provider);
  assert.deepEqual(first, replay); assert.equal(fake.requests.length, 1); assert.deepEqual(fake.requests[0]!.input, { file: "recording.webm", type: "audio/webm", model: "gpt-transcribe" });
  const row = (await fixture.pool.query("SELECT * FROM on_voice_runs WHERE id=$1", [first.run.id])).rows[0]; assert.ok(!JSON.stringify(row).includes(first.text)); assert.ok(!JSON.stringify(row).includes(bytes.toString("base64")));
  await assert.rejects(fixture.pool.query("UPDATE on_voice_runs SET result_cipher='replacement' WHERE id=$1", [first.run.id]), /Terminal voice request/);
  assert.equal(digest((await fixture.pool.query("SELECT snapshot FROM on_shows WHERE tenant_id=$1", [show.tenantId])).rows[0].snapshot), digest(show));
});
test("concurrent native retry cannot dispatch a second transcription", async () => {
  const { authority } = await workspace(), scope = randomUUID(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }), fake = wire({ wait }), bytes = voice.pcmWave(Buffer.alloc(240));
  const original = voice.transcribeVoice(authority, scope, bytes, fake.provider);
  for (let i = 0; i < 100 && fake.requests.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(voice.transcribeVoice(authority, scope, bytes, fake.provider), code("VOICE_PENDING")); release(); await original; assert.equal(fake.requests.length, 1);
});
test("unknown and rejected transcriptions remain terminal across exact retries", async () => {
  for (const options of [{ lost: true }, { reject: true }]) {
    const { authority } = await workspace(), scope = randomUUID(), fake = wire(options), bytes = voice.pcmWave(Buffer.alloc(240));
    const expected = options.lost ? "VOICE_RESULT_UNKNOWN" : "VOICE_REQUEST_FAILED";
    await assert.rejects(voice.transcribeVoice(authority, scope, bytes, fake.provider), code(expected)); await assert.rejects(voice.transcribeVoice(authority, scope, bytes, fake.provider), code(expected)); assert.equal(fake.requests.length, 1);
  }
});
test("saved speech bytes and receipt replay without reconnecting; partial bytes stay encrypted", async () => {
  const { authority } = await workspace(), scope = randomUUID(), fake = wire(), text = "Keep the plan under review.";
  const first = await voice.speakVoice(authority, scope, text, fake.provider), replay = await voice.speakVoice(authority, scope, text, fake.provider), read = await voice.readVoiceAudio(authority, first.run.id);
  assert.deepEqual(first.bytes, voice.pcmWave(fake.pcm)); assert.deepEqual(replay, first); assert.deepEqual(read, first); assert.equal(fake.requests.length, 1);
  const row = (await fixture.pool.query("SELECT * FROM on_voice_runs WHERE id=$1", [first.run.id])).rows[0]; assert.ok(!JSON.stringify(row).includes(text));
  const chunks = (await fixture.pool.query("SELECT * FROM on_voice_chunks WHERE run_id=$1", [first.run.id])).rows; assert.equal(chunks.length, 1); assert.ok(!JSON.stringify(chunks).includes(fake.pcm.toString("base64")));
  await assert.rejects(fixture.pool.query("UPDATE on_voice_chunks SET content_hash='replacement' WHERE run_id=$1", [first.run.id]), /Immutable voice chunk/);
});
test("lost Realtime stream and mismatching receipt keep one held request and its original chunk", async () => {
  for (const options of [{ lost: true }, { badReceipt: true }]) {
    const { authority } = await workspace(), scope = randomUUID(), fake = wire(options);
    await assert.rejects(voice.speakVoice(authority, scope, "Keep the original result.", fake.provider), code("VOICE_RESULT_UNKNOWN"));
    await assert.rejects(voice.speakVoice(authority, scope, "Keep the original result.", fake.provider), code("VOICE_RESULT_UNKNOWN")); assert.equal(fake.requests.length, 1);
    const record = await voice.voiceWorkspace(authority, fake.provider); assert.equal(record.runs[0]!.state, "indeterminate"); assert.equal(record.runs[0]!.text, null);
    assert.equal((await fixture.pool.query("SELECT count(*) FROM on_voice_chunks WHERE tenant_id=$1", [authority.actor.tenantId])).rows[0].count, "1");
  }
});
test("exact ended session, same-actor replacement session and foreign tenant cannot recover audio", async () => {
  const a = await workspace(), b = await workspace(), fake = wire(), result = await voice.speakVoice(a.authority, randomUUID(), "An owned recording.", fake.provider);
  await assert.rejects(voice.readVoiceAudio(b.authority, result.run.id), code("VOICE_NOT_FOUND"));
  const otherHash = digest(randomUUID()); await fixture.pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [otherHash, a.show.tenantId, a.authority.actor]);
  await assert.rejects(voice.readVoiceAudio({ ...a.authority, sessionHash: otherHash }, result.run.id), code("VOICE_NOT_FOUND"));
  await fixture.pool.query("DELETE FROM on_sessions WHERE token_hash=$1", [a.authority.sessionHash]);
  await assert.rejects(voice.readVoiceAudio(a.authority, result.run.id), code("PLANNING_SESSION_ENDED"));
  assert.equal(fake.requests.length, 1);
});
test("speech revalidates exact authority after connection and before response.create", async () => {
  const { authority } = await workspace(), fake = wire({ beforeDispatch: async () => { await fixture.pool.query("DELETE FROM on_sessions WHERE token_hash=$1", [authority.sessionHash]); } });
  await assert.rejects(voice.speakVoice(authority, randomUUID(), "Stop when authority ends.", fake.provider), code("PLANNING_SESSION_ENDED"));
  const row = (await fixture.pool.query("SELECT * FROM on_voice_runs WHERE tenant_id=$1", [authority.actor.tenantId])).rows[0]; assert.equal(row.state, "failed"); assert.equal(row.dispatched_at, null); assert.equal(row.provider_response_id, null);
});
test("crew capability cannot transcribe and the default provider remains disabled in QA", async () => {
  const { authority } = await workspace(), fake = wire();
  await assert.rejects(voice.transcribeVoice({ ...authority, actor: { ...authority.actor, roles: ["crew"], personId: "sam" } }, randomUUID(), voice.pcmWave(Buffer.alloc(240)), fake.provider), code("PLANNING_ROLE_REQUIRED"));
  process.env.OPENAI_API_KEY = "never-dispatch"; assert.equal(voice.voiceProvider().configured, false); await assert.rejects(async () => voice.voiceProvider().fetch("https://api.openai.com/v1/audio/transcriptions"), /disabled/); process.env.OPENAI_API_KEY = "";
  assert.equal(fake.requests.length, 0);
});
