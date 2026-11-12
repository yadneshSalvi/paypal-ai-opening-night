import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ROOT, frozenCorpus, applicationSourceBinding,sha256, assertPublicData, writeArtifact } from "../scripts/evaluation/io";
import { singleFixture, tourFixture, reservedTickets, scalingTour } from "../src/domain/evaluation/fixtures";
import { compareExpectation, executeCase } from "../src/domain/evaluation/cases";
import { nativeFixture, percentile } from "../src/domain/evaluation/benchmarks";
import { topologicalOrder } from "../src/domain/scheduling";
import { digest } from "../src/domain/hash";
import { analyseCases } from "../src/domain/evaluation/analysis";
import type { CaseContract, EvaluationCorpus } from "../src/domain/evaluation/contracts";

test("66 frozen expectations retain57 operational and9 supporting cases across retained versions", async () => {
  const {corpus,bytes,freeze} = await frozenCorpus();
  assert.equal(sha256(bytes),freeze.sha256);
  assert.equal(corpus.cases.filter(item=>item.group==="single_show").length,33);
  assert.equal(corpus.cases.filter(item=>item.group==="tour").length,24);
  assert.equal(corpus.cases.filter(item=>["time","readiness"].includes(item.group)).length,9);
  const old = JSON.parse(await readFile(resolve(ROOT,"src/domain/evaluation/corpus-v1.json"),"utf8")) as EvaluationCorpus;
  assert.deepEqual(corpus.cases,old.cases,"Construction correction must not rewrite oracles");
  assert.notEqual(corpus.id,old.id);
  assert.ok(Date.parse(corpus.frozenAt)>Date.parse(old.frozenAt));
  for(const version of [1,2,3]) {
    const frozen=JSON.parse(await readFile(resolve(ROOT,`docs/evaluation/corpus-freeze-v${version}.json`),"utf8"));
    assert.equal(sha256(await readFile(resolve(ROOT,`src/domain/evaluation/corpus-v${version}.json`))),frozen.sha256);
  }
});
test("fresh controlled sources cannot mutate the shared crew or inherit execution evidence", () => {
  const first=singleFixture(),baseline=digest(first.show),second=singleFixture();
  assert.equal(digest(second.show),baseline);
  first.show.resources.find(person=>person.id==="priya")!.skills=[];
  const third=singleFixture();assert.equal(digest(third.show),baseline);
  assert.equal(second.show.approvedPlan,null);
  for(const key of ["tickets","financialEvidence","acknowledgments","facts","runs"] as const) assert.equal(second.show[key].length,0,key);
  const tour=tourFixture();
  for(const production of tour.productions) {assert.deepEqual(production.operationalEvidence,[]);assert.deepEqual(production.commercialEvidence,[]);}
});
test("the evaluator checkout is distinct from its unchanged declared application base",async()=>{
  const{corpus}=await frozenCorpus(),binding=applicationSourceBinding(corpus.sourceCommit);
  assert.equal(binding.applicationBaseCommit,corpus.sourceCommit);assert.equal(binding.applicationBaseMatched,true);assert.deepEqual(binding.applicationChanges,[]);assert.match(binding.checkoutCommit,/^[a-f0-9]{40}$/);assert.equal(typeof binding.checkoutDirty,"boolean");
});
test("the corrected cycle fixture actually contains a cycle and retains its expected refusal", async () => {
  const {corpus}=await frozenCorpus();
  const result=await executeCase(corpus.cases.find(item=>item.id==="S22")!,{engine:false});
  assert.equal(result.observation.state,"pass");
  const input=result.input as {patch:{tasks:Parameters<typeof topologicalOrder>[0];dependencies:Parameters<typeof topologicalOrder>[1]}};
  assert.ok(topologicalOrder(input.patch.tasks,input.patch.dependencies).invalid.includes("Dependency cycle"));
  assert.ok(result.observation.findings.some(finding=>finding.code==="GRAPH_INVALID"));
  assert.equal(result.observation.inputUnchanged,true);
});
test("status,required codes,exact numeric oracles and actual engine result each matter", async () => {
  const {corpus}=await frozenCorpus(),contract=corpus.cases[0]!;
  const raw={status:contract.expectation.status,findings:[],measurements:{...contract.expectation.measurements},engine:{status:"passed" as const,scope:"product_temporal" as const,version:"8.0.0" as const,durationMs:3,inputDigest:null,resultDigest:null,taskCount:82,resourceCount:0,assignmentCount:0,reason:null}};
  assert.deepEqual(compareExpectation(contract,raw),[]);
  assert.ok(compareExpectation(contract,{...raw,status:"infeasible"}).length);
  assert.ok(compareExpectation(contract,{...raw,measurements:{...raw.measurements,costMinor:122999}}).length);
  assert.ok(compareExpectation(contract,{...raw,engine:{...raw.engine,status:"unavailable"}}).length);
  const rejected=corpus.cases.find(item=>item.id==="S04")!;
  assert.ok(compareExpectation(rejected,{...raw,status:"infeasible"}).some(message=>message.includes("QUALIFICATION")));
});
test("unregistered case selectors cannot fall through to a successful observation", async () => {
  const {corpus}=await frozenCorpus(),forged={...corpus.cases[0]!,scenario:"invented_success"} as CaseContract;
  const result=await executeCase(forged,{engine:false});
  assert.equal(result.observation.state,"fail");
  assert.ok(result.observation.findings.some(finding=>finding.code==="OUTSIDE_FROZEN_CORPUS"));
});
test("false-feasibility measurements inspect observed outcomes rather than trusting a pass label",async()=>{
  const {corpus}=await frozenCorpus(),contract=corpus.cases.find(item=>item.id==="S04")!;
  const actual=(await executeCase(contract,{engine:false})).observation;
  assert.equal(analyseCases(corpus,[actual]).falseFeasibilityCount,0);
  const corrupted={...actual,state:"pass" as const,observedStatus:"feasible_with_approval"};
  const metrics=analyseCases(corpus,[corrupted]);assert.equal(metrics.unsafeCasesTested,1);assert.equal(metrics.falseFeasibilityCount,1);assert.deepEqual(metrics.falseFeasibilityCaseIds,["S04"]);
  for(const name of ["manualBaselineMs","humanInterventions","providerCompletionRate","reconciliationAgeMs"] as const)assert.equal(metrics[name],null);
});
test("negative approval boundaries never grant proposal,role or source authority", async () => {
  const {corpus}=await frozenCorpus();
  for(const id of ["S31","S32","S33"]) {
    const result=await executeCase(corpus.cases.find(item=>item.id===id)!,{engine:false});
    assert.equal(result.observation.state,"pass",JSON.stringify(result.observation));
    assert.equal(result.observation.measurements.approved,false);
    assert.equal(result.observation.inputUnchanged,true);
  }
});
test("pending computational tickets and elapsed clocks never count as captured sales or GO", async () => {
  const tickets=reservedTickets();assert.equal(tickets.length,400);
  assert.ok(tickets.every(ticket=>ticket.captureId===null&&ticket.status==="reserved"&&ticket.source==="sample"));
  const {corpus}=await frozenCorpus();
  for(const id of ["R01","R02","R03"]) {
    const result=await executeCase(corpus.cases.find(item=>item.id===id)!,{engine:false});
    assert.equal(result.observation.state,"pass");assert.equal(result.observation.measurements.ready,false);
    assert.equal(result.observation.measurements.providerEvidence,0);
  }
});
test("stress fixtures use declared populations and retain nonfinancial origins", () => {
  for(const size of [120,500]) {const input=nativeFixture(size);assert.equal(input.tasks.length,size);assert.equal(input.resources.length,100);assert.equal(input.assignments.length,size);assert.equal(new Set(input.assignments.map(item=>item.resourceId)).size,100);assert.deepEqual(topologicalOrder(input.tasks,input.dependencies).invalid,[]);}
  for(const size of [3,10,30]) {const input=scalingTour(size);assert.equal(input.productions.length,size);assert.equal(input.productions.flatMap(item=>item.calls).length,size*30);assert.equal(input.tour.resources.length,100);assert.equal(input.tour.legs.length,size-1);assert.ok(input.productions.every(item=>item.commercialEvidence.length===0&&item.operationalEvidence.length===0));}
  assert.throws(()=>nativeFixture(499));assert.throws(()=>scalingTour(31));
});
test("exclusive artifact writes preserve the original result and deny traversal and private metadata", async () => {
  const directory=await mkdtemp(resolve(ROOT,".artifacts/evaluation-stage16/unit-"));
  try {
    const first=await writeArtifact(directory,"cases/S01.json",{state:"fail",expected:"immutable"},"First failure");
    await assert.rejects(writeArtifact(directory,"cases/S01.json",{state:"pass"},"Attempted replacement"));
    assert.equal(sha256(await readFile(resolve(directory,first.path))),first.sha256);
    for(const path of ["../escape.json","/absolute.json","cases/../../escape.json",".private.json"]) await assert.rejects(writeArtifact(directory,path,{},"Denied"));
    assert.throws(()=>assertPublicData('{"path":"/Users/synthetic/private"}'));
    assert.throws(()=>assertPublicData("-----BEGIN PRIVATE KEY-----"));
    assert.doesNotThrow(()=>assertPublicData('{"providerCalls":0,"sourceCommit":"96ff4cd"}'));
  } finally {await rm(directory,{recursive:true,force:true});}
});
test("three-sample p95 is the largest observed sample,with no population inference",()=>{assert.equal(percentile([30,10,20],.5),20);assert.equal(percentile([30,10,20],.95),30);assert.equal(percentile([], .95),null);});
test("isolation blocks TCP,HTTP,UDP,DNS and unsolicited pipes before any transport", () => {
  const code=`import net from 'node:net';import https from 'node:https';import dns from 'node:dns';import dgram from 'node:dgram';const outcomes=[];for(const call of [()=>fetch('https://invalid.example'),()=>net.connect(55575,'127.0.0.1'),()=>https.get('https://invalid.example'),()=>dns.lookup('invalid.example',()=>{}),()=>dgram.createSocket('udp4'),()=>net.createConnection('/tmp/untrusted-evaluation-pipe')]){try{call();outcomes.push('accepted')}catch{outcomes.push('blocked')}}process.stdout.write(JSON.stringify({outcomes,state:globalThis.openingNightEvaluationGuard.state}));`;
  const stdout=execFileSync(process.execPath,["--import",resolve(ROOT,"scripts/evaluation/isolate.mjs"),"--input-type=module","-e",code],{cwd:ROOT,env:{PATH:process.env.PATH??"/usr/bin:/bin",NODE_ENV:"test"},encoding:"utf8"});
  const result=JSON.parse(stdout);assert.deepEqual(result.outcomes,Array(6).fill("blocked"));assert.equal(result.state.networkAttemptsBlocked,6);assert.equal(result.state.toolingIpcSuppressed,0);
});
test("a credential-bearing process is refused before evaluation starts",()=>{
  const child=spawnSync(process.execPath,["--import",resolve(ROOT,"scripts/evaluation/isolate.mjs"),"-e","process.stdout.write('MUST_NOT_EXECUTE')"],{cwd:ROOT,env:{PATH:process.env.PATH??"/usr/bin:/bin",NODE_ENV:"test",OPENAI_API_KEY:"controlled-test-value-no-authority"},encoding:"utf8"});
  assert.notEqual(child.status,0);assert.equal(child.stdout,"");assert.ok(child.stderr.includes("Evaluation refuses credential or database configuration: OPENAI_API_KEY"));assert.ok(!child.stderr.includes("controlled-test-value-no-authority"));
});
