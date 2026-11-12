import test from "node:test";
import assert from "node:assert/strict";
import {nativeFixture,commitNativeResources} from "../src/domain/evaluation/benchmarks";
import {executeCase} from "../src/domain/evaluation/cases";
import {frozenCorpus} from "../scripts/evaluation/io";
import {digest} from "../src/domain/hash";
function freeze(value:unknown):void{if(value&&typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
test("actual native500-task/100-resource construction cannot enrich frozen caller-owned assignment data",async()=>{
  assert.ok(process.env.BRYNTUM_LICENSE_KEY,"A privately staged authorized non-provider engine license is required");
  const input=nativeFixture(500),before=digest(input);freeze(input);
  const result=await commitNativeResources(input);
  assert.equal(result.engine.status,"passed");assert.equal(result.engine.taskCount,500);assert.equal(result.engine.resourceCount,100);assert.equal(result.engine.assignmentCount,500);assert.equal(digest(input),before);
  assert.ok(input.assignments.every(assignment=>!("event" in assignment)&&!("resource" in assignment)));
});
test("a passing actual temporal commit does not erase a hard tour-rest finding",async()=>{
  assert.ok(process.env.BRYNTUM_LICENSE_KEY,"A privately staged authorized engine license is required");const {corpus}=await frozenCorpus();
  const result=await executeCase(corpus.cases.find(item=>item.id==="T01")!,{engine:true});
  assert.equal(result.observation.state,"pass");assert.equal(result.observation.observedStatus,"infeasible");assert.equal(result.observation.engine?.status,"passed");assert.ok(result.observation.findings.some(finding=>finding.code==="MINIMUM_REST"));assert.equal(result.observation.measurements.samRestMinutes,390);
});
test("the expiry refusal has real successful engine proof,so a missing proof cannot mask the current-quote gate",async()=>{
  assert.ok(process.env.BRYNTUM_LICENSE_KEY,"A privately staged authorized engine license is required");const{corpus}=await frozenCorpus();
  const result=await executeCase(corpus.cases.find(item=>item.id==="S32")!,{engine:true});
  assert.equal(result.observation.state,"pass");assert.equal(result.observation.engine?.status,"passed");assert.equal(result.observation.measurements.engineProofPassed,true);assert.equal(result.observation.measurements.sourceStillCurrent,true);assert.equal(result.observation.measurements.approved,false);
  for(const code of ["PLAN_NOT_FEASIBLE","QUOTE_EXPIRED"])assert.ok(result.observation.findings.some(finding=>finding.code===code));
});
