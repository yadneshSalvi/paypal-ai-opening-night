import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { clearExactPlanningRequest, dispatchPlanningInstruction, planningRequestKey, readPlanningInstruction, retryPlanningInstruction } from "../src/components/intelligence/planning-dispatch";
import type { IntelligenceRunView } from "../src/domain/intelligence";

function fixture() {
  const values = new Map<string, string>();
  const storage: Storage = { get length() { return values.size; }, clear: () => values.clear(), getItem: key => values.get(key) ?? null, key: index => [...values.keys()][index] ?? null, removeItem: key => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); } };
  const scope = { tenantId: randomUUID(), sessionExpiresAt: "2030-01-01T00:00:00.123456Z", sessionAccessId: "a".repeat(64) };
  const command = { requestId: randomUUID(), conversationId: randomUUID(), afterRunId: null, prompt: "Check the current source before preparing this alternative." };
  const key = planningRequestKey(scope.tenantId, command.conversationId);
  const run: IntelligenceRunView = { id: randomUUID(), requestId: command.requestId, conversationId: command.conversationId, sequence: 1, state: "completed", revision: 1, sourceDigest: "b".repeat(64), createdAt: new Date().toISOString(), result: null, model: "gpt-6.1-sol", reasoning: "max", provenance: "controlled_fixture", message: "Controlled original result.", retryAfterMs: 3000 };
  return { storage, scope, command, key, run };
}
test("a server error after acceptance retains the instruction and recovers one exact original GET", async () => {
  const { storage, scope, command, key, run } = fixture(), calls: { method: string; body: BodyInit | null | undefined }[] = [];
  const transport = async (_tenant: string, _url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", body: init?.body });
    return init?.method === "POST" ? Response.json({ code: "PLANNING_HISTORY_CHANGED" }, { status: 502 }) : Response.json(run);
  };
  assert.deepEqual(await dispatchPlanningInstruction(scope, command, undefined, storage, transport), run);
  assert.deepEqual(calls.map(call => call.method), ["POST", "GET"]); assert.equal(storage.getItem(key), command.requestId);
  assert.deepEqual(readPlanningInstruction(key, storage)?.command, command);
  clearExactPlanningRequest(key, command.requestId, storage); assert.equal(storage.length, 0);
});
test("a never-received instruction retries only explicitly after another original GET using identical content and scope", async () => {
  const { storage, scope, command, key, run } = fixture(), calls: { url: string; method: string; body: BodyInit | null | undefined; headers: Headers }[] = [];
  let first = true;
  const transport = async (_tenant: string, url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body, headers: new Headers(init?.headers) });
    if (init?.method !== "POST") return Response.json({ error: "Original request not found" }, { status: 404 });
    if (first) { first = false; throw new Error("Controlled disconnect before server dispatch"); }
    return Response.json(run);
  };
  await assert.rejects(dispatchPlanningInstruction(scope, command, undefined, storage, transport), /exact instruction is retained/);
  const saved = readPlanningInstruction(key, storage)!; assert.ok(saved);
  assert.deepEqual(await retryPlanningInstruction(scope, saved, undefined, storage, transport), run);
  assert.deepEqual(calls.map(call => call.method), ["POST", "GET", "GET", "POST"]);
  const posts = calls.filter(call => call.method === "POST"); assert.equal(posts[0]!.body, posts[1]!.body);
  assert.equal(posts[1]!.headers.get("x-opening-night-planning-expiry"), scope.sessionExpiresAt); assert.equal(posts[1]!.headers.get("x-opening-night-planning-access"), scope.sessionAccessId);
  assert.ok(calls.filter(call => call.method === "GET").every(call => call.url.endsWith(command.requestId)));
});
test("a retained instruction cannot move to a different token with identical expiry or to an extended original expiry", async () => {
  const { storage, scope, command, key } = fixture();
  const unavailable = async () => Response.json({}, { status: 404 });
  await assert.rejects(dispatchPlanningInstruction(scope, command, undefined, storage, unavailable));
  const saved = readPlanningInstruction(key, storage)!, before = storage.getItem(`${key}:instruction`); let calls = 0;
  const never = async () => { calls++; throw new Error("Must not dispatch"); };
  for (const changed of [{ ...scope, sessionAccessId: "c".repeat(64) }, { ...scope, sessionExpiresAt: "2030-01-01T00:00:00.123457Z" }, { ...scope, tenantId: randomUUID() }]) {
    await assert.rejects(retryPlanningInstruction(changed, saved, undefined, storage, never), /different or ended original access/);
  }
  assert.equal(calls, 0); assert.equal(storage.getItem(`${key}:instruction`), before); assert.equal(storage.getItem(key), command.requestId);
});
test("an original result appearing before explicit retry is recovered without another POST", async () => {
  const { storage, scope, command, key, run } = fixture();
  await assert.rejects(dispatchPlanningInstruction(scope, command, undefined, storage, async () => Response.json({}, { status: 404 })));
  const saved = readPlanningInstruction(key, storage)!, methods: string[] = [];
  const recovered = await retryPlanningInstruction(scope, saved, undefined, storage, async (_tenant, _url, init) => { methods.push(init?.method ?? "GET"); return Response.json(run); });
  assert.deepEqual(recovered, run); assert.deepEqual(methods, ["GET"]);
});
test("unverified identities and unreadable errors keep the exact instruction; only a definite pre-reservation refusal clears it", async () => {
  for (const bad of ["wrong_identity", "unreadable", "definite_refusal"]) {
    const { storage, scope, command, key, run } = fixture();
    const transport = async (_tenant: string, _url: string, init?: RequestInit) => {
      if (bad === "definite_refusal") return Response.json({ code: "PLANNING_REVIEW_REQUIRED", error: "Read current access" }, { status: 409 });
      if (bad === "unreadable") return new Response("not JSON", { status: 500 });
      return init?.method === "POST" ? Response.json({ ...run, requestId: randomUUID() }) : Response.json({}, { status: 404 });
    };
    await assert.rejects(dispatchPlanningInstruction(scope, command, undefined, storage, transport));
    assert.equal(storage.getItem(key), bad === "definite_refusal" ? null : command.requestId);
  }
});
test("clearing one terminal instruction never removes another original request identity", async () => {
  const { storage, scope, command, key } = fixture();
  await assert.rejects(dispatchPlanningInstruction(scope, command, undefined, storage, async () => Response.json({}, { status: 404 })));
  const other = randomUUID(); storage.setItem(key, other);
  clearExactPlanningRequest(key, command.requestId, storage); assert.equal(storage.getItem(key), other); assert.ok(storage.getItem(`${key}:instruction`));
});
