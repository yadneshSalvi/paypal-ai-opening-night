import type { NextConfig } from "next";

/**
 * Enforced on every response (documents, API routes, static files and the crew service worker).
 * These four directives cannot break rendering: the app embeds no plugins, sets no <base>, is never framed
 * (matching X-Frame-Options: DENY) and submits no native form to another origin. PayPal buyer approval is a
 * top-level navigation to the official PayPal page, which no CSP fetch directive restricts.
 *
 * The complete per-request nonce policy (script-src, style-src, connect-src and the rest) is produced by
 * src/proxy.ts. It ships as Content-Security-Policy-Report-Only until the browser checks listed in
 * docs/OPERATIONS.md pass; src/proxy.ts explains the one-variable switch to enforcement.
 */
export const baselineContentSecurityPolicy = "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'";

const config: NextConfig = {
  // `next dev` otherwise re-adds a managed block to the tracked AGENTS.md (see node_modules/next/dist/docs/.../agentRules.md).
  agentRules: false,
  outputFileTracingRoot: process.cwd(),
  outputFileTracingExcludes: { "/*": ["./.env", "./.env.*", "./.private/**/*", "./.artifacts/**/*", "./plans/**/*"] },
  serverExternalPackages: ["@bryntum/gantt-node-enterprise", "@fracture/paypal-core", "@paypal/agent-toolkit", "axios", "better-sqlite3", "pg", "ws", "pdfjs-dist", "exceljs", "yauzl"],
  outputFileTracingIncludes: { "/api/wrap/reports/**": ["./public/fonts/NotoSans-Regular.ttf", "./public/fonts/NotoSans-Bold.ttf", "./public/fonts/OFL.txt"], "/api/sources/**": ["./src/server/sources/parser-worker.mjs", "./node_modules/pdfjs-dist/legacy/build/**", "./node_modules/@napi-rs/canvas/**", "./node_modules/@napi-rs/canvas-*/**", "./node_modules/exceljs/**", "./node_modules/yauzl/**"] },
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: baselineContentSecurityPolicy },
      // The production console uses same-document navigation. A denied landing policy would also deny the later native planning microphone.
      { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
    ] }, { source: "/crew/access", headers: [{ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }] }, { source: "/supplier/access", headers: [{ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }] }, { source: "/delivery/access", headers: [{ key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" }] }, { source: "/crew/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }, { key: "Service-Worker-Allowed", value: "/crew/" }] }];
  },
};
export default config;
