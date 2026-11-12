import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import nextConfig, { baselineContentSecurityPolicy } from "../next.config";
import { proxy, config as proxyConfig } from "../src/proxy";
import { THEME_BOOT_SCRIPT } from "../src/components/theme";
import { createHash } from "node:crypto";

type HeaderRule = { source: string; headers: { key: string; value: string }[] };
const rules = await nextConfig.headers!() as HeaderRule[];
/** Mirrors how Next.js anchors a `source` pattern; later matching rules override earlier keys. */
const configured = (path: string) => { const result = new Map<string, string>(); for (const rule of rules) if (new RegExp(`^${rule.source}$`).test(path)) for (const header of rule.headers) result.set(header.key.toLowerCase(), header.value); return result; };
const directives = (policy: string) => new Map(policy.split(";").map(part => part.trim()).filter(Boolean).map(part => { const [name, ...values] = part.split(/\s+/); return [name!, values] as const; }));
const withEnvironment = async (values: Record<string, string | undefined>, work: () => void | Promise<void>) => {
  const original = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try { for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else (process.env as Record<string, string>)[key] = value; await work(); }
  finally { for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else (process.env as Record<string, string>)[key] = value; }
};
const matcher = new RegExp(`^${proxyConfig.matcher[0]!.source}$`);

