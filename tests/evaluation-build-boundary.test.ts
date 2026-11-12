import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {ROOT} from "../scripts/evaluation/io";
const environment=(audit:string):NodeJS.ProcessEnv=>({PATH:process.env.PATH??"/usr/bin:/bin",NODE_ENV:"test",OPENING_NIGHT_EVALUATION_BUILD_AUDIT:audit});
async function fixture(source:string){
  const audit=await mkdtemp(resolve(ROOT,".artifacts/evaluation-stage16/builds/unit-"));
  const directory=resolve(ROOT,".next/build/chunks");await mkdir(directory,{recursive:true});
  const path=resolve(directory,`qualification-negative-${randomUUID()}.cjs`);await writeFile(path,source,{flag:"wx",mode:0o600});await writeFile(resolve(audit,"fixture-source.cjs"),source,{flag:"wx",mode:0o600});return{audit,path};
}
test("build preload refuses an existing database descriptor before evaluating any source",async()=>{
  const audit=await mkdtemp(resolve(ROOT,".artifacts/evaluation-stage16/builds/unit-")),url="postgresql://no_authority@127.0.0.1:55575/never_connect";
  const child=spawnSync(process.execPath,["--import",resolve(ROOT,"scripts/evaluation/build-isolate.mjs"),"-e","process.stdout.write('MUST_NOT_EXECUTE')"],{cwd:ROOT,env:{...environment(audit),DATABASE_URL:url},encoding:"utf8"});
  assert.notEqual(child.status,0);assert.equal(child.stdout,"");assert.ok(child.stderr.includes("refuses existing database/session configuration"));assert.ok(!child.stderr.includes(url));
});
test("a generated-looking createIpc frame cannot bypass ownership or ordinary TCP/HTTP guards",async()=>{
  const source=`const net=require('node:net'),https=require('node:https');function createIpc(port){return net.createConnection({host:'127.0.0.1',port})};const results=[];for(const call of[()=>createIpc(Number(process.argv[2])),()=>net.connect(55575,'127.0.0.1'),()=>new net.Socket().connect(55575,'127.0.0.1'),()=>https.get('https://invalid.example')]){try{call();results.push('accepted')}catch{results.push('blocked')}}process.stdout.write(JSON.stringify({results,state:globalThis.openingNightEvaluationGuard.state}));`;
  const{audit,path}=await fixture(source);try{
    const child=spawnSync(process.execPath,["--import",resolve(ROOT,"scripts/evaluation/build-isolate.mjs"),path,"54321"],{cwd:ROOT,env:environment(audit),encoding:"utf8"});assert.equal(child.status,0,child.stderr);
    const result=JSON.parse(child.stdout);assert.deepEqual(result.results,Array(4).fill("blocked"));assert.equal(result.state.networkAttemptsBlocked,4);
  }finally{await rm(path,{force:true});}
});
test("even a forged Next-parent marker cannot permit a port the parent does not own",async()=>{
  const source=`const net=require('node:net');function createIpc(port){return net.createConnection({host:'127.0.0.1',port})};try{createIpc(Number(process.argv[2]));process.stdout.write('ACCEPTED')}catch{process.stdout.write('BLOCKED')}`;
  const{audit,path}=await fixture(source);try{
    await writeFile(resolve(audit,`guard-${process.pid}.ndjson`),JSON.stringify({kind:"started",pid:process.pid,nextBuildMain:true})+"\n",{flag:"wx",mode:0o600});
    const child=spawnSync(process.execPath,["--import",resolve(ROOT,"scripts/evaluation/build-isolate.mjs"),path,"54321"],{cwd:ROOT,env:environment(audit),encoding:"utf8"});assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,"BLOCKED");
    const events=(await readFile(resolve(audit,`guard-${child.pid}.ndjson`),"utf8")).trim().split("\n").map(line=>JSON.parse(line));assert.ok(events.some(row=>row.kind==="blocked_transport"));assert.ok(!events.some(row=>row.kind==="compiler_ipc"));
  }finally{await rm(path,{force:true});}
});
