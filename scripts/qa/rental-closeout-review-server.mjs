/** Loopback-only access to original stage15 fixtures. No reset, renewed expiry, or provider transport. */
import './rental-closeout-disabled-providers.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { timingSafeEqual, randomUUID, randomBytes } from 'node:crypto';
import next from 'next';
import { createRentalCloseoutNativeFaults, rentalCloseoutFaultModes } from './rental-closeout-native-faults.mjs';
const hostname = '127.0.0.1', port = 4580, origin = `http://${hostname}:${port}`, cookieName = 'opening-night-rental-closeout-4580-session';
if (process.env.VERCEL || globalThis.openingNightProviderEgressGuard?.version !== 2) throw new Error('Owned provider-blocked local review only');
const fixture = JSON.parse(readFileSync('.artifacts/rental-closeout-native-4580/fixture.json', 'utf8'));
if (fixture.version !== 1 || fixture.state !== 'ready' || fixture.origin !== origin || fixture.cookie !== cookieName || ['producer', 'supplier', 'alternate', 'other', 'sam'].some(name => !fixture.access[name])) throw new Error('Original ready stage15 fixture required');
const runtime = `.artifacts/rental-closeout-native-4580/runtime-${randomUUID()}`; await mkdir(runtime, { mode: 0o700 });
const record = value => writeFile(`${runtime}/${Date.now()}-${randomUUID()}.json`, JSON.stringify({ at: new Date().toISOString(), ...value }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
await record({ event: 'runtime-started', actualProviders: 'disabled', originalExpiry: fixture.expiresAt, sourceBuildId: readFileSync('.next/BUILD_ID', 'utf8').trim() });
const faults = createRentalCloseoutNativeFaults({ producerToken: fixture.access.producer.token, actorId: fixture.access.producer.actor.id, tenantId: fixture.access.producer.actor.tenantId, cookieName, record });
const app = next({ dev: false, hostname, port }); await app.prepare(); const handler = app.getRequestHandler();
const styles = 'body{font:16px system-ui;background:#121719;color:#eee4d3;margin:5vh auto;padding:25px;max-width:780px;line-height:1.7}h1{font-size:44px;font-weight:550;line-height:1.15}label,input,select,button{display:block;margin:15px 0}label{color:#c4b28e;font-size:13px}input,select{box-sizing:border-box;width:100%;padding:14px;background:#20272a;color:#eee4d3;border:1px solid #766141;border-radius:5px;font:inherit}button{padding:15px 23px;font:inherit;background:#d9b77d;border:0;border-radius:5px;color:#231d14;min-height:48px}small{color:#b7bdba}a{color:#d9b77d}section{border-top:1px solid #766141;padding-top:20px;margin-top:35px}code{overflow-wrap:anywhere}';
const keyField = '<label>Private review key<input name="key" type="password" required autocomplete="off"></label>';
function page() {
  const state = faults.state();
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Opening Night · Original rental review</title><style>${styles}</style><body><small>OPENING NIGHT / CONTROLLED SDK REVIEW / 4580</small><h1>The last handoff.<br>The original promise.</h1><p>The original fee and authorization were created through installed SDK services over a controlled transport. Supplier delivery and inspection are controlled setup. Actual provider egress is blocked; no real payment or physical handoff is claimed.</p><p>The initial RFQ and schedule used real services and Bryntum. Its later-plan position is a supplied historical snapshot. Fresh late-day replacement terms, scheduling and producer approval remain a separate completion gate.</p><form method="post" action="/__rental_fixture"><label>Original review persona<select name="persona"><option value="producer">Producer · original accepted rental, return and hold review pending</option><option value="supplier">Brightline · inspect own original returned unit</option><option value="alternate">Same producer · different original capability</option><option value="other">Other production · separate empty rental history</option><option value="sam">Sam · scoped crew access</option></select></label>${keyField}<button type="submit">Open original review capability</button></form><small>All five review capabilities retain their original expiry: ${fixture.expiresAt}. This chooser changes no identities, financial terms or expiry.</small><section><h2>Return, then review</h2><ol><li>Open Brightline. Inspect the exact original unit shown on its rental card and record an explicitly controlled condition observation.</li><li>Open Producer. Refresh original facts and inspect the exact $780 authorization, $480 accepted fee and $300 remaining hold.</li><li>Save the separate producer review. Provider processing stays disabled and verified release stays $0.00.</li><li>Inspect retained condition history, alternate-capability scope, stop authority and original-only readback.</li></ol></section><section><h2>Bounded original-command recovery</h2><p>These one-shot controls affect only the original producer’s rental commands. Use “Read original closure” after its first approval for additional recovery checks; each read request retains its own command without dispatching money.</p><p>Armed: <b>${state.armed ?? 'none'}</b> · Waiting: <b>${state.held ?? 'none'}</b></p><form method="post" action="/__rental_control"><label>Next controlled action<select name="action">${rentalCloseoutFaultModes.map(mode => `<option value="${mode}">${mode}</option>`).join('')}<option value="release">Release the held receipt lookup</option><option value="cancel">Cancel an unused arm</option><option value="switch-other">Select original Other and notify open tabs</option></select></label>${keyField}<button type="submit">Apply selected control</button></form><p>“respond-503-before-dispatch” is an explicit controlled server response with zero domain dispatch. “drop-before-dispatch” destroys the transport. A native check must retain its actual trigger record before either behavior is claimed. Committed-response loss withholds only an actual matching saved receipt.</p><p><a href="/__rental_fixture">Refresh control status</a> · <a href="/rentals">Open rental closeout</a> · <a href="/disruptions">Open operating decision</a></p></section></body></html>`;
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
    if (!['/__rental_fixture', '/__rental_control'].includes(path)) { if (!await faults.intercept(req, res, () => handler(req, res))) await handler(req, res); return; }
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    if (path === '/__rental_fixture' && req.method === 'GET') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(page()); }
    const fields = await authenticate(req);
    if (path === '/__rental_control') {
      const action = fields.get('action');
      if (action === 'release') await faults.release();
      else if (action === 'cancel') await faults.cancel();
      else if (action === 'switch-other') {
        const other = fixture.access.other;
        if (Date.now() >= Date.parse(other.expiresAt)) { res.writeHead(410); return res.end('The original Other capability expired; it was not extended'); }
        sessionCookie(res, other); await record({ event: 'explicit-session-switch', to: 'original-other', expiryUnchanged: true });
        const nonce = randomBytes(18).toString('base64url'); res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`); res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Original session selected</title><style>${styles}</style><body><h1>Original Other selected</h1><p>The held lookup remains waiting for explicit release. Open tabs were notified through the existing production channel.</p><a href="/__rental_fixture">Return to controls</a><script nonce="${nonce}">localStorage.setItem("opening-night:active-rehearsal",JSON.stringify({tenantId:${JSON.stringify(other.actor.tenantId)},at:Date.now()}));</script></body></html>`);
      } else await faults.arm(action);
      return redirect(res, '/__rental_fixture');
    }
    const persona = fields.get('persona') ?? 'producer';
    if (!Object.hasOwn(fixture.access, persona)) { res.writeHead(400); return res.end('Choose an original review persona'); }
    const access = fixture.access[persona];
    if (Date.now() >= Date.parse(access.expiresAt)) { res.writeHead(410); return res.end('The original capability expired; it was not extended'); }
    await record({ event: 'original-persona-opened', persona, expiryUnchanged: true });
    if (persona === 'supplier') return redirect(res, `/supplier/access#${encodeURIComponent(access.token)}`);
    if (persona === 'sam') return redirect(res, `/crew/access#${encodeURIComponent(access.token)}`);
    sessionCookie(res, access); return redirect(res, '/rentals');
  } catch (error) { if (!res.destroyed) { res.writeHead(error.status ?? 409); res.end(error.message ?? 'The controlled review could not complete'); } }
});
server.on('error', error => { console.error(`Owned rental listener failed: ${error.code ?? error.message}`); process.exitCode = 1; });
server.listen(port, hostname, () => console.log(`Owned rental review ready at ${origin}; actual providers disabled; original expiry retained.`));
