/** Fresh local cluster only. Refuses every existing path, environment and listener. Never resets. */
import './tour-disabled-providers.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { Pool } from 'pg';
const root=path.resolve('.artifacts/tour-postgres'),port=55556,bin=process.env.TOUR_PG_BIN??'/opt/homebrew/bin';
if(existsSync(root)||existsSync('.env'))throw new Error('Original cluster or environment already exists. Inspect its retained intent; never reset or replace it.');
await new Promise((resolve,reject)=>{const listener=net.createServer();listener.once('error',reject);listener.listen(port,'127.0.0.1',()=>listener.close(resolve));});
mkdirSync('.artifacts',{recursive:true,mode:0o700});chmodSync('.artifacts',0o700);mkdirSync(root,{mode:0o700});
const suffix=randomBytes(6).toString('hex'),socket='/tmp/on-tour-'+suffix,admin='on_admin_'+suffix,app='on_tour_app_'+suffix,database='opening_tour_'+suffix;
const adminPassword=randomBytes(32).toString('base64url'),appPassword=randomBytes(32).toString('base64url');mkdirSync(socket,{mode:0o700});
const intent={version:1,root,socket,port,admin,app,database,appSchema:'tour_runtime',createdAt:new Date().toISOString(),state:'initializing',failures:[]};
const save=()=>writeFileSync(path.join(root,'intent.json'),JSON.stringify(intent,null,2)+'\n',{mode:0o600});save();
writeFileSync(path.join(root,'admin-password'),adminPassword+'\n',{mode:0o600});writeFileSync(path.join(root,'credentials.json'),JSON.stringify({adminPassword,appPassword}),{mode:0o600});
function run(name,args,log){const result=spawnSync(path.join(bin,name),args,{encoding:'utf8'});writeFileSync(path.join(root,log),String(result.stdout??'')+String(result.stderr??''),{mode:0o600});if(result.status!==0)throw new Error(`${name} failed; original ${log} and cluster intent retained`);}
try{
run('initdb',['-D',path.join(root,'data'),'-U',admin,'--pwfile='+path.join(root,'admin-password'),'--auth-local=scram-sha-256','--auth-host=scram-sha-256','--encoding=UTF8','--locale=C'],'initdb.log');
const config=path.join(root,'data','postgresql.conf');writeFileSync(config,readFileSync(config,'utf8')+`\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = '${socket}'\nmax_connections = 48\n`);
run('pg_ctl',['-D',path.join(root,'data'),'-l',path.join(root,'server.log'),'-w','start'],'startup.log');
const adminUrl=new URL(`postgresql://127.0.0.1:${port}/postgres`);adminUrl.username=admin;adminUrl.password=adminPassword;const owner=new Pool({connectionString:adminUrl.toString(),max:1});
try{await owner.query(`CREATE ROLE "${app}" LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);await owner.query(`CREATE DATABASE "${database}" OWNER "${app}"`);await owner.query(`REVOKE ALL ON DATABASE "${database}" FROM PUBLIC`);await owner.query('REVOKE CONNECT ON DATABASE postgres FROM PUBLIC');await owner.query('REVOKE CONNECT ON DATABASE template1 FROM PUBLIC');}finally{await owner.end();}
const url=new URL(adminUrl);url.username=app;url.password=appPassword;url.pathname='/'+database;const db=new Pool({connectionString:url.toString(),max:1});try{await db.query('CREATE SCHEMA tour_runtime');await db.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');await db.query(`ALTER ROLE "${app}" IN DATABASE "${database}" SET search_path TO tour_runtime`);}finally{await db.end();}
const environment={DATABASE_URL:url.toString(),JUDGE_SESSION_SECRET:randomBytes(48).toString('base64url'),BRYNTUM_LICENSE_KEY:process.env.BRYNTUM_LICENSE_KEY??'',OPENING_NIGHT_AI_QA:'1',OPENING_NIGHT_QA_FIXTURE:'1',OPENING_NIGHT_TOUR_QA:'1'};writeFileSync('.env',Object.entries(environment).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n')+'\n',{flag:'wx',mode:0o600});intent.state='ready';save();
console.log(JSON.stringify({state:'ready',port,appPort:4558,restrictedAppRole:true,providers:'disabled',intent:path.join(root,'intent.json')}));
}catch(error){intent.state='failed';intent.failures.push({at:new Date().toISOString(),message:error instanceof Error?error.message:'Provisioning failed'});save();throw error;}
