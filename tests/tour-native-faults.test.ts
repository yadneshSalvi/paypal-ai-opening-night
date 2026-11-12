import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createTourNativeFaults } from "../scripts/qa/tour-native-faults.mjs";

async function fixture() {
  const records: any[] = [], committed = new Map<string, unknown>(), bodies: string[] = [];
  const actorId = "synthetic-producer", token = "T".repeat(43), cookieName = "owned-fixture-session";
  const compress = createRequire(import.meta.url)("next/dist/compiled/compression")();
  const faults = createTourNativeFaults({ producerToken: token, actorId, cookieName, record: async (entry: unknown) => { records.push(entry); } });
  const handler = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8"), command = JSON.parse(body); bodies.push(body);
      if (command.refuse) { res.statusCode = 409; res.end(JSON.stringify({ code: "REFUSED", detail: command.padding ? "Synthetic refusal ".repeat(300) : "" })); return; }
      const receipt = { commandId: command.commandId, actorId, records: [], detail: command.padding ? "Synthetic receipt ".repeat(300) : "" }; committed.set(command.commandId, receipt);
      res.write(JSON.stringify({ receipt }).slice(0, 20)); res.end(JSON.stringify({ receipt }).slice(20));
    } else {
      const receipt = committed.get(req.url!.split("/").at(-1)!);
      res.statusCode = receipt ? 200 : 404;
      res.end(JSON.stringify(receipt ? { receipt } : { code: "TOUR_COMMAND_NOT_FOUND" }));
    }
  };
  const serve = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => { compress(req, res, () => {}); return handler(req, res); };
  const server = createServer((req, res) => { void faults.intercept(req, res, () => serve(req, res)).then(intercepted => { if (!intercepted) return serve(req, res); }).catch(error => { res.statusCode = 500; res.end(String(error)); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const headers = { cookie: `${cookieName}=${token}`, "content-type": "application/json" };
  return { faults, records, committed, bodies, origin, headers, close: async () => { server.closeAllConnections(); server.close(); await once(server, "close"); } };
}
test("controlled absent-command loss reaches exact 404 and explicit identical retry", async () => {
  const f = await fixture(); try {
    const body = JSON.stringify({ commandId: randomUUID(), action: { type: "synthetic-reviewed-command" } });
    await f.faults.arm("drop-before-dispatch");
    await assert.rejects(fetch(f.origin + "/api/tour/commands", { method: "POST", headers: f.headers, body }));
    assert.equal(f.bodies.length, 0); assert.equal(f.committed.size, 0);
    const lookup = await fetch(f.origin + `/api/tour/commands/${JSON.parse(body).commandId}`, { headers: f.headers });
    assert.equal(lookup.status, 404); assert.equal((await lookup.json()).code, "TOUR_COMMAND_NOT_FOUND");
    const retry = await fetch(f.origin + "/api/tour/commands", { method: "POST", headers: f.headers, body });
    assert.equal(retry.status, 200); assert.deepEqual(f.bodies, [body]); assert.equal(f.committed.size, 1);
  } finally { await f.close(); }
});
test("controlled response loss requires a real committed receipt and leaves refusals intact", async () => {
  const f = await fixture(); try {
    for (const encoding of ["identity", "gzip", "deflate"]) {
      const headers = { ...f.headers, "accept-encoding": encoding };
      const commandId = randomUUID(); await f.faults.arm("drop-committed-response");
      await assert.rejects(fetch(f.origin + "/api/tour/commands", { method: "POST", headers, body: JSON.stringify({ commandId, padding: true }) }), `The real ${encoding} receipt response must be lost after commit`);
      assert.equal(f.records.at(-1).event, "dropped-committed-response");
      const lookup = await fetch(f.origin + `/api/tour/commands/${commandId}`, { headers }); assert.equal(lookup.status, 200);
      assert.equal(lookup.headers.get("content-encoding"), encoding === "identity" ? null : encoding);
      await f.faults.arm("drop-committed-response");
      const refused = await fetch(f.origin + "/api/tour/commands", { method: "POST", headers, body: JSON.stringify({ commandId: randomUUID(), refuse: true, padding: true }) });
      assert.equal(refused.status, 409); assert.equal(refused.headers.get("content-encoding"), encoding === "identity" ? null : encoding); assert.equal((await refused.json()).code, "REFUSED");
    }
    assert.equal(f.committed.size, 3);
  } finally { await f.close(); }
});
test("lookup holds are exact-session scoped, retained until explicit release, and cannot be overwritten", async () => {
  const f = await fixture(); try {
    const id = randomUUID(); await f.faults.arm("hold-receipt-lookup");
    const unrelated = await fetch(f.origin + `/api/tour/commands/${id}`, { headers: { cookie: "owned-fixture-session=other" } }); assert.equal(unrelated.status, 404);
    assert.equal(f.faults.state().armed, "hold-receipt-lookup");
    let finished = false;
    const lookup = fetch(f.origin + `/api/tour/commands/${id}`, { headers: f.headers }).then(value => { finished = true; return value; });
    for (let n = 0; n < 100 && !f.faults.state().held; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.faults.state().held, "hold-receipt-lookup"); assert.equal(finished, false);
    await assert.rejects(f.faults.arm("drop-before-dispatch"), /existing fault/);
    await assert.rejects(f.faults.cancel(), /Release/);
    await f.faults.release(); assert.equal((await lookup).status, 404); assert.deepEqual(f.faults.state(), { armed: null, held: null });
  } finally { await f.close(); }
});
