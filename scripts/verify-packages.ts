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
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
for (const [name, version] of Object.entries({ "@paypal/agent-toolkit": "1.11.0", axios: "1.21.1", "ag-charts-community": "14.3.0", "pdf-lib": "1.17.1", "@pdf-lib/fontkit": "1.1.1" })) {
  assert.equal(manifest.dependencies[name], version);
  assert.equal(JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version, version);
}
for (const [file, hash] of Object.entries({ "NotoSans-Regular.ttf": "b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5", "NotoSans-Bold.ttf": "c976e4b1b99edc88775377fcc21692ca4bfa46b6d6ca6522bfda505b28ff9d6a", "OFL.txt": "0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb" })) assert.equal(createHash("sha256").update(readFileSync(`public/fonts/${file}`)).digest("hex"), hash);
console.log("Verified core 0.2.4 archive, APIMatic PayPal 2.29.0, Bryntum Enterprise 8.0.0, exact wrap package pins and licensed PDF font hashes.");
