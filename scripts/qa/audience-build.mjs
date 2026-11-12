import {readFile,readdir,writeFile,mkdir,lstat,open,readlink,realpath} from "node:fs/promises";
import {resolve,relative} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash,randomUUID} from "node:crypto";
import {execFileSync,spawn} from "node:child_process";
import {audienceFontCache} from "./audience-prepare-fonts.mjs";
const root=fileURLToPath(new URL("../../",import.meta.url)).replace(/\/$/,"");
if(process.cwd()!==root||execFileSync("git",["-C",root,"rev-parse","--show-toplevel"],{cwd:root,encoding:"utf8"}).trim()!==root)throw new Error("Use the isolated audience checkout");
if(process.env.VERCEL||process.env.DATABASE_URL||process.env.JUDGE_SESSION_SECRET)throw new Error("Audience builds refuse runtime configuration; use a clean environment");
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const now=new Date().toISOString(),id=`build-${now.replace(/[-:.]/g,"")}-${randomUUID().slice(0,8)}`,directory=resolve(root,".artifacts/audience-stage17/builds",id);
await mkdir(directory,{recursive:true,mode:0o700});
const generatedDependencyLinks=[];
async function walk(path,allowGeneratedLinks=false){const output=[];for(const entry of await readdir(path,{withFileTypes:true})){const full=resolve(path,entry.name);if(entry.isSymbolicLink()){if(!allowGeneratedLinks||!full.startsWith(`${root}/.next/node_modules/`)||!(await realpath(full)).startsWith(`${root}/node_modules/`))throw new Error("Build inputs cannot follow symbolic links");const target=await readlink(full);generatedDependencyLinks.push({path:relative(root,full),target,sha256:hash(target)});continue;}if(entry.isDirectory())output.push(...await walk(full,allowGeneratedLinks));else if(entry.isFile())output.push(full);}return output;}
async function inputs(){const files=[...await walk(resolve(root,"src")),...await walk(resolve(root,"public")),...["package.json","package-lock.json","next.config.ts","tsconfig.json","next-env.d.ts"].map(path=>resolve(root,path))].sort();const rows=[];for(const path of files){const bytes=await readFile(path);rows.push({path:relative(root,path),bytes:bytes.length,sha256:hash(bytes)});}return rows;}
const before=await inputs(),inputHash=hash(JSON.stringify(before));
const verifiedFonts=await audienceFontCache(false);
const fontCache=resolve(root,".private/audience-font-cache"),fontProvenance=JSON.parse(await readFile(resolve(fontCache,"provenance.json"),"utf8"));
for(const font of fontProvenance.records){if(hash(await readFile(resolve(root,"public/audience/fonts",font.font)))!==font.sha256)throw new Error("Approved private font bytes changed");}
const tooling=[];for(const path of["scripts/qa/audience-build.mjs","scripts/qa/audience-build-isolate.mjs","scripts/qa/audience-build-network.mjs","scripts/qa/audience-disabled-runtime.mjs","scripts/qa/audience-prepare-fonts.mjs","scripts/qa/audience-inputs.mjs"]){const bytes=await readFile(resolve(root,path));tooling.push({path,bytes:bytes.length,sha256:hash(bytes)});}
await writeFile(resolve(directory,"prepared.json"),JSON.stringify({schemaVersion:1,tooling,id,createdAt:now,sourceCommit:execFileSync("git",["-C",root,"rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim(),inputHash,inputs:before,fontProvenance,mockResponseSha256:verifiedFonts.mockResponseSha256,mode:"offline default Turbopack;macOS denies non-loopback native outbound;build-only nonconnectable descriptor;Node egress and DB transport blocked"},null,2)+"\n",{flag:"wx",mode:0o600});
const log=await open(resolve(directory,"build.log"),"wx",0o600);
const nativeOutboundPolicy='(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))';
const child=spawn("/usr/bin/sandbox-exec",["-p",nativeOutboundPolicy,process.execPath,resolve(root,"node_modules/next/dist/bin/next"),"build"],{cwd:root,env:{PATH:process.env.PATH??"/usr/bin:/bin",NODE_ENV:"production",NEXT_TELEMETRY_DISABLED:"1",NODE_OPTIONS:`--import ${resolve(root,"scripts/qa/audience-build-isolate.mjs")}`,NEXT_FONT_GOOGLE_MOCKED_RESPONSES:resolve(fontCache,"responses.cjs"),OPENING_NIGHT_AUDIENCE_BUILD_AUDIT:directory},stdio:["ignore",log.fd,log.fd]});
const exitCode=await new Promise(done=>{child.once("error",()=>done(-1));child.once("close",code=>done(code??-1));});await log.close();
const audits=[];for(const file of await readdir(directory))if(/^guard-\d+\.ndjson$/.test(file))for(const line of(await readFile(resolve(directory,file),"utf8")).trim().split("\n"))audits.push(JSON.parse(line));
const attempts=audits.filter(row=>row.kind==="blocked_transport").length;
const after=await inputs(),inputsUnchanged=inputHash===hash(JSON.stringify(after));
const buildRoot=resolve(root,".next"),buildId=await readFile(resolve(buildRoot,"BUILD_ID"),"utf8").catch(()=>null);
let privateTraceHits=0,privateByteHits=0,privatePathByteHits=0,buildFiles=0;const emittedFaces=new Set();
if(buildId){for(const path of await walk(buildRoot,true)){const bytes=await readFile(path);buildFiles++;if(path.startsWith(`${buildRoot}/static/media/`)){const face=fontProvenance.records.find(record=>record.sha256===hash(bytes));if(face)emittedFaces.add(face.family);}if(path.endsWith(".nft.json")){const trace=JSON.parse(bytes);for(const item of trace.files??[]){const full=resolve(path,"..",item);if([".private",".artifacts","plans"].some(part=>full.startsWith(`${root}/${part}/`))||/^\.env(?:\.|$)/.test(relative(root,full)))privateTraceHits++;}}if(path.startsWith(`${buildRoot}/static/`)&&bytes.includes(Buffer.from(root)))privatePathByteHits++;if(process.env.BRYNTUM_LICENSE_KEY&&bytes.includes(Buffer.from(process.env.BRYNTUM_LICENSE_KEY)))privateByteHits++;}}
for(const font of fontProvenance.records){const publicFile=resolve(root,"public/audience/fonts",font.font);const bytes=await readFile(publicFile).catch(()=>null);if(bytes&&hash(bytes)===font.sha256)emittedFaces.add(font.family);}
const state=exitCode===0&&attempts===0&&inputsUnchanged&&buildId&&privateTraceHits===0&&privateByteHits===0&&privatePathByteHits===0&&emittedFaces.size===3?"qualified":"failed";
const result={schemaVersion:1,id,state,completedAt:new Date().toISOString(),exitCode,nativeOutboundPolicy:"macOS sandbox denies non-loopback native outbound;Node permits only the exact parent-owned compiler IPC port",nativeOutboundPolicySha256:hash(nativeOutboundPolicy),servedExactFontFaces:[...emittedFaces].sort(),networkOrDatabaseAttempts:attempts,fontDelivery:"Exact approved bytes served from public/audience/fonts through offline CSS responses",compilerIpcConnections:audits.filter(row=>row.kind==="compiler_ipc").length,auditedProcesses:new Set(audits.map(row=>row.pid)).size,inputsUnchanged,inputHash,buildId:buildId?.trim()??null,buildFiles,privateTraceHits,privateByteHits,privatePathByteHits,generatedDependencyLinks,fontFaces:fontProvenance.records.map(({family,sha256,bytes})=>({family,sha256,bytes})),log:`.artifacts/audience-stage17/builds/${id}/build.log`,preparedSha256:hash(await readFile(resolve(directory,"prepared.json")))};
await writeFile(resolve(directory,"result.json"),JSON.stringify(result,null,2)+"\n",{flag:"wx",mode:0o600});
if(state==="qualified")await writeFile(resolve(root,".artifacts/audience-stage17/qualified-build.json"),JSON.stringify(result,null,2)+"\n",{flag:"wx",mode:0o600});
console.log(JSON.stringify(result,null,2));if(state!=="qualified")process.exitCode=1;
