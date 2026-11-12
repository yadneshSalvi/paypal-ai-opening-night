import test from "node:test";
import assert from "node:assert/strict";
import {readFile,readdir,lstat} from "node:fs/promises";
import {resolve} from "node:path";
import {ROOT,sha256} from "../scripts/evaluation/io";
import {digest} from "../src/domain/hash";
import type {EvidenceIndex,EvaluationReport,EvaluationCorpus,CaseObservation} from "../src/domain/evaluation/contracts";
const index=JSON.parse(await readFile(resolve(ROOT,"public/evaluation/index.json"),"utf8")) as EvidenceIndex;
const current=index.runs[0]!;
const report=JSON.parse(await readFile(resolve(ROOT,`public${current.report.path}`),"utf8")) as EvaluationReport;
const corpus=JSON.parse(await readFile(resolve(ROOT,`public${current.corpus.path}`),"utf8")) as EvaluationCorpus;
test("published current evaluation binds all66 cases,57 operational and9 supporting,with honest unmeasured outcomes",()=>{
  assert.equal(report.cases.length,66);assert.equal(report.scope.operationalCaseCount,57);assert.equal(report.scope.supportingCaseCount,9);assert.deepEqual(report.counts,{pass:66,fail:0,unknown:0,unsupported:0});assert.ok(corpus.id.endsWith("v3"));assert.equal(report.runtime.networkAttemptsBlocked,0);
  assert.ok(report.analysis);assert.equal(report.analysis.falseFeasibilityCount,0);assert.equal(report.analysis.actualNegativeApprovalBoundariesRejected,3);
  for(const field of ["manualBaselineMs","humanInterventions","providerCompletionRate","reconciliationAgeMs"] as const)assert.equal(report.analysis[field],null);
  assert.equal(report.scope.modelCalls,0);assert.equal(report.scope.providerCalls,0);assert.equal(report.scope.databaseConnections,0);assert.equal(report.scope.approvalsGranted,0);assert.ok(report.pending.length>=6);
});
test("every current and original failed publication retains exactly the bytes named by its manifest",async()=>{
  for(const run of index.runs){
    for(const file of [run.report,run.corpus,run.sourceManifest]){const bytes=await readFile(resolve(ROOT,`public${file.path}`));assert.equal(bytes.length,file.bytes);assert.equal(sha256(bytes),file.sha256);}
    const saved=JSON.parse(await readFile(resolve(ROOT,`public${run.report.path}`),"utf8")) as EvaluationReport;
    for(const file of saved.artifacts){assert.ok(!file.path.includes("..")&&!file.path.startsWith("/"));const path=resolve(ROOT,"public/evaluation",run.runId,file.path);assert.ok((await lstat(path)).isFile());const bytes=await readFile(path);assert.equal(sha256(bytes),file.sha256,`${run.runId}/${file.path}`);assert.equal(bytes.length,file.bytes);}
  }
  assert.ok(index.runs.slice(1).some(run=>run.counts.fail===66));assert.ok(index.runs.slice(1).some(run=>run.benchmarkPass===5&&run.benchmarkTotal===7));
});
test("persisted exact current case inputs and outputs independently reproduce their semantic hashes",async()=>{
  for(const observation of report.cases){const saved=JSON.parse(await readFile(resolve(ROOT,"public/evaluation",current.runId,observation.artifact),"utf8")) as {result:{input:unknown;output:unknown;observation:CaseObservation}};
    assert.equal(digest(saved.result.input),observation.inputDigest,`${observation.id} retained input`);assert.equal(digest(saved.result.output),observation.outputDigest,`${observation.id} retained output`);assert.equal(observation.inputUnchanged,true);
  }
  const expiry=report.cases.find(item=>item.id==="S32")!;assert.equal(expiry.engine?.status,"passed");assert.equal(expiry.measurements.engineProofPassed,true);assert.ok(expiry.findings.some(item=>item.code==="QUOTE_EXPIRED"));
});
test("all seven actual benchmark sizes retain three stable,unchanged samples and their declared populations",()=>{
  assert.equal(report.benchmarks.length,7);
  for(const benchmark of report.benchmarks){assert.equal(benchmark.state,"pass");assert.equal(benchmark.samples.length,3);assert.equal(new Set(benchmark.samples.map(item=>item.resultDigest)).size,1);assert.ok(benchmark.samples.every(item=>item.inputUnchanged));assert.equal(benchmark.p95Ms,Math.max(...benchmark.samples.map(item=>item.durationMs)));}
  const native=report.benchmarks.find(item=>item.id==="B02"&&item.size===500)!;for(const sample of native.samples){assert.equal(sample.engine?.resourceCount,100);assert.equal(sample.engine?.assignmentCount,500);assert.equal(sample.engine?.taskCount,500);assert.equal(sample.engine?.scope,"native_resources");}
  const portfolio=report.benchmarks.find(item=>item.id==="B03"&&item.size===30)!;assert.ok(portfolio.samples.every(item=>item.measurements.calls===900&&item.measurements.modeledResources===100&&item.engine?.resourceCount===0));
});
test("current source,installed evaluator dependencies and lock hashes still match the executed source manifest",async()=>{
  const manifest=JSON.parse(await readFile(resolve(ROOT,`public${current.sourceManifest.path}`),"utf8")) as {files:{path:string;sha256:string;bytes:number}[]};
  for(const file of manifest.files){const bytes=await readFile(resolve(ROOT,file.path));assert.equal(bytes.length,file.bytes,file.path);assert.equal(sha256(bytes),file.sha256,file.path);}
  assert.ok(manifest.files.some(file=>file.path==="node_modules/@bryntum/gantt-node-enterprise/gantt.node.mjs"));assert.ok(manifest.files.some(file=>file.path==="package-lock.json"));
});
test("every scoped component CSS hook exists,and responsive/reduced-motion/focus rules are present",async()=>{
  const directory=resolve(ROOT,"src/components/evaluation"),css=await readFile(resolve(directory,"evaluation.module.css"),"utf8");
  const classes=new Set([...css.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map(match=>match[1]));
  for(const file of await readdir(directory))if(file.endsWith(".tsx")){const source=await readFile(resolve(directory,file),"utf8");for(const hook of source.matchAll(/styles\.([A-Za-z_][A-Za-z0-9_]*)/g))assert.ok(classes.has(hook[1]!),`${file}:missing CSS ${hook[1]}`);}
  assert.ok(css.includes("prefers-reduced-motion:reduce"));assert.ok(css.includes(":focus-visible"));assert.ok(css.includes("@media(max-width:600px)"));
});
