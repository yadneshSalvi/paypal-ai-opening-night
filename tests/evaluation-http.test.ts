import test from "node:test";
import assert from "node:assert/strict";
import {readFile,readlink} from "node:fs/promises";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import type {EvidenceIndex,EvaluationReport} from "../src/domain/evaluation/contracts";
// Deliberate loopback-only qualification of the owned report server. No provider/application adapters.
const root=fileURLToPath(new URL("../",import.meta.url)).replace(/\/$/,"");
if(process.cwd()!==root)throw new Error("Use the isolated evaluation checkout");
for(const[name,value]of Object.entries(process.env))if(value&&/PAYPAL|OPENAI|GEMINI|ANTHROPIC|DATABASE_URL|JUDGE_SESSION_SECRET/.test(name))throw new Error("HTTP qualification refuses existing authority configuration");
const origin="http://127.0.0.1:4587",hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const index=JSON.parse(await readFile(resolve(root,"public/evaluation/index.json"),"utf8"))as EvidenceIndex,current=index.runs[0]!;
const freezePointer=JSON.parse(await readFile(resolve(root,".artifacts/evaluation-stage16/freeze-current.json"),"utf8"));
const frozen=JSON.parse(await readFile(resolve(root,freezePointer.path),"utf8"))as{commit:string;manifests:{build:{path:string;sha256:string;kind?:string}[]}};
async function request(path:string,method="GET"){
  assert.ok(path.startsWith("/")&&!path.startsWith("//"));const url=new URL(path,origin);assert.equal(url.origin,origin);
  const response=await fetch(url,{method,redirect:"error",credentials:"omit",signal:AbortSignal.timeout(15000)});
  assert.equal(response.headers.get("x-opening-night-evaluation"),"read-only-controlled-report","The allocated port is not the owned report server");assert.equal(response.headers.get("set-cookie"),null,"A report read must not create a session");return response;
}
let html="";
test("actual production HTML is the pinned read-only evaluation,with no session response",async()=>{
  const response=await request("/evaluation");assert.equal(response.status,200);html=await response.text();assert.ok(html.includes("The Rehearsal Ledger"));assert.ok(html.includes(current.report.sha256));assert.ok(!html.includes("fonts.googleapis.com"));assert.ok(!html.includes("BRYNTUM_LICENSE_KEY"));
});
test("actual report and corpus HTTP bytes reproduce their publication hashes",async()=>{
  for(const file of[current.report,current.corpus,current.sourceManifest]){const response=await request(file.path);assert.equal(response.status,200);const bytes=new Uint8Array(await response.arrayBuffer());assert.equal(bytes.length,file.bytes);assert.equal(hash(bytes),file.sha256);}
});
test("case and native benchmark downloads retain the exact current evidence bytes",async()=>{
  const report=JSON.parse(await readFile(resolve(root,`public${current.report.path}`),"utf8"))as EvaluationReport;
  for(const path of["cases/S32.json","benchmarks/B02-500.json"]){const expected=report.artifacts.find(file=>file.path===path)!;const response=await request(`/evaluation/${current.runId}/${path}`);assert.equal(response.status,200);assert.equal(hash(new Uint8Array(await response.arrayBuffer())),expected.sha256);}
});
test("actual emitted CSS,JavaScript and font bytes match the frozen production build",async()=>{
  assert.ok(html);const paths=[...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"<>]+)"/g)].map(match=>match[1]!.replaceAll("&amp;","&")))];assert.ok(paths.length>=4);
  let styles="";for(const path of paths){const response=await request(path);assert.equal(response.status,200);const bytes=new Uint8Array(await response.arrayBuffer()),entry=frozen.manifests.build.find(row=>row.path===`.next${new URL(path,origin).pathname.replace("/_next","")}`);assert.ok(entry,path);assert.equal(hash(bytes),entry.sha256);if(path.includes(".css"))styles+=new TextDecoder().decode(bytes);}
  const fontPaths=[...new Set([...styles.matchAll(/url\(["\']?(\/evaluation\/fonts\/[^)"\'\s]+\.woff2)["\']?\)/g)].map(match=>match[1]!))];assert.equal(fontPaths.length,3);
  const fontManifest=JSON.parse(await readFile(resolve(root,"public/evaluation/fonts/manifest.json"),"utf8"));
  for(const path of fontPaths){const face=fontManifest.faces.find((value:{file:string})=>path.endsWith(`/`+value.file));assert.ok(face,path);const response=await request(path);assert.equal(response.status,200);assert.equal(hash(new Uint8Array(await response.arrayBuffer())),face.sha256);}
});
test("all unrelated production views are denied before application routing",async()=>{
  for(const path of["/","/tour","/crew","/box-office","/recovery","/disruptions","/supplier/access"]){const response=await request(path);assert.equal(response.status,404);assert.match(await response.text(),/serves only the controlled evaluation/);}
});
test("session and application API attempts cannot initialize a database or create authority",async()=>{
  for(const[path,method]of[["/api/session","POST"],["/api/session","GET"],["/api/command","POST"],["/api/tour","GET"]]){const response=await request(path!,method);assert.equal(response.status,404);}
});
test("encoded traversal and private configuration paths cannot escape the static allowlist",async()=>{
  for(const path of["/evaluation/%2e%2e/api/session","/evaluation/%252e%252e/api/session","/.private/root-authorized-engine.env","/evaluation/not-a-published-file.json"]){const response=await request(path);assert.equal(response.status,404);assert.match(await response.text(),/serves only the controlled evaluation/);}
});
test("the evaluation accepts only read methods",async()=>{
  assert.equal((await request("/evaluation","HEAD")).status,200);const denied=await request("/evaluation","POST");assert.equal(denied.status,405);assert.equal(denied.headers.get("allow"),"GET, HEAD");
});
test("the running viewer still has zero outbound or database attempts",async()=>{
  const runtime=JSON.parse(await readFile(resolve(root,".artifacts/evaluation-stage16/runtime/viewer4587.json"),"utf8"));assert.equal(runtime.port,4587);assert.ok(runtime.scope.includes("no DB,session,provider,model or engine key"));
  const audit=(await readFile(resolve(root,runtime.audit),"utf8")).trim().split("\n").map(line=>JSON.parse(line));assert.ok(audit.some(row=>row.kind==="listening"));assert.ok(audit.every(row=>row.networkAttemptsBlocked===0));
});
test("serving the evaluation did not change any frozen production output",async()=>{
  for(const file of frozen.manifests.build){assert.equal(file.kind==="internal_symlink"?createHash("sha256").update(await readlink(resolve(root,file.path))).digest("hex"):hash(await readFile(resolve(root,file.path))),file.sha256,file.path);}
});
