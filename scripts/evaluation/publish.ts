import { readFile, mkdir, copyFile, chmod, rename, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import type { EvidenceIndex,EvaluationReport,PublishedRun,ArtifactLink } from "../../src/domain/evaluation/contracts";
import { ROOT,assertWorkspace,sha256,assertPublicData,writeArtifact } from "./io";
assertWorkspace();
const ids=process.argv.slice(2);
if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!/^run-\d{8}T\d{9}Z-[a-f0-9]{8}$/.test(id))) throw new Error("Provide exact retained run identities,newest accepted run first");
const runRoot=resolve(ROOT,".artifacts/evaluation-stage16/runs"),publicRoot=resolve(ROOT,"public/evaluation");
await mkdir(publicRoot,{recursive:true});
const priorIndex=await readFile(resolve(publicRoot,"index.json")).catch(error=>{if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;});
if(priorIndex){const prior=JSON.parse(priorIndex.toString()) as EvidenceIndex;if(prior.runs.some(run=>!ids.includes(run.runId)))throw new Error("A new publication must preserve every previously visible execution");}
const publications:PublishedRun[]=[];
for(const id of ids) {
  const directory=resolve(runRoot,id),prepared=JSON.parse(await readFile(resolve(directory,"run-prepared.json"),"utf8"));
  if(!prepared.fullContract)throw new Error("Partial focused runs are retained privately;publish a full declared contract");
  const completion=JSON.parse(await readFile(resolve(directory,"COMPLETED.json"),"utf8")) as {report:ArtifactLink};
  const reportBytes=await readFile(resolve(directory,"report.json"));
  if(sha256(reportBytes)!==completion.report.sha256)throw new Error("Completion receipt/report hash mismatch");
  const report=JSON.parse(reportBytes.toString()) as EvaluationReport;
  if(report.cases.length!==66||report.runId!==id)throw new Error("Run identity or case population mismatch");
  const links=[...report.artifacts,completion.report];
  for(const link of links) {
    if(!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.json$/.test(link.path)||link.path.includes(".."))throw new Error("Unsafe artifact manifest path");
    const path=resolve(directory,link.path);
    if(!(await lstat(path)).isFile())throw new Error("Publication requires regular artifact files");
    const bytes=await readFile(path);assertPublicData(bytes.toString());
    if(sha256(bytes)!==link.sha256||bytes.length!==link.bytes)throw new Error("Artifact changed since execution");
  }
  const target=resolve(publicRoot,id),staged=resolve(ROOT,".artifacts/evaluation-stage16",`publication-${id}`);
  const existing=await lstat(target).catch(error=>{if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;});
  if(existing){
    if(!existing.isDirectory()||existing.isSymbolicLink())throw new Error("Existing publication is not an owned regular directory");
    for(const link of links){const path=resolve(target,link.path);if(!(await lstat(path)).isFile()||sha256(await readFile(path))!==link.sha256)throw new Error("A previously published artifact changed;promotion refused");}
  }else{
    await mkdir(staged,{recursive:false,mode:0o700});
    for(const link of links) {
      const destination=resolve(staged,link.path);await mkdir(resolve(destination,".."),{recursive:true});
      // Copy-on-write where available;never create hard links to retained execution evidence.
      await copyFile(resolve(directory,link.path),destination,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);
      await chmod(destination,0o444);
    }
    await rename(staged,target);
  }
  const reportLink={...completion.report,path:`/evaluation/${id}/report.json`},corpus=report.artifacts.find(link=>link.path==="corpus.json")!,source=report.artifacts.find(link=>link.path==="source-manifest.json")!;
  const allPassed=report.counts.pass===66&&report.benchmarks.every(item=>item.state==="pass");
  publications.push({runId:id,report:reportLink,corpus:{...corpus,path:`/evaluation/${id}/corpus.json`},sourceManifest:{...source,path:`/evaluation/${id}/source-manifest.json`},completedAt:report.completedAt,corpusId:report.corpusId,counts:report.counts,benchmarkPass:report.benchmarks.filter(item=>item.state==="pass").length,benchmarkTotal:report.benchmarks.length,note:publications.length===0?(allPassed?"Current qualified controlled computation; pending real-world qualifications remain explicit.":"Current publication contains unresolved observations; no result has been reclassified."):allPassed?"Earlier successful computational run retained with its original source and evaluator hashes.":report.corpusId.endsWith("v1")?"First failed run retained. Guard counted optional tsx IPC as egress; S22 did not construct the declared cycle. No result was reclassified.":"Intermediate failed run retained. Native assignment construction mutated caller-owned input; the evaluation adapter was corrected to clone it. No expectation changed."});
}
const index:EvidenceIndex={schemaVersion:1,title:"Opening Night · The rehearsal ledger",currentRunId:publications[0]!.runId,runs:publications};
if(priorIndex){const path=`publication-${sha256(priorIndex)}.json`;const existing=await readFile(resolve(publicRoot,path)).catch(()=>null);if(existing&&sha256(existing)!==sha256(priorIndex))throw new Error("Publication history receipt changed");if(!existing)await writeArtifact(publicRoot,path,priorIndex.toString(),"Original publication pointer retained");}
const text=`${JSON.stringify(index,null,2)}\n`,generation=`publication-${sha256(text)}.json`;
const generationLink=await writeArtifact(publicRoot,generation,text,"Immutable publication generation");await chmod(resolve(publicRoot,generation),0o444);
const stagedIndex=resolve(ROOT,".artifacts/evaluation-stage16",`index-${sha256(text)}.json`);await copyFile(resolve(publicRoot,generation),stagedIndex,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);await rename(stagedIndex,resolve(publicRoot,"index.json"));await chmod(resolve(publicRoot,"index.json"),0o444);
const indexLink={...generationLink,path:"index.json"};
console.log(`Published ${publications.length} immutable controlled reports;index SHA-256 ${indexLink.sha256}`);
