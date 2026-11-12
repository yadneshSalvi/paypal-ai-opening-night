/** Restricted real-model lane: one owned database/role and explicitly authorized OpenAI requests. */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import pg from 'pg';
if (process.env.VERCEL || existsSync(path.resolve('.env'))) throw new Error('Use the isolated actual-model runtime without an application environment file');
for (const [key,value] of Object.entries(process.env)) if (value && /OPENAI_API_KEY|GEMINI|PAYPAL|ANTHROPIC|CHANNEL3|GOOGLE_API_KEY|BLOB_READ_WRITE_TOKEN|CRON_SECRET/.test(key)) throw new Error('The actual-model preload accepts no inherited provider credential');
const configured = new URL(process.env.DATABASE_URL ?? 'postgresql://unconfigured@127.0.0.1:1/unconfigured');
const database = process.env.OPENING_NIGHT_MODEL_DATABASE, role = process.env.OPENING_NIGHT_MODEL_ROLE, port = Number(process.env.OPENING_NIGHT_MODEL_TEST_PORT);
assert.equal(configured.hostname,'127.0.0.1');assert.equal(Number(configured.port),port);assert.equal(decodeURIComponent(configured.pathname.slice(1)),database);assert.equal(decodeURIComponent(configured.username),role);
assert.ok(database?.startsWith('opening_model_') && role?.startsWith('model_app_'));
const state={blockedTransport:0,blockedDatabaseIdentity:0,ownDatabaseConnections:0,originalModelRequests:0,providerConnections:0,suppressedToolingIpc:0};
const slot=new AsyncLocalStorage(),nativeFetch=globalThis.fetch.bind(globalThis),nativeSocketConnect=net.Socket.prototype.connect,nativeTls=tls.connect;
const deny=()=>{state.blockedTransport++;throw new Error('This lane permits only its owned database and bound original OpenAI requests');};
globalThis.fetch=deny;for(const client of [http,https])for(const name of ['get','request'])client[name]=deny;
const nativePg=pg.Client.prototype.connect;
pg.Client.prototype.connect=function(...args){const p=this.connectionParameters;if(p.database!==database||p.user!==role||p.host!=='127.0.0.1'||Number(p.port)!==port){state.blockedDatabaseIdentity++;throw new Error('Original model database and role required');}return Reflect.apply(nativePg,this,args);};
function address(args){const first=Array.isArray(args[0])?args[0][0]:args[0];return first&&typeof first==='object'?first:{port:first,host:args[1]};}
net.Socket.prototype.connect=function(...args){const a=address(args);if(a.host==='127.0.0.1'&&Number(a.port)===port&&/\/node_modules\/pg\/lib\/connection\.js:/.test(new Error().stack??'')){state.ownDatabaseConnections++;return Reflect.apply(nativeSocketConnect,this,args);}if(slot.getStore()&&Number(a.port)===443&&(a.host==='api.openai.com'||a.servername==='api.openai.com')){state.providerConnections++;return Reflect.apply(nativeSocketConnect,this,args);}return deny();};
tls.connect=function(...args){const a=address(args);if(slot.getStore()&&(a.servername==='api.openai.com'||a.host==='api.openai.com')&&Number(a.port??443)===443)return Reflect.apply(nativeTls,this,args);return deny();};
const optionalPipe=path.join(os.tmpdir(),`tsx-${process.geteuid?process.geteuid():os.userInfo().username}`,`${process.ppid}.pipe`);
const nativeCreate=net.createConnection;
function createConnection(...args){if(args[0]===optionalPipe&&/\/node_modules\/tsx\/dist\/client-(?:BQVF1NaW\.mjs|D6NvIMSC\.cjs):/.test(new Error().stack??'')){state.suppressedToolingIpc++;const socket=new net.Socket();queueMicrotask(()=>socket.emit('error',Object.assign(new Error('Optional tooling IPC suppressed'),{code:'ECONNREFUSED'})));return socket;}if(slot.getStore())return Reflect.apply(nativeCreate,this,args);return deny();}
net.createConnection=createConnection;net.connect=createConnection;dgram.createSocket=deny;
for(const target of [dns,dnsPromises,dns.Resolver.prototype,dnsPromises.Resolver.prototype])for(const name of ['lookup','lookupService','resolve','resolve4','resolve6','resolveAny','resolveCaa','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','reverse'])if(typeof target[name]==='function'){const native=target[name];target[name]=function(...args){if(slot.getStore()&&args[0]==='api.openai.com'&&['lookup','resolve4','resolve6'].includes(name))return Reflect.apply(native,this,args);return deny();};}
syncBuiltinESMExports();
let registered=false;
export function registerActualModelProvider(key,authorize){
 assert.equal(registered,false);assert.ok(typeof key==='string'&&key.length>20);registered=true;
 return {configured:true,mode:'live_model',fetch:async(input,init)=>{
  const url=new URL(String(input)),method=init?.method??'GET';assert.equal(url.origin,'https://api.openai.com');assert.equal(url.search,'');assert.equal(url.hash,'');assert.equal(url.username,'');assert.equal(url.password,'');assert.ok(method==='POST'&&url.pathname==='/v1/responses'||method==='GET'&&/^\/v1\/responses\/resp_[A-Za-z0-9_-]{1,240}$/.test(url.pathname));assert.equal(init?.redirect,'error');
  await authorize(url,init);state.originalModelRequests++;const headers=new Headers(init?.headers);headers.set('Authorization',`Bearer ${key}`);
  return slot.run({method,path:url.pathname},()=>nativeFetch(url,{...init,headers}));
 }};
}
export function modelRuntimeAudit(){return {database,role,port,...state};}
if(process.env.OPENING_NIGHT_MODEL_GUARD_AUDIT)process.once('exit',()=>{mkdirSync(process.env.OPENING_NIGHT_MODEL_GUARD_AUDIT,{recursive:true,mode:0o700});writeFileSync(path.join(process.env.OPENING_NIGHT_MODEL_GUARD_AUDIT,`${process.pid}.json`),JSON.stringify({at:new Date().toISOString(),...modelRuntimeAudit()})+'\n',{flag:'wx',mode:0o600});});
