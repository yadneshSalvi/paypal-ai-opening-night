import test from 'node:test';
import assert from 'node:assert/strict';
import { readModelResponseStream } from '../src/server/intelligence/response-stream';
const created = { id: 'resp_stream_original', status: 'in_progress', store: false, model: 'gpt-6.1-sol', output: [] };
const terminal = { ...created, status: 'completed', output: [{ type: 'reasoning', encrypted_content: 'opaque-original' }, { type: 'message', content: [{ type: 'output_text', text: 'Priya — reviewed separately.' }] }] };
const frame = (type: string, response: unknown, sequence_number: number) => `event: ${type}\ndata: ${JSON.stringify({ type, response, sequence_number })}\n\n`;
function stream(text: string, fragment = false) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { if (fragment) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); else controller.enqueue(bytes); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
test('foreground stream preserves multibyte original output and retains its ID before completion', async () => {
  const seen: unknown[] = [], raw = frame('response.created', created, 0) + frame('response.completed', terminal, 3);
  const result = await readModelResponseStream(stream(raw, true), 10000, async body => { seen.push(structuredClone(body)); });
  assert.deepEqual(seen, [created]); assert.deepEqual(result.body, terminal); assert.equal(result.raw, raw); assert.equal(result.failure, null);
});
test('a stream disconnect retains only the original created identity, never a fabricated completion', async () => {
  const result = await readModelResponseStream(stream(frame('response.created', created, 0)), 10000, async () => undefined);
  assert.equal(result.failure, 'STREAM_TERMINAL_MISSING'); assert.deepEqual(result.body, created);
});
test('a foreign terminal identity and repeated stream sequence are refused', async () => {
  const foreign = await readModelResponseStream(stream(frame('response.created', created, 0) + frame('response.completed', { ...terminal, id: 'resp_foreign' }, 1)), 10000, async () => undefined);
  assert.equal(foreign.failure, 'STREAM_IDENTITY_CHANGED'); assert.deepEqual(foreign.body, created);
  const repeated = await readModelResponseStream(stream(frame('response.created', created, 1) + frame('response.completed', terminal, 1)), 10000, async () => undefined);
  assert.equal(repeated.failure, 'STREAM_SEQUENCE_CHANGED'); assert.deepEqual(repeated.body, created);
});
test('unbounded or invalid stream bytes cannot establish a terminal response', async () => {
  const exceeded = await readModelResponseStream(stream(frame('response.created', created, 0)), 5, async () => assert.fail('Oversized first event must not establish an identity'));
  assert.equal(exceeded.failure, 'STREAM_BODY_TOO_LARGE'); assert.equal(exceeded.body, null);
  const malformed = await readModelResponseStream(stream(frame('response.created', created, 0) + 'data: {broken}\n\n'), 10000, async () => undefined);
  assert.ok(malformed.failure); assert.deepEqual(malformed.body, created); assert.ok(malformed.raw.includes('{broken}'));
});
test('provider failure is retained as failure and a missing creation event cannot supply a new ID', async () => {
  const failed = { ...created, status: 'failed', error: { code: 'controlled_failure' } };
  const result = await readModelResponseStream(stream(frame('response.created', created, 0) + frame('response.failed', failed, 1)), 10000, async () => undefined);
  assert.equal(result.body?.status, 'failed'); assert.equal(result.failure, null);
  const noCreated = await readModelResponseStream(stream(frame('response.completed', terminal, 1)), 10000, async () => undefined);
  assert.equal(noCreated.body, null); assert.equal(noCreated.failure, 'STREAM_IDENTITY_CHANGED');
});
