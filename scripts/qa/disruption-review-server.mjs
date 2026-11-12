/** Loopback-only native entry for the immutable stage14 fixture. Never imported by a production route. */
import './disruption-disabled-providers.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { timingSafeEqual, randomUUID, randomBytes } from 'node:crypto';
import next from 'next';
import { createDisruptionNativeFaults, disruptionFaultModes } from './disruption-native-faults.mjs';

const hostname = '127.0.0.1', port = 4564, origin = `http://${hostname}:${port}`, cookieName = 'opening-night-disruption-4564-session';
if (process.env.VERCEL || globalThis.openingNightProviderEgressGuard?.version !== 2) throw new Error('Provider-disabled stage14 review only');
const fixture = JSON.parse(readFileSync('.artifacts/disruption-native-4564/fixture.json', 'utf8'));
if (fixture.version !== 1 || fixture.state !== 'ready' || fixture.origin !== origin || fixture.cookie !== cookieName) throw new Error('Original ready isolated stage14 fixture required');
const runtime = `.artifacts/disruption-native-4564/runtime-${randomUUID()}`;
await mkdir(runtime, { mode: 0o700 });
const record = value => writeFile(`${runtime}/${Date.now()}-${randomUUID()}.json`, JSON.stringify({ at: new Date().toISOString(), ...value }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
await record({ event: 'runtime-started', providers: 'disabled', originalExpiry: fixture.access.producer.expiresAt });
const faults = createDisruptionNativeFaults({ producerToken: fixture.access.producer.token, actorId: fixture.access.producer.actor.id, tenantId: fixture.access.producer.actor.tenantId, cookieName, record });
const app = next({ dev: false, hostname, port }); await app.prepare(); const handler = app.getRequestHandler();
const styles = 'body{font:16px system-ui;background:#121719;color:#eee4d3;margin:5vh auto;padding:25px;max-width:780px;line-height:1.7}h1{font-size:44px;font-weight:550;line-height:1.15}label,input,select,button{display:block;margin:15px 0}label{color:#c4b28e;font-size:13px}input,select{box-sizing:border-box;width:100%;padding:14px;background:#20272a;color:#eee4d3;border:1px solid #766141;border-radius:5px;font:inherit}button{padding:15px 23px;font:inherit;background:#d9b77d;border:0;border-radius:5px;color:#231d14;min-height:48px}small{color:#b7bdba}a{color:#d9b77d}section{border-top:1px solid #766141;padding-top:20px;margin-top:35px}code{overflow-wrap:anywhere}';
const keyField = '<label>Private review key<input name="key" type="password" required autocomplete="off"></label>';
function page() {
  const state = faults.state();
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Opening Night · Supplier disruption review</title><style>${styles}</style><body><small>OPENING NIGHT / OWNED SYNTHETIC REVIEW / 4564</small><h1>The show changed.<br>The record stays.</h1><p>Owned fictional planning declarations with real local bounded engine evaluation. All provider transports are disabled. No payment receipts, physical sign-offs, personal readbacks, supplier commitments or cancellation approvals were seeded.</p><form method="post" action="/__disruption_fixture"><label>Review persona<select name="persona"><option value="producer">Producer · all three units withdrawn, bounded search retained</option><option value="support">Producer · one supplier withdrawn, support-only review</option><option value="supplier">Brightline · own source reports, no finance or other suppliers</option><option value="sam">Sam · own published calls and operating notices</option><option value="other">Other producer · empty isolated disruption history</option></select></label>${keyField}<button type="submit">Open original review capability</button></form><small>Original fixed expiry: ${fixture.access.producer.expiresAt}. This chooser never replaces identities, renews expiry or erases history.</small><section><h2>Bounded transport checks</h2><p>These one-shot controls affect only the original all-units-withdrawn producer. Every trigger is retained privately. Use the real production UI to submit an explicitly synthetic source report.</p><p>Armed: <b>${state.armed ?? 'none'}</b> · Waiting: <b>${state.held ?? 'none'}</b></p><form method="post" action="/__disruption_control"><label>Next controlled action<select name="action">${disruptionFaultModes.map(mode => `<option value="${mode}">${mode}</option>`).join('')}<option value="release">Release the held lookup</option><option value="cancel">Cancel an unused arm</option><option value="switch-other">Switch to the original Other producer and notify open tabs</option></select></label>${keyField}<button type="submit">Apply selected control</button></form><ol><li><b>Exact 404 retry:</b> arm drop-before-dispatch, then record a synthetic supplier report. Check original receipt, observe the actual 404, and explicitly retry the same saved instruction.</li><li><b>Committed response loss:</b> arm drop-committed-response, then record a synthetic supplier report. A response is dropped only after the actual API commits a matching receipt. Recover it by lookup.</li><li><b>Session change during lookup:</b> retain an unresolved committed command; arm hold-receipt-lookup and check its receipt. Switch to Other here, then release the lookup. The old pending instruction must remain intact.</li></ol><p><a href="/__disruption_fixture">Refresh control status</a> · <a href="/disruptions">Open disruption desk</a> · <a href="/tour">Check first-entry touring copy</a></p></section></body></html>`;
}
function sessionCookie(res, access) { res.setHeader('Set-Cookie', `${cookieName}=${access.token}; HttpOnly; SameSite=Lax; Path=/; Expires=${new Date(access.expiresAt).toUTCString()}`); }
function redirect(res, location) { res.writeHead(303, { Location: location }); res.end(); }
async function authenticate(req) {
  if (req.method !== 'POST' || req.headers.origin !== origin) throw Object.assign(new Error('Same-origin form required'), { status: 403 });
  let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1024) throw Object.assign(new Error('Bounded review form required'), { status: 413 }); }
  const fields = new URLSearchParams(body), key = Buffer.from(fields.get('key') ?? ''), expected = Buffer.from(fixture.bootstrapKey);
  if (key.length !== expected.length || !timingSafeEqual(key, expected)) throw Object.assign(new Error('Review key did not match'), { status: 403 });
  return fields;
}
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `${hostname}:${port}`) { res.writeHead(403); return res.end('Exact loopback origin required'); }
    const path = req.url?.split('?')[0];
    if (!['/__disruption_fixture', '/__disruption_control'].includes(path)) {
      if (!await faults.intercept(req, res, () => handler(req, res))) await handler(req, res);
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    if (path === '/__disruption_fixture' && req.method === 'GET') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(page()); }
    const fields = await authenticate(req);
    if (path === '/__disruption_control') {
      const action = fields.get('action');
      if (action === 'release') await faults.release();
      else if (action === 'cancel') await faults.cancel();
      else if (action === 'switch-other') {
        const other = fixture.access.other;
        if (Date.now() >= Date.parse(other.expiresAt)) { res.writeHead(410); return res.end('The original Other capability expired; it was not extended'); }
        sessionCookie(res, other); await record({ event: 'explicit-session-switch', to: 'original-other', expiryUnchanged: true });
        const nonce = randomBytes(18).toString('base64url');
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Original session switched</title><style>${styles}</style><body><h1>Original Other session selected</h1><p>Open production tabs were notified through the existing session channel. The held lookup stays waiting until you release it.</p><p><a href="/__disruption_fixture">Return to controls</a></p><script nonce="${nonce}">localStorage.setItem("opening-night:active-rehearsal",JSON.stringify({tenantId:${JSON.stringify(other.actor.tenantId)},at:Date.now()}));</script></body></html>`);
      } else await faults.arm(action);
      return redirect(res, '/__disruption_fixture');
    }
    const persona = fields.get('persona') ?? 'producer';
    if (!Object.hasOwn(fixture.access, persona)) { res.writeHead(400); return res.end('Choose a retained review persona'); }
    const access = fixture.access[persona];
    if (Date.now() >= Date.parse(access.expiresAt)) { res.writeHead(410); return res.end('The original capability expired; it was not extended'); }
    if (persona === 'supplier') return redirect(res, `/supplier/access#${encodeURIComponent(access.token)}`);
    if (persona === 'sam') return redirect(res, `/crew/access#${encodeURIComponent(access.token)}`);
    sessionCookie(res, access); return redirect(res, '/disruptions');
  } catch (error) { if (!res.destroyed) { res.writeHead(error.status ?? 409); res.end(error.message ?? 'The controlled review could not complete'); } }
});
server.on('error', error => { console.error(`Owned disruption listener failed: ${error.code ?? error.message}`); process.exitCode = 1; });
server.listen(port, hostname, () => console.log(`Owned disruption review ready at ${origin}; providers disabled; original expiry unchanged.`));
