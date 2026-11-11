/** Browser worker policy tests with a controlled fetch/cache transport. Native
 * offline reload remains a separate browser qualification. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const origin = "https://crew-test.invalid";
const shell = '<html><link href="/_next/static/app.css" rel="stylesheet"><body class="crew-workspace"><script src="/_next/static/app.js"></script></body></html>';
function fixture() {
  const listeners = new Map<string, (event: any) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const calls: { url: string; credentials: string; method: string }[] = [];
  let online = true, shellBody = shell;
  const key = (request: string | Request) => typeof request === "string" ? request : request.url;
  const caches = {
    keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name),
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return { match: async (request: string | Request) => store.get(key(request))?.clone(), put: async (request: string | Request, response: Response) => { store.set(key(request), response.clone()); } };
    },
  };
  const context = vm.createContext({ URL, Request, Response, AbortSignal, Set, Promise, Date, Error, caches, self: { location: { origin }, clients: { claim: async () => undefined }, skipWaiting: async () => undefined, addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener) },
    fetch: async (request: Request) => {
      calls.push({ url: request.url, credentials: request.credentials, method: request.method });
      if (!online) throw new TypeError("Controlled offline transport");
      const path = new URL(request.url).pathname;
      if (path === "/crew/access") return new Response(shellBody, { headers: { "Content-Type": "text/html" } });
      if (path.endsWith(".css")) return new Response('@font-face { src: url("/_next/static/media/crew.woff2"); }', { headers: { "Content-Type": "text/css" } });
      if (path.endsWith(".woff2")) return new Response("controlled font bytes", { headers: { "Content-Type": "font/woff2" } });
      return new Response("/* controlled static JavaScript */", { headers: { "Content-Type": "text/javascript" } });
    },
  });
  vm.runInContext(readFileSync(new URL("../public/crew/sw.js", import.meta.url), "utf8"), context);
  const prepare = async (source = origin + "/crew/access") => {
    const work: Promise<unknown>[] = [], replies: any[] = [];
    listeners.get("message")!({ source: { url: source }, data: { type: "PREPARE_CREW_OFFLINE" }, ports: [{ postMessage: (value: unknown) => replies.push(value) }], waitUntil: (promise: Promise<unknown>) => work.push(promise) });
    await Promise.all(work); return replies[0];
  };
  const request = async (url: string, method = "GET", mode = "cors"): Promise<Response | null> => {
    const response: { promise?: Promise<Response> } = {}; const work: Promise<unknown>[] = [];
    listeners.get("fetch")!({ request: { url, method, mode }, respondWith: (value: Promise<Response>) => { response.promise = value; }, waitUntil: (value: Promise<unknown>) => work.push(value) });
    const result = response.promise ? await response.promise : null; await Promise.all(work); return result;
  };
  return { stores, calls, prepare, request, offline: () => { online = false; }, setShell: (value: string) => { shellBody = value; } };
}

test("offline setup stores only an anonymous crew shell and its static scripts, styles and fonts", async () => {
  const value = fixture(); const ready = await value.prepare();
  assert.equal(ready.type, "CREW_OFFLINE_READY");
  assert.ok(value.calls.length >= 4); assert.ok(value.calls.every(call => call.credentials === "omit" && call.method === "GET"));
  const keys = [...value.stores.values()].flatMap(store => [...store.keys()]);
  assert.ok(keys.includes(origin + "/crew/access")); assert.ok(keys.includes(origin + "/_next/static/media/crew.woff2"));
  assert.ok(keys.every(url => url === origin + "/crew/access" || url === origin + "/crew/.offline-ready" || new URL(url).pathname.startsWith("/_next/static/")));
  value.offline();
  assert.equal(await (await value.request(origin + "/crew/access", "GET", "navigate"))!.text(), shell);
  assert.match(await (await value.request(origin + "/_next/static/app.js"))!.text(), /controlled static/);
  assert.equal((await value.prepare()).type, "CREW_OFFLINE_READY", "offline reload recognizes its already prepared shell");
});
test("crew worker never intercepts APIs, writes, producer navigation, RSC requests or foreign assets", async () => {
  const value = fixture();
  for (const [url, method, mode] of [[origin + "/api/crew", "GET", "cors"], [origin + "/api/crew", "POST", "cors"], [origin + "/api/show", "GET", "cors"], [origin + "/crew", "GET", "navigate"], [origin + "/crew/access?_rsc=controlled", "GET", "cors"], [origin + "/execution", "GET", "navigate"], ["https://foreign.invalid/_next/static/app.js", "GET", "cors"]]) assert.equal(await value.request(url, method, mode), null);
  assert.equal(await value.prepare(origin + "/crew"), undefined); assert.equal(await value.prepare("https://foreign.invalid/crew/access"), undefined);
  assert.equal(value.calls.length, 0); assert.equal(value.stores.size, 0);
});
test("missing offline setup fails explicitly and a non-crew page cannot replace an already cached shell", async () => {
  const blank = fixture(); blank.offline();
  const missing = await blank.request(origin + "/crew/access", "GET", "navigate"); assert.equal(missing!.status, 503); assert.match(await missing!.text(), /online once/);
  const value = fixture(); await value.prepare(); value.setShell("<html>Producer data must never enter the crew cache.</html>");
  assert.equal((await value.prepare()).type, "CREW_OFFLINE_READY");
  value.offline(); const preserved = await value.request(origin + "/crew/access", "GET", "navigate"); assert.equal(await preserved!.text(), shell);
});
