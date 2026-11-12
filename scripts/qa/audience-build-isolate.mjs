// This descriptor permits module construction during Next's build. It names no usable database or session.
// It is never loaded by the4594 attendee server.
import {appendFileSync,readFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import net from "node:net";
import {execFileSync} from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
const nativeCreateConnection=net.createConnection,nativeSocketConnect=net.Socket.prototype.connect;
const root=fileURLToPath(new URL("../../",import.meta.url)).replace(/\/$/,"");
const database="postgresql://audience_build_only@127.0.0.1:1/no_database";
const session="audience-build-only-no-session-authority-not-a-real-secret";
if(process.env.DATABASE_URL&&process.env.DATABASE_URL!==database||process.env.JUDGE_SESSION_SECRET&&process.env.JUDGE_SESSION_SECRET!==session)throw new Error("Audience build refuses existing database/session configuration");
delete process.env.DATABASE_URL;delete process.env.JUDGE_SESSION_SECRET;
await import("./audience-build-network.mjs");
process.env.DATABASE_URL=database;process.env.JUDGE_SESSION_SECRET=session;
const audit=process.env.OPENING_NIGHT_AUDIENCE_BUILD_AUDIT;
if(!audit||!resolve(audit).startsWith(`${root}/.artifacts/audience-stage17/builds/`))throw new Error("Build audit must stay in the owned ignored folder");
const state=globalThis.openingNightAudienceBuildGuard.state;let count=state.networkAttemptsBlocked;
const record=(kind,extra={})=>appendFileSync(resolve(audit,`guard-${process.pid}.ndjson`),JSON.stringify({kind,pid:process.pid,networkAttemptsBlocked:count,at:new Date().toISOString(),...extra})+"\n",{mode:0o600});
Object.defineProperty(state,"networkAttemptsBlocked",{get:()=>count,set:value=>{count=value;record("blocked_transport");},configurable:false});
record("started",{nextBuildMain:process.argv[1]===`${root}/node_modules/next/dist/bin/next`&&process.argv[2]==="build"});process.on("exit",()=>record("exited"));
// Turbopack's generated evaluator connects to one private listener in its direct Next parent.
// This exception exists only during building;the viewer and case workers use isolate.mjs alone.
const guardedCreate=net.createConnection,guardedConnect=net.connect,guardedSocket=net.Socket.prototype.connect;
const compilerPort=Number(process.argv[2]),generatedWorker=Boolean(process.argv[1]?.startsWith(`${root}/.next/build/`))&&Number.isInteger(compilerPort)&&compilerPort>=1024&&compilerPort<=65535;
let compilerUsed=false,insideCompiler=false,ownerChecked=false,ownerVerified=false;
function target(args){let value=args[0];if(Array.isArray(value))value=value[0];return value&&typeof value==="object"?{host:value.host,port:Number(value.port)}:{host:args[1],port:Number(value)};}
function parentOwnsListener(){
  if(ownerChecked)return ownerVerified;ownerChecked=true;
  try{
    const parentAudit=readFileSync(resolve(audit,`guard-${process.ppid}.ndjson`),"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line));
    const sockets=execFileSync("/usr/sbin/lsof",["-nP","-a","-p",String(process.ppid),`-iTCP:${compilerPort}`,"-sTCP:LISTEN","-Fpn"],{cwd:root,encoding:"utf8"});
    ownerVerified=parentAudit.some(row=>row.kind==="started"&&row.nextBuildMain===true)&&sockets.split("\n").includes(`p${process.ppid}`)&&sockets.split("\n").includes(`n127.0.0.1:${compilerPort}`);
    if(!ownerVerified)record("compiler_parent_unverified",{parentPid:process.ppid,port:compilerPort,parentMarkedNext:parentAudit.some(row=>row.nextBuildMain),listener:sockets.trim().split("\n")});
  }catch(error){ownerVerified=false;record("compiler_parent_unverified",{parentPid:process.ppid,port:compilerPort,reason:error instanceof Error?error.name:"unknown"});}return ownerVerified;
}
function compilerRequest(args){const address=target(args),stack=new Error().stack??"";return generatedWorker&&!compilerUsed&&address.host==="127.0.0.1"&&address.port===compilerPort&&stack.includes("at createIpc (")&&stack.includes(`${root}/.next/build/chunks/`)&&parentOwnsListener();}
net.Socket.prototype.connect=function(...args){const address=target(args);if(insideCompiler&&address.host==="127.0.0.1"&&address.port===compilerPort)return Reflect.apply(nativeSocketConnect,this,args);return Reflect.apply(guardedSocket,this,args);};
function compilerConnection(fallback,args){if(!compilerRequest(args))return Reflect.apply(fallback,this,args);insideCompiler=true;try{const socket=Reflect.apply(nativeCreateConnection,this,args);compilerUsed=true;appendFileSync(resolve(audit,`guard-${process.pid}.ndjson`),JSON.stringify({kind:"compiler_ipc",pid:process.pid,parentPid:process.ppid,port:compilerPort,networkAttemptsBlocked:count,at:new Date().toISOString()})+"\n",{mode:0o600});return socket;}finally{insideCompiler=false;}}
net.createConnection=function(...args){return compilerConnection.call(this,guardedCreate,args);};net.connect=function(...args){return compilerConnection.call(this,guardedConnect,args);};
syncBuiltinESMExports();
