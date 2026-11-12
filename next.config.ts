import type { NextConfig } from "next";

const config: NextConfig = {
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
      // The production console uses same-document navigation. A denied landing policy would also deny the later native planning microphone.
      { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
    ] }, { source: "/crew/access", headers: [{ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }] }, { source: "/supplier/access", headers: [{ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }] }, { source: "/delivery/access", headers: [{ key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" }] }, { source: "/crew/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }, { key: "Service-Worker-Allowed", value: "/crew/" }] }];
  },
};
export default config;
