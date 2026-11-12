import test,{after,afterEach} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {webcrypto,createHash} from "node:crypto";
import {act,createElement} from "react";
import type {Root} from "react-dom/client";
import {JSDOM} from "jsdom";
import type {ArtifactLink,EvidenceIndex,EvaluationCorpus,EvaluationReport,PublishedRun} from "../src/domain/evaluation/contracts";
import {ROOT} from "../scripts/evaluation/io";
import {EvidenceViewer} from "../src/components/evaluation/evidence-viewer";
import {verifiedJson,validatePair,EvidenceReadError} from "../src/components/evaluation/report-client";

const dom=new JSDOM("<!doctype html><html><body></body></html>",{url:"http://127.0.0.1:4587/evaluation",pretendToBeVisual:true});
for(const name of ["window","document","HTMLElement","HTMLInputElement","HTMLSelectElement","HTMLButtonElement","Element","Node","Event","MouseEvent","KeyboardEvent","history","navigator","location"] as const)Object.defineProperty(globalThis,name,{configurable:true,value:dom.window[name]});
Object.defineProperty(globalThis,"crypto",{configurable:true,value:webcrypto});
Object.defineProperty(globalThis,"IS_REACT_ACT_ENVIRONMENT",{configurable:true,value:true});
dom.window.HTMLElement.prototype.scrollIntoView=function(){};
const{createRoot}=await import("react-dom/client");
const index=JSON.parse(await readFile(resolve(ROOT,"public/evaluation/index.json"),"utf8")) as EvidenceIndex;
const publicBytes=new Map<string,Buffer>();
for(const run of index.runs)for(const item of [run.report,run.corpus])publicBytes.set(item.path,await readFile(resolve(ROOT,`public${item.path}`)));
const current=index.runs[0]!;
let root:Root|null=null,container:HTMLDivElement;
const guardedFetch=globalThis.fetch;
const bytes=(value:unknown)=>Buffer.from(`${JSON.stringify(value)}\n`);
const link=(path:string,data:Buffer,label="Test-only controlled frame"):ArtifactLink=>({path,sha256:createHash("sha256").update(data).digest("hex"),bytes:data.length,label});
function response(path:string){const body=publicBytes.get(path);assert.ok(body,`Unexpected request ${path}`);return new Response(new Uint8Array(body),{headers:{"content-type":"application/json"}});}
function serve(){const calls:{path:string;init:RequestInit|undefined}[]=[];globalThis.fetch=async(input,init)=>{const path=String(input);calls.push({path,init});return response(path);};return calls;}
const deferred=<T,>()=>{let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{resolve,reject,promise};};
async function mount(value:EvidenceIndex=index){container=document.createElement("div");document.body.append(container);root=createRoot(container);await act(async()=>root!.render(createElement(EvidenceViewer,{index:value})));}
async function flush(){await act(async()=>{await new Promise(done=>setTimeout(done,3));});}
async function until(check:()=>boolean){for(let n=0;n<100&&!check();n++)await flush();assert.ok(check(),"Mounted evidence state did not settle");}
async function click(node:HTMLElement){await act(async()=>{node.focus();node.click();});}
function button(label:string){const value=[...container.querySelectorAll<HTMLButtonElement>("button")].find(node=>node.textContent?.trim()===label||node.getAttribute("aria-label")===label);assert.ok(value,`Missing button ${label}`);return value;}
async function editSearch(value:string){const input=container.querySelector<HTMLInputElement>("#case-search")!;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!;await act(async()=>{setter.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});}
async function select(id:string,value:string){const field=container.querySelector<HTMLSelectElement>(`#${id}`)!;await act(async()=>{field.value=value;field.dispatchEvent(new Event("change",{bubbles:true}));});}
afterEach(async()=>{if(root){await act(async()=>root!.unmount());root=null;}document.body.replaceChildren();globalThis.fetch=guardedFetch;history.replaceState(null,"","/evaluation");});
after(()=>dom.window.close());

