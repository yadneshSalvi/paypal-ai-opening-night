import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
assert.equal(createHash("sha256").update(readFileSync("vendor/fracture-paypal-core-0.2.2.tgz")).digest("hex"), "eb23321fafb98dbf85d3eafdddd249b4c8d50010c5c44f91dd80bc817392d660");
const core = JSON.parse(readFileSync("node_modules/@fracture/paypal-core/package.json", "utf8"));
const paypal = JSON.parse(readFileSync("node_modules/paypal/package.json", "utf8"));
assert.equal(core.version, "0.2.2"); assert.equal(paypal.version, "2.29.0");
for (const name of ["core", "grid", "gantt", "scheduler", "calendar", "gantt-node"]) { const pkg = JSON.parse(readFileSync(`node_modules/@bryntum/${name}-enterprise/package.json`, "utf8")); assert.equal(pkg.version, "8.0.0"); }
console.log("Verified core 0.2.2 SHA-256, APIMatic PayPal 2.29.0, and consistent Bryntum Enterprise 8.0.0 packages.");
