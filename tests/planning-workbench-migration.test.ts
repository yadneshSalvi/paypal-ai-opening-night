import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {digest} from '../src/domain/hash';
import {applyCommand} from '../src/domain/commands';
import {isolatedDatabase} from './isolated-database';

test('the joined 20→21→22 migration preserves every prior table, service row and exact fixed expiry',async()=>{
 const database=await isolatedDatabase();
 try{
  // Existing migration-test seam, confined to this disposable schema: build the actual v19 schema first.
  await database.pool.query('CREATE TABLE on_schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  await database.pool.query('INSERT INTO on_schema_migrations(version) VALUES(20),(21),(22)');
  const store=await import('../src/server/store');await store.migrate();
  await database.pool.query('DELETE FROM on_schema_migrations WHERE version IN(20,21,22)');
  const p=await store.createSession(undefined,'joined-migration:'+randomUUID());
  await store.transactCommand(p.actor,randomUUID(),p.show.revision,{type:'load_incidents'},show=>applyCommand(show,p.actor,{type:'load_incidents'}));
  await store.createCrewCapability(p.actor,'sam');
  async function snapshot(){const names=(await database.pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'on_schema_migrations' ORDER BY tablename")).rows.map(row=>row.tablename as string);const tables:Record<string,{rows:number;digest:string;columns:unknown[]}>={};for(const name of names){assert.match(name,/^[a-z_]+$/);const rows=(await database.pool.query(`SELECT row_to_json(t)::text AS row FROM "${name}" t ORDER BY row_to_json(t)::text`)).rows.map(row=>row.row);const columns=(await database.pool.query('SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position',[name])).rows;tables[name]={rows:rows.length,digest:digest(rows),columns};}return tables;}
  const before=await snapshot(),expiry=(await database.pool.query('SELECT token_hash,expires_at::text FROM on_sessions ORDER BY token_hash')).rows;
  assert.equal((await database.pool.query('SELECT max(version) AS version FROM on_schema_migrations')).rows[0].version,19);
  delete(globalThis as typeof globalThis&{openingNightMigration?:Promise<void>}).openingNightMigration;
  await store.migrate();const after=await snapshot();
  for(const[name,value]of Object.entries(before))assert.deepEqual(after[name],value,name);
  const added=Object.keys(after).filter(name=>!before[name]);assert.equal(added.length,15);for(const name of added)assert.equal(after[name]!.rows,0,name);
  assert.deepEqual((await database.pool.query('SELECT token_hash,expires_at::text FROM on_sessions ORDER BY token_hash')).rows,expiry);
  assert.deepEqual((await database.pool.query('SELECT version FROM on_schema_migrations WHERE version>19 ORDER BY version')).rows,[{version:20},{version:21},{version:22}]);
  delete(globalThis as typeof globalThis&{openingNightMigration?:Promise<void>}).openingNightMigration;await store.migrate();assert.deepEqual(await snapshot(),after);
 }finally{await database.close();}
});
