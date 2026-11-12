/** Re-score original one-shot messages locally; no model or database transport. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=process.cwd(),folder=path.resolve(process.argv[2]??'');
assert.ok(folder.startsWith(path.join(root,'.artifacts/model-stage17/')));
globalThis.fetch=()=>{throw new Error('Local retained-message scoring cannot use a provider');};
const hash=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const protocolBytes=await readFile(path.join(folder,'protocol.json')),protocol=JSON.parse(protocolBytes),firstBytes=await readFile(path.join(folder,'report.json')),first=JSON.parse(firstBytes);
assert.equal(protocol.contract,'opening-night-blind-assessment-v1');assert.equal(protocol.corpusDigest,first.corpusDigest);assert.equal(first.attempted,protocol.cases.length);
const classification=['feasible','feasible_with_approval','infeasible','unknown_pending_evidence','needs_review','no_approvable_candidate'];
function pointerExists(input,pointer){if(pointer==='')return true;if(typeof pointer!=='string'||!pointer.startsWith('/'))return false;let value=input;for(const token of pointer.slice(1).split('/')){const key=token.replaceAll('~1','/').replaceAll('~0','~');if(!value||typeof value!=='object'||!Object.hasOwn(value,key))return false;value=value[key];}return true;}
const outcomes=[];
for(const record of protocol.cases){
 const directory=path.join(folder,'cases',record.id),originalBytes=await readFile(path.join(directory,'result.json')),original=JSON.parse(originalBytes),request=JSON.parse(await readFile(path.join(directory,'request.json'))),input=JSON.parse(await readFile(path.join(directory,'input.json'))),observationBytes=await readFile(path.join(directory,`observation-${String(original.observations).padStart(3,'0')}.json`)),observation=JSON.parse(observationBytes);
 assert.equal(hash(JSON.stringify(request)),record.requestSha256);assert.equal(hash(canonical(input)),record.inputDigest);assert.equal(hash(observation.raw),observation.rawSha256);
 const body=JSON.parse(observation.raw),identity=JSON.parse(await readFile(path.join(directory,'provider-identity.json')));assert.equal(body.id,identity.id);assert.equal(body.store,false);assert.deepEqual(body.metadata,request.metadata);assert.equal(body.status,original.state);assert.ok(body.model===protocol.model||body.model.startsWith(protocol.model+'-'));
 let prediction=null,score=null,parseFailure=null;
 if(original.state==='completed')try{
  const output=body.output;assert.ok(Array.isArray(output));assert.ok(output.every(item=>['message','reasoning'].includes(item.type)));
  // Opaque reasoning is required for continuation, not for grading a completed one-shot message.
  const text=output.filter(item=>item.type==='message').flatMap(item=>item.content??[]).map(part=>{assert.equal(part.type,'output_text');return part.text;}).join('');
  prediction=JSON.parse(text);assert.ok(classification.includes(prediction.classification));assert.ok(Array.isArray(prediction.findings)&&Array.isArray(prediction.assumptions));
  const observedCodes=[...new Set(prediction.findings.map(item=>item.code))].sort(),invalidPointers=prediction.findings.flatMap(item=>item.evidencePointers.filter(pointer=>!pointerExists(input,pointer)));
  const missingCodes=record.expected.requiredCodes.filter(code=>!observedCodes.includes(code)),statusMatch=prediction.classification===record.expected.classification,citationsValid=!invalidPointers.length&&prediction.findings.every(item=>item.evidencePointers.length>0);
  score={statusMatch,requiredReasonsMatch:!missingCodes.length,missingCodes,observedCodes,citationsValid,invalidPointers,falseFeasibility:['feasible','feasible_with_approval'].includes(prediction.classification)&&!['feasible','feasible_with_approval'].includes(record.expected.classification),combinedMatch:statusMatch&&!missingCodes.length&&citationsValid};
 }catch(e){parseFailure=e.message;}
 outcomes.push({...original,prediction,score,parseFailure,originalResultSha256:hash(originalBytes),originalObservationSha256:hash(observationBytes),originalParseFailure:original.parseFailure,continuationReasoningAvailable:body.output?.every(item=>item.type!=='reasoning'||typeof item.encrypted_content==='string'&&item.encrypted_content.length>0)??false});
}
const scored=outcomes.filter(x=>x.score),elapsed=outcomes.map(x=>x.elapsedMs).sort((a,b)=>a-b);
const report={contract:'opening-night-retained-one-shot-scoring-v1',at:new Date().toISOString(),sourceCommit:first.sourceCommit,protocolSha256:hash(protocolBytes),originalReportSha256:hash(firstBytes),corpusDigest:protocol.corpusDigest,scoringChange:'Removed only the opaque reasoning requirement from one-shot message grading. Every frozen status, required reason-code and JSON-pointer scoring rule is unchanged. Original parser and GET include failures remain retained. No new model response was requested.',providerCreatesDuringScoring:0,originalModelCreates:outcomes.length,scored:scored.length,statusMatches:scored.filter(x=>x.score.statusMatch).length,combinedMatches:scored.filter(x=>x.score.combinedMatch).length,falseFeasibility:scored.filter(x=>x.score.falseFeasibility).length,validCitations:scored.filter(x=>x.score.citationsValid).length,latencyMs:{median:elapsed[Math.floor(elapsed.length/2)],p95:elapsed[Math.ceil(elapsed.length*.95)-1],max:elapsed.at(-1)},usage:{inputTokens:outcomes.reduce((s,x)=>s+(x.usage?.input_tokens??0),0),outputTokens:outcomes.reduce((s,x)=>s+(x.usage?.output_tokens??0),0)},disclosure:protocol.disclosure,outcomes};
const output=path.join(folder,'retained-message-scoring-v1.json');await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({...report,outcomes:undefined,reportSha256:hash(await readFile(output))}));