test("every route keeps the enforced baseline policy and the existing security headers", () => {
  for (const path of ["/", "/execution", "/crew/access", "/supplier/access", "/delivery/access", "/evaluation", "/api/health", "/api/webhooks/paypal/venue", "/crew/sw.js", "/_next/static/chunks/app.js"]) {
    const headers = configured(path);
    assert.equal(headers.get("content-security-policy"), baselineContentSecurityPolicy, path);
    assert.equal(headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(headers.get("x-frame-options"), "DENY", path);
    assert.equal(headers.get("referrer-policy"), "strict-origin-when-cross-origin", path);
    assert.ok(headers.get("permissions-policy")?.includes("geolocation=()"), path);
  }
  const baseline = directives(baselineContentSecurityPolicy);
  assert.deepEqual(baseline.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(baseline.get("object-src"), ["'none'"]);
  assert.deepEqual(baseline.get("base-uri"), ["'self'"]);
  assert.deepEqual(baseline.get("form-action"), ["'self'"]);
});

test("route-specific device permissions and the crew worker scope are unchanged", () => {
  assert.equal(configured("/").get("permissions-policy"), "camera=(), microphone=(self), geolocation=()");
  assert.equal(configured("/crew/access").get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
  assert.equal(configured("/delivery/access").get("permissions-policy"), "camera=(self), microphone=(), geolocation=()");
  assert.equal(configured("/crew/sw.js").get("service-worker-allowed"), "/crew/");
  assert.equal(nextConfig.agentRules, false);
});

test("documents receive the complete policy with a fresh nonce, report-only by default", async () => {
  await withEnvironment({ OPENING_NIGHT_CSP_ENFORCE: undefined, NODE_ENV: "production" }, () => {
    const seen = new Set<string>();
    for (const path of ["/", "/execution", "/crew/access", "/wallet/return"]) {
      const response = proxy(new NextRequest(`https://opening-night.example${path}`, { headers: { "x-nonce": "chosen", "content-security-policy": "script-src 'nonce-chosen'" } }));
      assert.equal(response.headers.get("content-security-policy"), null, path);
      const policy = directives(response.headers.get("content-security-policy-report-only")!);
      const script = policy.get("script-src")!, nonce = script.find(value => value.startsWith("'nonce-"))!.slice(7, -1);
      assert.match(nonce, /^[A-Za-z0-9+/]{24}$/); assert.notEqual(nonce, "chosen"); seen.add(nonce);
      // The only inline script without a nonce is the layout's no-flash theme script, allowed by the hash of its exact text.
      assert.deepEqual(script, ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", `'sha256-${createHash("sha256").update(THEME_BOOT_SCRIPT).digest("base64")}'`]);
      // Next.js stamps the nonce it finds in the forwarded request policy; a client-supplied one must not survive.
      assert.equal(response.headers.get("x-middleware-request-x-nonce"), nonce);
      assert.equal(response.headers.get("x-middleware-request-content-security-policy-report-only"), response.headers.get("content-security-policy-report-only"));
      assert.ok(!response.headers.get("x-middleware-override-headers")?.split(",").includes("content-security-policy"));
      assert.deepEqual(policy.get("default-src"), ["'self'"]);
      assert.deepEqual(policy.get("connect-src"), ["'self'"]);
      assert.deepEqual(policy.get("style-src"), ["'self'", "'unsafe-inline'"]);
      assert.deepEqual(policy.get("img-src"), ["'self'", "data:", "blob:"]);
      assert.deepEqual(policy.get("media-src"), ["'self'", "blob:"]);
      assert.deepEqual(policy.get("worker-src"), ["'self'"]);
      assert.deepEqual(policy.get("frame-src"), ["'none'"]);
      for (const [name, values] of directives(baselineContentSecurityPolicy)) assert.deepEqual(policy.get(name), values, name);
      for (const values of policy.values()) for (const value of values) assert.ok(!/^https?:|^\*|unsafe-eval/.test(value), `${path}: ${value}`);
      assert.ok(!script.includes("'unsafe-inline'"), path);
    }
    assert.equal(seen.size, 4);
  });
});

test("the enforcement switch sends the same policy as an enforced header", async () => {
  await withEnvironment({ OPENING_NIGHT_CSP_ENFORCE: "1", NODE_ENV: "production" }, () => {
    const response = proxy(new NextRequest("https://opening-night.example/"));
    assert.equal(response.headers.get("content-security-policy-report-only"), null);
    const policy = directives(response.headers.get("content-security-policy")!);
    assert.ok(policy.get("script-src")!.includes("'strict-dynamic'")); assert.ok(policy.has("upgrade-insecure-requests"));
    assert.equal(response.headers.get("x-middleware-request-content-security-policy"), response.headers.get("content-security-policy"));
  });
});

test("prerendered pages get the policy without a nonce, and only development allows React debugging eval", async () => {
  await withEnvironment({ OPENING_NIGHT_CSP_ENFORCE: undefined, NODE_ENV: "production" }, () => {
    for (const path of ["/evaluation", "/attendee", "/planning-workbench", "/approvals", "/approvals/review", "/inputs", "/suppliers/manage", "/suppliers/manage/owner", "/evaluation/"]) {
      const response = proxy(new NextRequest(`https://opening-night.example${path}`, { headers: { "content-security-policy-report-only": "script-src 'nonce-chosen'" } }));
      const policy = directives(response.headers.get("content-security-policy-report-only")!);
      assert.deepEqual(policy.get("script-src"), ["'self'", "'unsafe-inline'"], path);
      assert.deepEqual(policy.get("connect-src"), ["'self'"], path);
      // No nonce reaches the renderer, including one a client tried to supply.
      assert.equal(response.headers.get("x-middleware-request-x-nonce"), null, path);
      assert.equal(response.headers.get("x-middleware-request-content-security-policy-report-only"), null, path);
    }
    // Near-miss paths are rendered per request by the catch-all route and keep the nonce.
    for (const path of ["/evaluation-extra", "/inputs/other", "/approvals/review/extra"]) assert.ok(directives(proxy(new NextRequest(`https://opening-night.example${path}`)).headers.get("content-security-policy-report-only")!).get("script-src")!.includes("'strict-dynamic'"), path);
  });
  await withEnvironment({ OPENING_NIGHT_CSP_ENFORCE: undefined, NODE_ENV: "development" }, () => {
    const policy = directives(proxy(new NextRequest("http://localhost:4105/")).headers.get("content-security-policy-report-only")!);
    assert.ok(policy.get("script-src")!.includes("'unsafe-eval'")); assert.deepEqual(policy.get("connect-src"), ["'self'", "ws:", "wss:"]);
  });
});

test("the proxy runs for documents and skips APIs, build assets and public files", () => {
  for (const path of ["/", "/execution", "/crew/access", "/evaluation", "/suppliers/manage/owner"]) assert.ok(matcher.test(path), path);
  for (const path of ["/api/health", "/api/webhooks/paypal/venue", "/_next/static/chunks/app.js", "/_next/image", "/favicon.ico", "/crew/sw.js", "/fonts/NotoSans-Regular.ttf", "/evaluation/index.json"]) assert.ok(!matcher.test(path), path);
});
