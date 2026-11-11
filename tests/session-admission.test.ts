import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSession, getActor, getShow, migrate, pool, transactCommand } from "../src/server/store";
import { claimSessionAdmission, SessionCreationLimitError } from "../src/server/session-admission";
import { applyCommand } from "../src/domain/commands";
import { assertSameOrigin, errorResponse } from "../src/server/http";

test("Next loopback normalization retains the actual local host and rejects cross-host, foreign-host and cross-port requests", () => {
  const request = (origin: string, host: string) => new Request("http://localhost:4205/api/session", { method: "POST", headers: { origin, host } });
  assert.doesNotThrow(() => assertSameOrigin(request("http://127.0.0.1:4205", "127.0.0.1:4205")));
  assert.doesNotThrow(() => assertSameOrigin(request("http://localhost:4205", "localhost:4205")));
  for (const [origin, host] of [["http://localhost:4205", "127.0.0.1:4205"], ["http://127.0.0.1:4205", "localhost:4205"], ["http://localhost:4205", "outside.example:4205"], ["http://127.0.0.1:4105", "127.0.0.1:4105"], ["null", "localhost:4205"]]) assert.throws(() => assertSameOrigin(request(origin!, host!)), error => error instanceof Error && "code" in error && error.code === "ORIGIN_DENIED");
});

const scopes: string[] = [];
const tenants: string[] = [];
function isolatedScope() { const scope = `test:session-admission:${randomUUID()}`; scopes.push(scope); return scope; }
after(async () => {
  await pool.query("DELETE FROM on_session_admissions WHERE scope=ANY($1::text[])", [scopes]);
  await pool.query("DELETE FROM on_shows WHERE tenant_id=ANY($1::uuid[])", [tenants]);
  await pool.end();
});
async function reserve(scope: string, commit = true) {
  await migrate();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await claimSessionAdmission(client, scope);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function seed(scope: string, count: number, ageSeconds: number) {
  await migrate();
  await pool.query("INSERT INTO on_session_admissions(id,scope,created_at) SELECT gen_random_uuid(),$1,clock_timestamp()-($3::int*interval '1 second') FROM generate_series(1,$2::int)", [scope, count, ageSeconds]);
}
async function count(scope: string) {
  const result = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM on_session_admissions WHERE scope=$1", [scope]);
  return result.rows[0]!.count;
}

test("browser mutation admission rejects missing, opaque and mismatched origins", () => {
  for (const origin of [undefined, "null", "https://other.example", "http://localhost:4106"]) {
    const headers = origin === undefined ? {} : { origin };
    const request = new Request("http://localhost:4105/api/session", { method: "POST", headers });
    assert.throws(() => assertSameOrigin(request), error => {
      const response = errorResponse(error);
      assert.equal(response.status, 403);
      return true;
    });
  }
  assert.doesNotThrow(() => assertSameOrigin(new Request("http://localhost:4105/api/session", { method: "POST", headers: { origin: "http://localhost:4105" } })));
});

test("concurrent database admissions cannot exceed 30 new rehearsals per rolling hour", async () => {
  const scope = isolatedScope();
  const outcomes = await Promise.allSettled(Array.from({ length: 36 }, () => reserve(scope)));
  const failures = outcomes.flatMap(result => result.status === "rejected" ? [{ name: result.reason?.name, code: result.reason?.code }] : []);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 30, JSON.stringify(failures));
  for (const result of outcomes) if (result.status === "rejected") {
    assert.ok(result.reason instanceof SessionCreationLimitError);
    assert.equal(result.reason.status, 429);
    assert.ok(result.reason.retryAfterSeconds > 3500 && result.reason.retryAfterSeconds <= 3600);
  }
  assert.equal(await count(scope), 30);
});

test("200 rolling-day admissions block new sessions even with no recent hourly requests", async () => {
  const scope = isolatedScope();
  await seed(scope, 200, 7200);
  await assert.rejects(reserve(scope), error => {
    assert.ok(error instanceof SessionCreationLimitError);
    assert.ok(error.retryAfterSeconds > 79000 && error.retryAfterSeconds <= 79200);
    const response = errorResponse(error);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), String(error.retryAfterSeconds));
    assert.equal(response.headers.get("cache-control"), "no-store");
    return true;
  });
  assert.equal(await count(scope), 200);
});

test("rolling windows expire independently and remove old admission records", async () => {
  const scope = isolatedScope();
  await seed(scope, 30, 3601);
  await seed(scope, 170, 90_000);
  await reserve(scope);
  assert.equal(await count(scope), 31);
});

test("a failed creation transaction releases its admission reservation", async () => {
  const scope = isolatedScope();
  await reserve(scope, false);
  assert.equal(await count(scope), 0);
  await reserve(scope);
  assert.equal(await count(scope), 1);
});

test("a fresh app process skips applied schema DDL while a session admission transaction is open", async () => {
  await migrate();
  const scope = isolatedScope();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await claimSessionAdmission(client, scope);
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "const {migrate,pool}=await import('./src/server/store.ts'); await migrate(); await pool.end(); console.log('migration-ready');"], { cwd: process.cwd(), timeout: 6000 });
    assert.equal(result.stdout.trim(), "migration-ready");
  } finally { await client.query("ROLLBACK"); client.release(); }
});

test("a valid session preserves its latest revision when creation capacity is full", async () => {
  const scope = isolatedScope();
  const session = await createSession(undefined, scope); tenants.push(session.actor.tenantId);
  await transactCommand(session.actor, randomUUID(), 1, { type: "load_incidents" }, show => applyCommand(show, session.actor, { type: "load_incidents" }));
  await seed(scope, 199, 7200);
  const reused = await createSession(session.token, scope);
  assert.equal(reused.reused, true);
  assert.equal(reused.token, session.token);
  assert.equal(reused.actor.tenantId, session.actor.tenantId);
  assert.equal(reused.show.revision, 2);
  assert.equal(await count(scope), 200);
  assert.equal((await getActor(session.token))?.id, session.actor.id);
  assert.equal((await getShow(session.actor.tenantId)).revision, 2);
  await assert.rejects(createSession(undefined, scope), SessionCreationLimitError);
});

test("an expired cookie cannot bypass admission limits or recover expired authority", async () => {
  const scope = isolatedScope();
  const session = await createSession(undefined, scope); tenants.push(session.actor.tenantId);
  await pool.query("UPDATE on_sessions SET expires_at=now()-interval '1 second' WHERE tenant_id=$1", [session.actor.tenantId]);
  assert.equal(await getActor(session.token), null);
  await seed(scope, 199, 7200);
  await assert.rejects(createSession(session.token, scope), SessionCreationLimitError);
  assert.equal(await count(scope), 200);
});
