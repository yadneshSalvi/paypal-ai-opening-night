/* Crew-only offline shell. Personal data and durable command identities belong
 * to the versioned client store; API responses and writes are never cached. */
const SHELL_CACHE = "opening-night-crew-shell-v1";
const ASSET_CACHE = "opening-night-crew-assets-v1";
const SHELL_URL = self.location.origin + "/crew/access";
const READY_URL = self.location.origin + "/crew/.offline-ready";
let preparing = null;

function isStaticAsset(url) {
  return url.origin === self.location.origin && url.pathname.startsWith("/_next/static/") && /\.(js|css|woff2?|ttf|svg|png|webp|ico)$/.test(url.pathname);
}
async function retainAsset(url) {
  const cache = await caches.open(ASSET_CACHE);
  const existing = await cache.match(url);
  if (existing) return existing;
  const response = await fetch(new Request(url, { credentials: "omit", cache: "force-cache", signal: AbortSignal.timeout(15000) }));
  if (!response.ok || response.headers.get("content-type")?.includes("text/html")) throw new Error("A crew shell asset is unavailable");
  await cache.put(url, response.clone());
  if (new URL(url).pathname.endsWith(".css")) {
    const css = await response.clone().text();
    const fonts = [...css.matchAll(/url\(["']?([^\s"')]+)["']?\)/g)].map(match => new URL(match[1], url)).filter(isStaticAsset);
    await Promise.all(fonts.map(font => retainAsset(font.href)));
  }
  return response;
}
async function prepareShell() {
  if (preparing) return preparing;
  preparing = (async () => {
    const shellCache = await caches.open(SHELL_CACHE);
    try {
      // Deliberately anonymous even when a producer is signed into this browser.
      const response = await fetch(new Request(SHELL_URL, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15000) }));
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) throw new Error("The anonymous crew shell is unavailable");
      const html = await response.clone().text();
      if (!html.includes("crew-workspace")) throw new Error("This is not the crew shell");
      const assets = [...new Set([...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => new URL(match[1].replaceAll("&amp;", "&"), SHELL_URL)).filter(isStaticAsset).map(url => url.href))];
      if (!assets.some(url => new URL(url).pathname.endsWith(".js"))) throw new Error("The crew shell has no application script");
      await Promise.all(assets.map(retainAsset));
      await shellCache.put(SHELL_URL, response);
      const ready = { version: 1, cachedAt: new Date().toISOString() };
      await shellCache.put(READY_URL, new Response(JSON.stringify(ready), { headers: { "Content-Type": "application/json" } }));
      return ready;
    } catch (error) {
      const existing = await shellCache.match(READY_URL);
      if (existing && await shellCache.match(SHELL_URL)) return existing.json();
      throw error;
    }
  })();
  try { return await preparing; } finally { preparing = null; }
}

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  const obsolete = (await caches.keys()).filter(name => name.startsWith("opening-night-crew-") && ![SHELL_CACHE, ASSET_CACHE].includes(name));
  await Promise.all(obsolete.map(name => caches.delete(name)));
  await self.clients.claim();
})()));
self.addEventListener("message", event => {
  if (event.data?.type !== "PREPARE_CREW_OFFLINE" || !event.ports[0] || !event.source?.url) return;
  const source = new URL(event.source.url);
  if (source.origin !== self.location.origin || source.pathname !== "/crew/access") return;
  event.waitUntil(prepareShell().then(ready => event.ports[0].postMessage({ type: "CREW_OFFLINE_READY", ...ready }), () => event.ports[0].postMessage({ type: "CREW_OFFLINE_UNAVAILABLE" })));
});
self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // No API, RSC request, producer page, or capability URL enters either cache.
  if (request.mode === "navigate" && url.pathname === "/crew/access") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (!response.ok) throw new Error("Crew navigation is unavailable");
        event.waitUntil(prepareShell().catch(() => undefined));
        return response;
      } catch {
        return await (await caches.open(SHELL_CACHE)).match(SHELL_URL) ?? new Response("Open your personal crew link online once and wait for Offline reload ready before using it without a connection.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      }
    })());
  } else if (isStaticAsset(url)) {
    event.respondWith(retainAsset(url.href));
  }
});
