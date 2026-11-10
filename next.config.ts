import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["@bryntum/gantt-node-enterprise", "@fracture/paypal-core", "better-sqlite3", "pg"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), geolocation=()" },
    ] }];
  },
};
export default config;
