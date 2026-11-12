/** Loopback-only native qualification entry. Never imported by a production route. */
import './tour-disabled-providers.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { timingSafeEqual, randomUUID, randomBytes } from 'node:crypto';
import next from 'next';
import { createTourNativeFaults, nativeFaultModes } from './tour-native-faults.mjs';
const hostname = '127.0.0.1', port = 4561, origin = `http://${hostname}:${port}`, cookieName = 'opening-night-tour-4561-session';
if (process.env.VERCEL || globalThis.openingNightProviderEgressGuard?.version !== 2) throw new Error('Provider-disabled tour review only');
const fixture = JSON.parse(readFileSync('.artifacts/tour-native-4561/fixture.json', 'utf8'));
if (fixture.version !== 2 || fixture.state !== 'ready' || fixture.origin !== origin || fixture.cookie !== cookieName) throw new Error('Original ready isolated stage13 fixture is required');
const runtime = `.artifacts/tour-native-4561/runtime-${randomUUID()}`;
await mkdir(runtime, { mode: 0o700 });
const record = async value => writeFile(`${runtime}/${Date.now()}-${randomUUID()}.json`, JSON.stringify({ at: new Date().toISOString(), ...value }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
await record({ event: 'runtime-started', providers: 'disabled', originalExpiry: fixture.producer.expiresAt });
const faults = createTourNativeFaults({ producerToken: fixture.producer.token, actorId: fixture.producer.actor.id, cookieName, record });
const app = next({ dev: false, hostname, port }); await app.prepare(); const handler = app.getRequestHandler();
const styles = 'body{font:16px system-ui;background:#121719;color:#eee4d3;margin:5vh auto;padding:25px;max-width:780px;line-height:1.7}h1{font-size:40px;font-weight:550;line-height:1.2}label,input,select,button{display:block;margin:15px 0}label{color:#c4b28e;font-size:13px}input,select{box-sizing:border-box;width:100%;padding:14px;background:#20272a;color:#eee4d3;border:1px solid #766141;border-radius:5px;font:inherit}button{padding:15px 23px;font:inherit;background:#d9b77d;border:0;border-radius:5px;color:#231d14;min-height:48px}small{color:#b7bdba}a{color:#d9b77d}section{border-top:1px solid #766141;padding-top:20px;margin-top:35px}code{overflow-wrap:anywhere}';
const keyField = '<label>Private review key<input name="key" type="password" required autocomplete="off"></label>';
function page() {
  const state = faults.state();
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Opening Night · Native repair review</title><style>${styles}</style><body><small>OPENING NIGHT / OWNED SYNTHETIC REVIEW / 4561</small><h1>The road between<br>opening nights.</h1><p>Three fictional venues and explicit synthetic planning declarations. All provider transports are disabled. The two retained source responses are static test data. No personal readback, swap request, recipient consent or producer swap approval is seeded.</p><form method="post" action="/__tour_fixture"><label>Review persona<select name="persona"><option value="producer">Producer · library, route, stage & responsible approval</option><option value="tom">Tom · own calls, request & withdrawal</option><option value="priya">Priya · own calls & recipient consent</option><option value="sam">Sam · own calls & rest context</option><option value="other">Other producer · empty isolated library</option></select></label>${keyField}<button type="submit">Open original touring fixture</button></form><small>Original fixed expiry: ${fixture.producer.expiresAt}. This chooser never replaces identities, renews expiry or erases history.</small><section><h2>Bounded transport checks</h2><p>Arm a one-shot fault here, then use the real Producer UI in another tab. These controls affect only this fixture producer. Every trigger is retained in a new private runtime record.</p><p>Armed: <b>${state.armed ?? 'none'}</b> · Waiting: <b>${state.held ?? 'none'}</b></p><form method="post" action="/__tour_control"><label>Next controlled action<select name="action">${nativeFaultModes.map(mode => `<option value="${mode}">${mode}</option>`).join('')}<option value="release">Release the held lookup or source request</option><option value="cancel">Cancel an unused arm</option><option value="switch-other">Switch to the original Other producer and notify open tabs</option></select></label>${keyField}<button type="submit">Apply selected control</button></form><ol><li><b>Exact 404 retry:</b> arm drop-before-dispatch; create a clearly synthetic blank production in the real UI. The original saved command remains pending. Check original receipt, observe the real 404, then explicitly retry that same instruction.</li><li><b>Committed response loss:</b> arm drop-committed-response; create another synthetic blank production. A response is lost only after the real API commits and returns 200 with its receipt. Recover by lookup without another POST.</li><li><b>Session change during lookup:</b> with an unresolved committed command, arm hold-receipt-lookup; click Check original receipt. In this tab switch to Other, observe the old tab pause, then release the held lookup. Its late result must leave the original pending instruction intact.</li><li><b>Rapid source selection:</b> arm hold-source-result; select synthetic source A, then source B in Admit a source graph. B must stay selected when the older request is released or aborted.</li></ol><p><a href="/__tour_fixture">Refresh control status</a> · <a href="/tour">Open touring desk</a></p></section></body></html>`;
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
    if (!['/__tour_fixture', '/__tour_control'].includes(path)) {
      if (!await faults.intercept(req, res, () => handler(req, res))) await handler(req, res);
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    if (path === '/__tour_fixture' && req.method === 'GET') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(page()); }
    const fields = await authenticate(req);
    if (path === '/__tour_control') {
      const action = fields.get('action');
      if (action === 'release') await faults.release();
      else if (action === 'cancel') await faults.cancel();
      else if (action === 'switch-other') {
        if (Date.now() >= Date.parse(fixture.other.expiresAt)) { res.writeHead(410); return res.end('The original Other capability expired; it was not extended'); }
        sessionCookie(res, fixture.other); await record({ event: 'explicit-session-switch', to: 'original-other', expiryUnchanged: true });
        const nonce = randomBytes(18).toString('base64url');
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Original session switched</title><style>${styles}</style><body><h1>Original Other session selected</h1><p>Open touring tabs were notified using the existing active-session storage channel. The held lookup remains waiting until you release it.</p><p><a href="/__tour_fixture">Return to transport controls</a></p><script nonce="${nonce}">localStorage.setItem("opening-night:active-rehearsal",JSON.stringify({tenantId:${JSON.stringify(fixture.other.actor.tenantId)},at:Date.now()}));</script></body></html>`);
      } else await faults.arm(action);
      return redirect(res, '/__tour_fixture');
    }
    const persona = fields.get('persona') ?? 'producer';
    const access = fixture.crew[persona] ?? fixture[persona];
    if (!['producer', 'other', 'sam', 'tom', 'priya'].includes(persona) || !access?.token) { res.writeHead(400); return res.end('Choose a retained review persona'); }
    if (Date.now() >= Date.parse(access.expiresAt)) { res.writeHead(410); return res.end('The original review capability expired; it was not extended'); }
    if (['sam', 'tom', 'priya'].includes(persona)) return redirect(res, `/tour/crew#token=${encodeURIComponent(access.token)}`);
    sessionCookie(res, access); redirect(res, '/tour');
  } catch (error) { if (!res.destroyed) { res.writeHead(error.status ?? 409); res.end(error.message ?? 'The controlled review could not complete'); } }
});
server.on('error', error => { console.error(`Owned tour listener failed: ${error.code ?? error.message}`); process.exitCode = 1; });
server.listen(port, hostname, () => console.log(`Owned touring review ready at ${origin}; providers disabled; original expiry unchanged.`));
