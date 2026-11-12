/** Loopback-only fixed original capabilities. No new session, renewal or provider transport. */
import './supplier-recovery-disabled-providers.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, timingSafeEqual, randomUUID, randomBytes } from 'node:crypto';
import next from 'next';
import { createSupplierRecoveryNativeFaults, supplierRecoveryFaultModes } from './supplier-recovery-native-faults.mjs';

const hostname = '127.0.0.1', port = 4586, origin = `http://${hostname}:${port}`, cookieName = 'opening-night-supplier-recovery-4586-session';
const directory = '.artifacts/supplier-recovery-native-4586';
if (process.env.VERCEL || globalThis.openingNightProviderEgressGuard?.version !== 2) throw new Error('Owned provider-blocked local review only');
const fixtureBytes = readFileSync(`${directory}/fixture.json`), fixture = JSON.parse(fixtureBytes);
const qualified = fixture.state === 'ready' ? null : JSON.parse(readFileSync(`${directory}/preparation-qualified.json`, 'utf8'));
const inspected = qualified?.state === 'ready_from_readonly_inspection' && qualified.fixtureSha256 === createHash('sha256').update(fixtureBytes).digest('hex') && qualified.databaseMutations === 0;
if (fixture.version !== 1 || fixture.state !== 'ready' && !inspected || fixture.origin !== origin || fixture.cookie !== cookieName || ['producer', 'supplier', 'northside', 'alternate', 'other', 'sam'].some(name => !fixture.access[name])) throw new Error('The original ready or independently inspected stage16 fixture is required');
const runtime = `${directory}/runtime-${randomUUID()}`; await mkdir(runtime, { mode: 0o700 });
const record = value => writeFile(`${runtime}/${Date.now()}-${randomUUID()}.json`, JSON.stringify({ at: new Date().toISOString(), ...value }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
await record({ event: 'runtime-started', actualProviders: 'disabled', originalExpiries: Object.fromEntries(Object.entries(fixture.access).map(([key, access]) => [key, access.expiresAt])), sourceBuildId: readFileSync('.next/BUILD_ID', 'utf8').trim() });
const faults = createSupplierRecoveryNativeFaults({ producerToken: fixture.access.producer.token, actorId: fixture.access.producer.actor.id, tenantId: fixture.access.producer.actor.tenantId, cookieName, record });
const app = next({ dev: false, hostname, port }); await app.prepare(); const handler = app.getRequestHandler();
const styles = 'body{font:16px system-ui;background:#121719;color:#eee4d3;margin:5vh auto;padding:25px;max-width:780px;line-height:1.7}h1{font-size:44px;font-weight:550;line-height:1.15}label,input,select,button{display:block;margin:15px 0}label{color:#c4b28e;font-size:13px}input,select{box-sizing:border-box;width:100%;padding:14px;background:#20272a;color:#eee4d3;border:1px solid #766141;border-radius:5px;font:inherit}button{padding:15px 23px;font:inherit;background:#d9b77d;border:0;border-radius:5px;color:#231d14;min-height:48px}small{color:#b7bdba}a{color:#d9b77d}section{border-top:1px solid #766141;padding-top:20px;margin-top:35px}code{overflow-wrap:anywhere}li{margin:10px 0}';
const keyField = '<label>Private review key<input name="key" type="password" required autocomplete="off"></label>';
function page() {
  const state = faults.state();
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Opening Night · A current supplier promise</title><style>${styles}</style><body><small>OPENING NIGHT / CONTROLLED SERVICE REVIEW / 4586</small><h1>A new plan starts<br>with a current promise.</h1><p>Brightline’s original rental was approved from an actual engine comparison, then accepted through controlled SDK and delivery services. Its current availability report now requires a reviewed replacement. The $480 fee and $300 hold remain recorded.</p><p>Actual provider transport is blocked. The supplier statements, driver handoff and inspection in this setup are explicitly controlled fixtures. No replacement snapshot, current Northside terms, replacement quote collection or replacement approval has been supplied.</p><form method="post" action="/__supplier_recovery_fixture"><label>Original review persona<select name="persona"><option value="producer">Producer · current disruption and original obligations</option><option value="northside">Northside · publish its own current terms</option><option value="supplier">Brightline · its original accepted unit and retained fee</option><option value="alternate">Same producer · different original capability</option><option value="other">Other production · separate empty history</option><option value="sam">Sam · scoped crew access</option></select></label>${keyField}<button type="submit">Open original review capability</button></form><details><summary>Fixed capability expiries</summary><ul>${Object.entries(fixture.access).map(([name, access]) => `<li>${name}: <code>${access.expiresAt}</code></li>`).join('')}</ul></details><small>The chooser retains each exact capability and its original expiry. It does not create a session or extend access.</small><section><h2>Publish. Compare. Review.</h2><ol><li>Open Northside. Review a new terms edition with explicit Chicago scenario dates, a real validity window, exact fee and hold, and clearly attributed controlled capability, driver and condition sources.</li><li>Open Producer. Review every original obligation and request one new collection. Continue its original requests to see each signed quote or refusal.</li><li>Run the actual recovery comparison. Inspect evidence and tradeoffs, then separately approve a feasible plan.</li><li>Review a distinct replacement reservation. The original Brightline fee, damage hold, return history and unresolved instructions stay unchanged.</li></ol><p>The source expires after the supplier’s selected real window. Each reviewed collection lasts at most 15 real minutes. Publishing a source does not imply a physical sign-off, and a quote does not approve a payment.</p></section><section><h2>Original-command recovery</h2><p>One-shot controls affect only the original Producer’s supplier-recovery commands. They do not affect supplier bearer requests, scheduling or financial actions.</p><p>Armed: <b>${state.armed ?? 'none'}</b> · Waiting: <b>${state.held ?? 'none'}</b></p><form method="post" action="/__supplier_recovery_control"><label>Next controlled action<select name="action">${supplierRecoveryFaultModes.map(mode => `<option value="${mode}">${mode}</option>`).join('')}<option value="release">Release the held receipt lookup</option><option value="cancel">Cancel an unused arm</option><option value="switch-other">Select original Other and notify open tabs</option></select></label>${keyField}<button type="submit">Apply selected control</button></form><p>A committed-response loss withholds only a matching real saved receipt. An explicit 503 before dispatch is recorded separately from a destroyed transport. Claims require the corresponding observed trigger record. Used faults are never reset.</p><p><a href="/__supplier_recovery_fixture">Refresh control status</a> · <a href="/recovery">Open recovery</a> · <a href="/rentals">Read original rentals</a></p></section></body></html>`;
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
    if (!['/__supplier_recovery_fixture', '/__supplier_recovery_control'].includes(path)) { if (!await faults.intercept(req, res, () => handler(req, res))) await handler(req, res); return; }
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    if (path === '/__supplier_recovery_fixture' && req.method === 'GET') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(page()); }
    const fields = await authenticate(req);
    if (path === '/__supplier_recovery_control') {
      const action = fields.get('action');
      if (action === 'release') await faults.release();
      else if (action === 'cancel') await faults.cancel();
      else if (action === 'switch-other') {
        const other = fixture.access.other;
        if (Date.now() >= Date.parse(other.expiresAt)) { res.writeHead(410); return res.end('The original Other capability expired; it was not extended'); }
        sessionCookie(res, other); await record({ event: 'explicit-session-switch', to: 'original-other', expiryUnchanged: true });
        const nonce = randomBytes(18).toString('base64url'); res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`); res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Original session selected</title><style>${styles}</style><body><h1>Original Other selected</h1><p>The held lookup still awaits explicit release. Open tabs were notified through the existing production channel.</p><a href="/__supplier_recovery_fixture">Return to controls</a><script nonce="${nonce}">localStorage.setItem("opening-night:active-rehearsal",JSON.stringify({tenantId:${JSON.stringify(other.actor.tenantId)},at:Date.now()}));</script></body></html>`);
      } else await faults.arm(action);
      return redirect(res, '/__supplier_recovery_fixture');
    }
    const persona = fields.get('persona') ?? 'producer';
    if (!Object.hasOwn(fixture.access, persona)) { res.writeHead(400); return res.end('Choose an original review persona'); }
    const access = fixture.access[persona];
    if (Date.now() >= Date.parse(access.expiresAt)) { res.writeHead(410); return res.end('The original capability expired; it was not extended'); }
    await record({ event: 'original-persona-opened', persona, expiryUnchanged: true });
    if (persona === 'supplier' || persona === 'northside') return redirect(res, `/supplier/access#${encodeURIComponent(access.token)}`);
    if (persona === 'sam') return redirect(res, `/crew/access#${encodeURIComponent(access.token)}`);
    sessionCookie(res, access); return redirect(res, '/recovery');
  } catch (error) { if (!res.destroyed) { res.writeHead(error.status ?? 409); res.end(error.message ?? 'The controlled review could not complete'); } }
});
server.on('error', error => { console.error(`Owned supplier recovery listener failed: ${error.code ?? error.message}`); process.exitCode = 1; });
server.listen(port, hostname, () => console.log(`Owned supplier recovery review ready at ${origin}; actual providers disabled; original expiries retained.`));
