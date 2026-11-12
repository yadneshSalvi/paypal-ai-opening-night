/** Focused successor qualification; each attempt keeps its original logs. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { audienceProductionInputs } from './audience-inputs.mjs';
const root=process.cwd(),output='.private/supplier-admin/QUALIFICATION_V2.json';
if(existsSync(output))throw new Error('A qualified original result exists; retain it without repeating the suite.');
const tests=['tests/supplier-admin-store.test.ts','tests/supplier-admin-api.test.ts','tests/supplier-admin-recovery.test.ts','tests/supplier-admin-migration.test.ts','tests/supplier-admin-ui.test.tsx'];
const directory=`.private/supplier-admin/qualification-${randomUUID()}`;
await mkdir(directory,{recursive:true,mode:0o700});
const before=await audienceProductionInputs(root),results=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function run(name,args){
  const path=`${directory}/${name}.log`,file=await open(path,'wx',0o600),startedAt=new Date().toISOString();
  const child=spawn(process.execPath,args,{cwd:root,env:process.env,stdio:['ignore',file.fd,file.fd]});
  const exitCode=await new Promise(done=>{child.once('error',()=>done(-1));child.once('close',code=>done(code??-1));});
  await file.close();const bytes=await readFile(path),result={name,path,startedAt,completedAt:new Date().toISOString(),exitCode,sha256:hash(bytes)};results.push(result);
  if(name==='focused'){result.tests=Number(bytes.toString().match(/^# tests (\d+)$/m)?.[1]);result.failed=Number(bytes.toString().match(/^# fail (\d+)$/m)?.[1]);}
  await writeFile(`${directory}/${name}.json`,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  assert.equal(exitCode,0,`Retained ${name} qualification failed: ${path}`);
  if(name==='focused'){assert.equal(result.tests,41);assert.equal(result.failed,0);assert.doesNotMatch(bytes.toString(),/^not ok /m);}
}
try{
  await run('focused',['--import','./scripts/qa/supplier-admin-runtime.mjs','--import','tsx','--test','--test-concurrency=1',...tests]);
  await run('typecheck',[resolve('node_modules/typescript/bin/tsc'),'--noEmit']);
  await run('packages',['--import','tsx','scripts/verify-packages.ts']);
  assert.equal((await audienceProductionInputs(root)).digest,before.digest,'Application inputs changed during qualification');
  const result={state:'qualified',unit:'supplier-admin-stage19',completedAt:new Date().toISOString(),productionInputDigest:before.digest,tests,results,actualProviderCalls:0,actualModelCalls:0,actualExternalMessages:0,actualPhysicalHandoffs:0,provenance:'Real PostgreSQL and actual application services/installed engine; financial responses use the installed SDK controlled transport. Mounted geometry is not native evidence.'};
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({state:result.state,tests:41,failures:0,directory,productionInputDigest:before.digest}));
}catch(error){await writeFile(`${directory}/failed.json`,JSON.stringify({state:'failed',at:new Date().toISOString(),productionInputDigest:before.digest,results,message:error instanceof Error?error.message:'Qualification failed'},null,2)+'\n',{flag:'wx',mode:0o600});throw error;}
