/** Local review transport faults. No production import, domain bypass or fabricated receipt. */
import { createHash } from 'node:crypto';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
export const nativeFaultModes = ['drop-before-dispatch', 'drop-committed-response', 'hold-receipt-lookup', 'hold-source-result'];
export function createTourNativeFaults({ producerToken, actorId, cookieName, record }) {
  let armed = null, held = null;
  const state = () => ({ armed: armed?.mode ?? null, held: held?.mode ?? null });
  async function arm(mode) {
    if (!nativeFaultModes.includes(mode)) throw new Error('Choose a named bounded transport fault');
    if (armed || held) throw new Error('Finish or cancel the existing fault before arming another');
    await record({ event: 'armed', mode }); armed = { mode };
  }
  async function cancel() {
    if (held) throw new Error('Release the retained lookup before cancelling');
    if (armed) await record({ event: 'cancelled-before-use', mode: armed.mode });
    armed = null;
  }
  async function release() {
    if (!held) throw new Error('No retained lookup is waiting');
    const request = held; held = null;
    const closed = request.req.destroyed || request.res.destroyed;
    await record({ event: closed ? 'released-after-client-abort' : 'released', mode: request.mode, path: request.path });
    if (!closed) await request.next();
  }
  async function intercept(req, res, next) {
    if (!armed) return false;
    const cookie = String(req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='));
    if (cookie !== `${cookieName}=${producerToken}`) return false;
    const path = String(req.url ?? ''), mode = armed.mode;
    const command = req.method === 'POST' && path === '/api/tour/commands';
    const lookup = req.method === 'GET' && /^\/api\/tour\/commands\/[a-f0-9-]{36}$/.test(path);
    const source = req.method === 'GET' && /^\/api\/sources\/compile\?compilationId=[a-f0-9-]{36}$/.test(path);
    if (!(command && mode.startsWith('drop-') || lookup && mode === 'hold-receipt-lookup' || source && mode === 'hold-source-result')) return false;
    armed = null;
    if (mode.startsWith('hold-')) {
      held = { req, res, next, mode, path };
      await record({ event: 'held-before-dispatch', mode, path });
      return true;
    }
    if (mode === 'drop-before-dispatch') {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1500000) throw new Error('Bounded command body required'); chunks.push(chunk); }
      const body = Buffer.concat(chunks), value = JSON.parse(body.toString('utf8'));
      await record({ event: 'dropped-before-dispatch', mode, commandId: value.commandId, bodySha256: createHash('sha256').update(body).digest('hex'), dispatched: false });
      res.destroy(); return true;
    }
    // Buffer only this original fixture producer's next command response. Drop it
    // only after the real handler returned a matching committed receipt with 200.
    const original = { write: res.write, end: res.end, writeHead: res.writeHead, flushHeaders: res.flushHeaders };
    const chunks = []; let bytes = 0, ended = false;
    const append = (chunk, encoding) => { if (chunk != null) { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined); bytes += value.length; if (bytes > 2000000) throw new Error('Bounded receipt response required'); chunks.push(value); } };
    res.flushHeaders = () => {};
    res.writeHead = function (status, message, headers) { this.statusCode = status; if (typeof message === 'string') this.statusMessage = message; const values = typeof message === 'object' ? message : headers; if (Array.isArray(values)) { for (let i = 0; i < values.length; i += 2) this.setHeader(values[i], values[i + 1]); } else if (values) for (const [name, value] of Object.entries(values)) this.setHeader(name, value); return this; };
    res.write = function (chunk, encoding, callback) { append(chunk, encoding); const done = typeof encoding === 'function' ? encoding : callback; if (done) queueMicrotask(done); return true; };
    res.end = function (chunk, encoding, callback) {
      if (ended) return this; ended = true; append(chunk, encoding);
      const body = Buffer.concat(chunks), contentEncoding = String(this.getHeader('content-encoding') ?? 'identity').toLowerCase();
      // Next wraps these methods with its installed compression middleware. Keep
      // the original wire bytes for refusal delivery, but inspect bounded decoded
      // JSON before deciding whether a real committed receipt may be dropped.
      let value;
      try {
        const decode = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[contentEncoding];
        const decoded = contentEncoding === 'identity' ? body : decode?.(body, { maxOutputLength: 2000000 });
        value = decoded ? JSON.parse(decoded.toString('utf8')) : null;
      } catch { value = null; }
      const committed = this.statusCode === 200 && value?.receipt?.actorId === actorId && /^[a-f0-9-]{36}$/.test(value.receipt.commandId);
      Object.assign(this, original);
      void record({ event: committed ? 'dropped-committed-response' : 'refusal-delivered', mode, status: this.statusCode, commandId: value?.receipt?.commandId ?? null, contentEncoding, responseSha256: createHash('sha256').update(body).digest('hex'), committed }).then(() => {
        if (committed) this.destroy(); else original.end.call(this, body, typeof encoding === 'function' ? encoding : callback);
      }, () => this.destroy());
      return this;
    };
    await next(); return true;
  }
  return { arm, cancel, release, intercept, state };
}
