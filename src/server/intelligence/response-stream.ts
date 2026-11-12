import type { PlanningResponse } from './continuation';

export interface ModelStreamResult {
  body: PlanningResponse | null;
  created: PlanningResponse | null;
  raw: string;
  failure: string | null;
}
const identity = (value: unknown): value is string => typeof value === 'string' && /^resp_[A-Za-z0-9_-]{1,240}$/.test(value);

/** Capture the original ID before waiting for an opaque, complete stateless response. */
export async function readModelResponseStream(response: Response, limit: number, retainCreated: (body: PlanningResponse) => Promise<void>): Promise<ModelStreamResult> {
  const reader = response.body?.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let raw = '', buffer = '', bytes = 0, sequence = -1, created: PlanningResponse | null = null;
  if (!reader) return { body: null, created, raw, failure: 'STREAM_BODY_MISSING' };
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) { buffer += decoder.decode(); throw new Error('STREAM_TERMINAL_MISSING'); }
      bytes += part.value.byteLength;
      if (bytes > limit) throw new Error('STREAM_BODY_TOO_LARGE');
      const text = decoder.decode(part.value, { stream: true }); raw += text; buffer += text;
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary || boundary.index === undefined) break;
        const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = frame.split(/\r?\n/), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data) as { type?: unknown; sequence_number?: unknown; response?: PlanningResponse };
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw new Error('STREAM_EVENT_INVALID');
        const name = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        if (name && name !== event.type) throw new Error('STREAM_EVENT_NAME_CHANGED');
        if (event.sequence_number !== undefined) {
          if (!Number.isSafeInteger(event.sequence_number) || Number(event.sequence_number) <= sequence) throw new Error('STREAM_SEQUENCE_CHANGED');
          sequence = Number(event.sequence_number);
        }
        if (event.type === 'error') throw new Error('STREAM_PROVIDER_ERROR');
        if (event.type === 'response.created') {
          if (created || !identity(event.response?.id) || !['queued', 'in_progress'].includes(event.response?.status ?? '')) throw new Error('STREAM_IDENTITY_CHANGED');
          created = event.response!;
          await retainCreated(created);
        } else if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) {
          const body = event.response;
          if (!created || !body || body.id !== created.id || event.type !== `response.${body.status}`) throw new Error('STREAM_IDENTITY_CHANGED');
          return { body, created, raw, failure: null };
        } else if (event.type === 'response.in_progress' && (!created || event.response?.id !== created.id)) throw new Error('STREAM_IDENTITY_CHANGED');
      }
    }
  } catch (error) {
    return { body: created, created, raw, failure: error instanceof Error ? error.message : 'STREAM_INTERRUPTED' };
  } finally { await reader.cancel().catch(() => undefined); }
}
