import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { commerceLockDatabaseUrl } from "../src/server/database-connections";
import { isolatedDatabase } from "./isolated-database";
import { withCommerceLock, closeCommerceLocks } from "../src/server/commerce-locks";

const database = await isolatedDatabase();
after(async () => { await closeCommerceLocks(); await database.close(); });
const direct = "postgresql://operator:private@ep-fixture.us-east-2.aws.neon.tech/show?sslmode=require";
const pooled = direct.replace("ep-fixture.", "ep-fixture-pooler.");
const code = (value: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === value);
test("commerce selects the explicit matching direct endpoint instead of the pooled query endpoint", () => {
  for (const name of ["DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING", "DIRECT_URL"]) assert.equal(commerceLockDatabaseUrl({ DATABASE_URL: pooled, [name]: direct }), direct);
  assert.equal(commerceLockDatabaseUrl({ DATABASE_URL: direct }), direct);
  const local = "postgresql://operator:private@127.0.0.1:5432/show";
  assert.equal(commerceLockDatabaseUrl({ DATABASE_URL: local }), local);
});
test("missing or misleading direct configuration fails closed without exposing credentials", () => {
  for (const configuration of [
    { DATABASE_URL: pooled }, { DATABASE_URL: pooled, DIRECT_URL: pooled },
    { DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: pooled, DIRECT_URL: direct },
    { DATABASE_URL: pooled, DIRECT_URL: direct.replace("/show?", "/other?") },
    { DATABASE_URL: pooled, DIRECT_URL: direct.replace("ep-fixture.", "ep-other.") },
    { DATABASE_URL: pooled, DIRECT_URL: direct.replace("operator:", "other:") },
    { DATABASE_URL: pooled, DIRECT_URL: direct + "&pgbouncer=true" },
    { DATABASE_URL: pooled, DIRECT_URL: direct + "&host=another-pooler" },
    { DATABASE_URL: "postgresql://operator:private@unknown.example/show" },
  ]) assert.throws(() => commerceLockDatabaseUrl(configuration), error => code("COMMERCE_LOCK_CONFIGURATION")(error) && !String(error).includes("private"));
});
async function locks(scope: string) {
  const result = await database.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_locks
    WHERE locktype='advisory' AND classid::bigint=((hashtextextended($1,4105004)>>32)&4294967295)
      AND objid::bigint=(hashtextextended($1,4105004)&4294967295) AND objsubid=1 AND granted`, [scope]);
  return result.rows[0]!.count;
}
test("a held transaction excludes another worker and releases before the same scope resumes", async () => {
  const scope = "direct-lock-test:" + randomUUID();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), finish = new Promise<void>(resolve => { release = resolve; });
  const first = withCommerceLock(scope, async () => { enter(); await finish; return "first"; });
  await entered;
  try {
    assert.equal(await locks(scope), 1);
    await assert.rejects(() => withCommerceLock(scope, async () => "must not run"), code("COMMERCE_WORK_ACTIVE"));
    assert.equal(await locks(scope), 1);
  } finally { release(); await first; }
  assert.equal(await locks(scope), 0);
  assert.equal(await withCommerceLock(scope, async () => "next"), "next");
  assert.equal(await locks(scope), 0);
});
test("work failure rolls back the lock and preserves the original error", async () => {
  const scope = "direct-lock-test:" + randomUUID(), error = new Error("controlled work failure");
  await assert.rejects(() => withCommerceLock(scope, async () => { throw error; }), value => value === error);
  assert.equal(await locks(scope), 0);
  await withCommerceLock(scope, async () => assert.equal(await locks(scope), 1));
  assert.equal(await locks(scope), 0);
});
test("nested same-scope work shares one live lock without retaining it after completion", async () => {
  const scope = "direct-lock-test:" + randomUUID();
  await withCommerceLock(scope, () => withCommerceLock(scope, async () => assert.equal(await locks(scope), 1)));
  assert.equal(await locks(scope), 0);
  const pool = (globalThis as typeof globalThis & { openingNightCommerceLocks?: import("pg").Pool }).openingNightCommerceLocks!;
  assert.equal(pool.totalCount, 0);
});
