import {readFile,readdir,writeFile,mkdir,appendFile,readlink,realpath} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import http from "node:http";
import dns from "node:dns";
import {syncBuiltinESMExports} from "node:module";
const root=fileURLToPath(new URL("../../",import.meta.url)).replace(/\/$/,"");
if(process.cwd()!==root)throw new Error("Use the exact isolated evaluation checkout");
if(!globalThis.openingNightEvaluationGuard||process.env.DATABASE_URL||process.env.JUDGE_SESSION_SECRET||process.env.BRYNTUM_LICENSE_KEY)throw new Error("Viewer runtime requires the strict guard and no database,session or engine configuration");
const qualified=JSON.parse(await readFile(resolve(root,".artifacts/evaluation-stage16/qualified-build.json"),"utf8"));
if(qualified.state!=="qualified"||qualified.buildId!==(await readFile(resolve(root,".next/BUILD_ID"),"utf8")).trim())throw new Error("Start only the qualified production build");
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const pointer=JSON.parse(await readFile(resolve(root,".artifacts/evaluation-stage16/freeze-current.json"),"utf8")),freezeBytes=await readFile(resolve(root,pointer.path));
if(hash(freezeBytes)!==pointer.sha256)throw new Error("Freeze receipt changed");
const frozen=JSON.parse(freezeBytes.toString());
if(frozen.commit!==execFileSync("git",["-C",root,"rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim()||frozen.qualifiedBuild.buildId!==qualified.buildId)throw new Error("Viewer source or build is outside its exact freeze");
for(const file of [...frozen.manifests.source,...frozen.manifests.build]){const path=resolve(root,file.path);if(file.kind==="internal_symlink"){if(!(await realpath(path)).startsWith(`${root}/node_modules/`)||hash(await readlink(path))!==file.sha256)throw new Error("Frozen dependency link changed");}else if(hash(await readFile(path))!==file.sha256)throw new Error("Frozen source or production output changed");}
const allowed=new Set(["/evaluation","/evaluation/"]);
async function allow(directory,prefix){for(const entry of await readdir(directory,{withFileTypes:true})){const full=resolve(directory,entry.name);if(entry.isSymbolicLink())throw new Error("Viewer cannot serve symlinks");if(entry.isDirectory())await allow(full,`${prefix}/${entry.name}`);else if(entry.isFile())allowed.add(`${prefix}/${entry.name}`);}}
await allow(resolve(root,"public/evaluation"),"/evaluation");await allow(resolve(root,".next/static"),"/_next/static");
let literalResolutions=0;
// Binding a server to the numeric loopback literal needs no DNS request. All other DNS stays denied.
const deniedLookup=dns.lookup;
dns.lookup=function(host,options,callback){if(host!=="127.0.0.1")return deniedLookup.apply(this,arguments);literalResolutions++;const done=typeof options==="function"?options:callback;queueMicrotask(()=>options?.all?done(null,[{address:"127.0.0.1",family:4}]):done(null,"127.0.0.1",4));};
syncBuiltinESMExports();
const auditDir=resolve(root,".artifacts/evaluation-stage16/runtime");await mkdir(auditDir,{recursive:true,mode:0o700});
const audit=resolve(auditDir,`viewer-${process.pid}.ndjson`),state=globalThis.openingNightEvaluationGuard.state;
const record=async(kind,extra={})=>appendFile(audit,JSON.stringify({kind,at:new Date().toISOString(),networkAttemptsBlocked:state.networkAttemptsBlocked,...extra})+"\n",{mode:0o600});
let served=0,denied=0;
const next=(await import("next")).default,app=next({dev:false,dir:root,hostname:"127.0.0.1",port:4587});await app.prepare();const handle=app.getRequestHandler();
const server=http.createServer(async(request,response)=>{
  response.setHeader("X-Opening-Night-Evaluation","read-only-controlled-report");response.setHeader("Cache-Control","no-store");
  let path;try{path=decodeURIComponent(new URL(request.url??"/","http://127.0.0.1:4587").pathname);}catch{path="";}
  if(!allowed.has(path)||path.includes("%")){denied++;response.writeHead(404,{"Content-Type":"text/plain; charset=utf-8"});response.end("This runtime serves only the controlled evaluation and its static evidence.\n");await record("denied_route",{served,denied});return;}
  if(!["GET","HEAD"].includes(request.method??"")){denied++;response.writeHead(405,{Allow:"GET, HEAD","Content-Type":"text/plain; charset=utf-8"});response.end("The evaluation is read-only.\n");await record("denied_method",{served,denied});return;}
  served++;try{await handle(request,response);}catch{if(!response.headersSent)response.writeHead(500,{"Content-Type":"text/plain; charset=utf-8"});response.end("Saved evaluation content could not be served.\n");}await record("served",{served,denied});
});
await new Promise((yes,no)=>{server.once("error",no);server.listen({port:4587,host:"127.0.0.1",exclusive:true},yes);});
await writeFile(resolve(auditDir,"viewer4587.json"),JSON.stringify({pid:process.pid,port:4587,host:"127.0.0.1",commit:frozen.commit,freezeSha256:pointer.sha256,buildId:qualified.buildId,serverPolicySha256:hash(await readFile(new URL(import.meta.url))),guardSha256:hash(await readFile(new URL("./isolate.mjs",import.meta.url))),scope:"Only evaluation and static assets;no DB,session,provider,model or engine key",audit:`.artifacts/evaluation-stage16/runtime/viewer-${process.pid}.ndjson`},null,2)+"\n",{flag:"wx",mode:0o600});
await record("listening",{port:4587,literalResolutions});console.log("Read-only controlled evaluation ready at http://127.0.0.1:4587/evaluation");
let closing=false;async function close(){if(closing)return;closing=true;await new Promise(done=>server.close(done));await app.close();await record("closed",{served,denied,literalResolutions});process.exit(0);}
process.on("SIGINT",close);process.on("SIGTERM",close);