test("loading shows no verified totals until report and corpus are both hash-verified",async()=>{
  const pending=new Map<string,ReturnType<typeof deferred<Response>>>();globalThis.fetch=async input=>{const request=deferred<Response>();pending.set(String(input),request);return request.promise;};
  await mount();assert.match(container.textContent!,/Verifying the saved evidence/);assert.equal(container.querySelector('[aria-label="Verified case totals"]'),null);
  await act(async()=>pending.get(current.report.path)!.resolve(response(current.report.path)));await flush();assert.equal(container.querySelector('[aria-label="Verified case totals"]'),null);
  await act(async()=>pending.get(current.corpus.path)!.resolve(response(current.corpus.path)));await until(()=>Boolean(container.querySelector('[aria-label="Verified case totals"]')));
  assert.equal(container.querySelector('[role="alert"]'),null);assert.match(container.textContent!,/57/);
});
test("an empty publication never presents invented results or creates a session",async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("Unexpected fetch");};await mount({...index,currentRunId:null,runs:[]});assert.match(container.textContent!,/The ledger is waiting for evidence/);assert.equal(calls,0);assert.equal(container.querySelector('[aria-label="Verified case totals"]'),null);
});
test("requests read only pinned public artifacts,omit credentials and never call production APIs",async()=>{
  const calls=serve();await mount();await until(()=>Boolean(container.querySelector("#case-search")));
  assert.equal(calls.length,2);for(const call of calls){assert.ok(call.path.startsWith(`/evaluation/${current.runId}/`));assert.equal(call.init?.credentials,"omit");assert.equal(call.init?.cache,"no-store");assert.equal(call.init?.redirect,"error");assert.equal(call.init?.method,undefined);}
  assert.match(container.textContent!,/No database, no inherited session, no provider receipts/);
});
test("a same-sized hash failure is visible and retry accepts only the verified replacement",async()=>{
  let corrupted=true;globalThis.fetch=async input=>{const path=String(input);if(corrupted&&path===current.report.path){const body=Buffer.from(publicBytes.get(path)!);body[0]=body[0]===123?91:123;return new Response(new Uint8Array(body));}return response(path);};
  await mount();await until(()=>Boolean(container.querySelector('[role="alert"]')));assert.match(container.querySelector('[role="alert"]')!.textContent!,/HASH_MISMATCH/);assert.equal(container.querySelector("#case-search"),null);
  corrupted=false;await click(button("Retry verification"));await until(()=>Boolean(container.querySelector("#case-search")));assert.equal(container.querySelector('[role="alert"]'),null);
});
test("HTTP denial displays a recoverable error without accepting unverified case content",async()=>{
  globalThis.fetch=async()=>new Response("denied",{status:403});await mount();await until(()=>Boolean(container.querySelector('[role="alert"]')));assert.match(container.textContent!,/HTTP403|HTTP 403/);assert.equal(container.querySelector("#case-search"),null);assert.ok(button("Retry verification"));
});
test("older delayed responses cannot replace the newly selected retained execution",async()=>{
  assert.ok(index.runs.length>=2);const older=index.runs[1]!,pending=new Map<string,ReturnType<typeof deferred<Response>>>();
  globalThis.fetch=async input=>{const path=String(input);if(path.includes(current.runId)){const request=deferred<Response>();pending.set(path,request);return request.promise;}return response(path);};
  await mount();await select("evaluation-run",older.runId);await until(()=>Boolean(container.querySelector("#case-search")));assert.ok(container.textContent!.includes(older.note));
  const sourceHash=container.querySelector('button[aria-label="Copy Report file SHA-256"]')!.parentElement!.nextElementSibling!.textContent;
  await act(async()=>{pending.get(current.report.path)!.resolve(response(current.report.path));pending.get(current.corpus.path)!.resolve(response(current.corpus.path));});await flush();
  assert.equal(container.querySelector('button[aria-label="Copy Report file SHA-256"]')!.parentElement!.nextElementSibling!.textContent,sourceHash);
  assert.equal(sourceHash,older.report.sha256);
});
test("search and group filters retain exact case identities and recover from no matches",async()=>{
  serve();await mount();await until(()=>Boolean(container.querySelector("#case-search")));await editSearch("MINIMUM_REST");assert.ok(container.querySelectorAll('[aria-label^="Inspect T"]').length>0);assert.equal(container.querySelector('[aria-label^="Inspect S01:"]'),null);
  await editSearch("nothing-in-the-frozen-corpus");assert.match(container.textContent!,/No scenarios match these filters/);await click(button("Show all cases"));assert.equal(container.querySelectorAll('[aria-label^="Inspect "]').length,66);
  await select("case-group","tour");assert.equal(container.querySelectorAll('[aria-label^="Inspect "]').length,24);
});
test("native case buttons and inspector navigation move focus to the exact selected heading",async()=>{
  serve();await mount();await until(()=>Boolean(container.querySelector("#case-search")));const opener=container.querySelector<HTMLButtonElement>('[aria-label^="Inspect S22:"]')!;assert.equal(opener.tagName,"BUTTON");assert.equal(opener.type,"button");await click(opener);
  const heading=container.querySelector<HTMLHeadingElement>("#case-inspector-title")!;assert.equal(document.activeElement,heading);assert.match(heading.textContent!,/Dependency cycles/);assert.equal(new URL(window.location.href).searchParams.get("case"),"S22");
  await click(button("Next case →"));assert.equal(document.activeElement,heading);assert.match(heading.textContent!,/missing dependency endpoint/i);assert.equal(new URL(window.location.href).searchParams.get("case"),"S23");
  await click(button("← Previous case"));assert.match(heading.textContent!,/Dependency cycles/);assert.match(container.textContent!,/This pass records a refusal, not a feasible or approved plan/);
});
test("a remounted deep link restores a read-only historical case without executing anything",async()=>{
  history.replaceState(null,"","/evaluation?case=T01");const calls=serve();await mount();await until(()=>Boolean(container.querySelector("#case-inspector-title")));assert.match(container.querySelector("#case-inspector-title")!.textContent!,/Chicago rest deficit/);assert.equal(calls.length,2);assert.equal(container.querySelector('[aria-label^="Inspect T01:"]')!.getAttribute("aria-pressed"),"true");
});
test("an exact retained execution survives remount without defaulting to a newer outcome",async()=>{
  const earlier=index.runs.find(item=>item.counts.fail===66)!;history.replaceState(null,"",`/evaluation?run=${earlier.runId}&case=S22`);const calls=serve();await mount();await until(()=>Boolean(container.querySelector("#case-inspector-title")));
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.path.includes(earlier.runId)));assert.equal(container.querySelector<HTMLSelectElement>("#evaluation-run")!.value,earlier.runId);assert.match(container.querySelector("aside")!.textContent!,/Retained mismatch/);assert.equal(container.querySelector('button[aria-label="Copy Report file SHA-256"]')!.parentElement!.nextElementSibling!.textContent,earlier.report.sha256);
});
test("reverification failure preserves the last verified immutable report and offers a real retry",async()=>{
  serve();await mount();await until(()=>Boolean(container.querySelector("#case-search")));globalThis.fetch=async()=>new Response("denied",{status:503});await click(button("Verify files again"));await until(()=>Boolean(container.querySelector('[role="alert"]')));
  assert.ok(container.querySelector("#case-search"));assert.match(container.textContent!,/last verified immutable report remains visible/);assert.equal(container.querySelector('button[aria-label="Copy Report file SHA-256"]')!.parentElement!.nextElementSibling!.textContent,current.report.sha256);
  serve();await click(button("Retry verification"));await until(()=>!container.querySelector('[role="alert"]'));assert.ok(container.querySelector("#case-search"));
});
test("all four match states remain distinct and expected unknown is not displayed as feasible",async()=>{
  const report=JSON.parse(publicBytes.get(current.report.path)!.toString()) as EvaluationReport;
  report.cases[1]!.state="fail";report.cases[1]!.mismatches=["Test-only displayed mismatch"];report.cases[2]!.state="unknown";report.cases[3]!.state="unsupported";report.counts={pass:63,fail:1,unknown:1,unsupported:1};
  const reportBytes=bytes(report),publication={...current,report:link(current.report.path,reportBytes),counts:report.counts};
  globalThis.fetch=async input=>String(input)===current.report.path?new Response(new Uint8Array(reportBytes)):response(String(input));
  await mount({...index,currentRunId:publication.runId,runs:[publication]});await until(()=>Boolean(container.querySelector("#case-state")));
  for(const state of ["fail","unknown","unsupported"]){await select("case-state",state);assert.equal(container.querySelectorAll('[aria-label^="Inspect "]').length,1);assert.match(container.querySelector('[aria-label^="Inspect "]')!.textContent!,new RegExp(state,"i"));}
  await select("case-state","all");await click(container.querySelector<HTMLButtonElement>('[aria-label^="Inspect S05:"]')!);assert.match(container.querySelector("aside")!.textContent!,/expected uncertainty or review requirement remains unresolved/);
});
test("independent reader rejects oversized,malformed and mismatched summary evidence",async()=>{
  const signal=new AbortController().signal,oversized=Buffer.alloc(current.report.bytes+1,32);globalThis.fetch=async()=>new Response(new Uint8Array(oversized));await assert.rejects(verifiedJson(current.report,signal),(error:unknown)=>error instanceof EvidenceReadError&&error.code==="TOO_LARGE");
  let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("must not fetch");};await assert.rejects(verifiedJson({...current.report,path:"/api/command"},signal),/manifest is invalid/);assert.equal(calls,0);
  const report=JSON.parse(publicBytes.get(current.report.path)!.toString()) as EvaluationReport,corpus=JSON.parse(publicBytes.get(current.corpus.path)!.toString()) as EvaluationCorpus;report.counts.pass--;
  assert.throws(()=>validatePair(report,corpus,current),/summary differs/);
});
