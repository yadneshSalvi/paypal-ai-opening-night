import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const expectedCore = "0.2.4";
const archive = `vendor/fracture-paypal-core-${expectedCore}.tgz`;
assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), "5c03e848a603c91f98f213c9bfee2e5e4ccb00fd54946ae349945c55f53c3f0f");
assert.equal(JSON.parse(readFileSync("package.json", "utf8")).dependencies["@fracture/paypal-core"], "file:" + archive);
const core = JSON.parse(readFileSync("node_modules/@fracture/paypal-core/package.json", "utf8"));
const paypal = JSON.parse(readFileSync("node_modules/paypal/package.json", "utf8"));
assert.equal(core.version, expectedCore); assert.equal(paypal.version, "2.29.0");
for (const name of ["core", "grid", "gantt", "scheduler", "calendar", "gantt-node"]) { const pkg = JSON.parse(readFileSync(`node_modules/@bryntum/${name}-enterprise/package.json`, "utf8")); assert.equal(pkg.version, "8.0.0"); }
console.log("Verified core 0.2.4 SHA-256, APIMatic PayPal 2.29.0, and consistent Bryntum Enterprise 8.0.0 packages.");
