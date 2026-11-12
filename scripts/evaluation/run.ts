import { randomUUID } from "node:crypto";
import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import type { BenchmarkObservation, CaseObservation, EvaluationReport } from "../../src/domain/evaluation/contracts";
import { FIXTURE_NOW } from "../../src/domain/evaluation/fixtures";
import { analyseCases } from "../../src/domain/evaluation/analysis";
import { ROOT, assertWorkspace, frozenCorpus, sourceManifest, applicationSourceBinding,writeArtifact, sha256, assertPublicData } from "./io";
interface Envelope { failure?: string; networkAttemptsBlocked: number; toolingIpcSuppressed?: number; suppressedDiagnostics: number; result?: { observation: CaseObservation | BenchmarkObservation; input: unknown; output?: unknown; outputs?: unknown[] } }
const deadlineMs = 90000, maxOutputBytes = 32 * 1024 * 1024;
async function work(job: string): Promise<Envelope> {
  const runtimeEnv: NodeJS.ProcessEnv = { PATH:process.env.PATH ?? "/usr/bin:/bin",TZ:"UTC",NODE_ENV:"test" };
  if (process.env.BRYNTUM_LICENSE_KEY) runtimeEnv.BRYNTUM_LICENSE_KEY = process.env.BRYNTUM_LICENSE_KEY;
  return new Promise(resolveResult => {
    const child = spawn(process.execPath,["--max-old-space-size=1024","--import",resolve(ROOT,"scripts/evaluation/isolate.mjs"),"--import","tsx",resolve(ROOT,"scripts/evaluation/worker.ts"),job],{cwd:ROOT,env:runtimeEnv,stdio:["ignore","pipe","pipe"]});
    const chunks: Buffer[] = []; let bytes = 0, stderrBytes = 0, failure = "";
    const timer = setTimeout(() => { failure = "WORKER_DEADLINE"; child.kill("SIGKILL"); },deadlineMs);
    child.stdout.on("data",(chunk:Buffer) => { bytes += chunk.length; if (bytes > maxOutputBytes) { failure = "WORKER_OUTPUT_BOUND"; child.kill("SIGKILL"); } else chunks.push(chunk); });
    child.stderr.on("data",(chunk:Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 128 * 1024) { failure = "WORKER_DIAGNOSTIC_BOUND"; child.kill("SIGKILL"); } });
    child.on("error",() => { failure = "WORKER_START_FAILED"; });
    child.on("close",code => {
      clearTimeout(timer);
      if (failure) return resolveResult({failure,networkAttemptsBlocked:0,suppressedDiagnostics:stderrBytes ? 1 : 0});
      try { const text = Buffer.concat(chunks).toString("utf8"); assertPublicData(text); const result = JSON.parse(text) as Envelope; if (code && !result.failure || typeof result.networkAttemptsBlocked !== "number") throw new Error("Worker result invalid"); resolveResult(result); }
      catch { resolveResult({failure:"WORKER_RESULT_INVALID",networkAttemptsBlocked:0,suppressedDiagnostics:stderrBytes ? 1 : 0}); }
    });
  });
}
assertWorkspace();
if (!(globalThis as typeof globalThis & { openingNightEvaluationGuard?: unknown }).openingNightEvaluationGuard) throw new Error("Import scripts/evaluation/isolate.mjs first");
const { corpus, bytes:corpusBytes, freeze } = await frozenCorpus();
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === "--case" && corpus.cases.some(item => item.id === args[1]))) throw new Error("Use no arguments for the full contract,or --case with one frozen identity");
const selected = args.length ? corpus.cases.filter(item => item.id === args[1]) : corpus.cases;
const binding=applicationSourceBinding(corpus.sourceCommit);
if(!args.length&&!binding.applicationBaseMatched)throw new Error("Shared application source changed;freeze a new corpus source binding before a full qualification. Focused --case observations may still be retained with their actual checkout attribution.");
const createdAt = new Date().toISOString(), runId = `run-${createdAt.replace(/[-:.]/g,"")}-${randomUUID().slice(0,8)}`;
const directory = resolve(ROOT,".artifacts/evaluation-stage16/runs",runId);
await mkdir(directory,{recursive:false,mode:0o700}).catch(async error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") { await mkdir(resolve(directory,".."),{recursive:true,mode:0o700}); await mkdir(directory,{mode:0o700}); } else throw error; });
const artifacts = [await writeArtifact(directory,"corpus.json",corpusBytes.toString("utf8"),"Frozen case contract")];
const manifest = await sourceManifest(), manifestLink = await writeArtifact(directory,"source-manifest.json",manifest,"Exact source and dependency hashes"); artifacts.push(manifestLink);
await writeArtifact(directory,"run-prepared.json",{schemaVersion:1,runId,createdAt,corpusSha256:freeze.sha256,sourceManifestSha256:manifestLink.sha256,caseIds:selected.map(item => item.id),fullContract:!args.length,deadlineMs,maxOutputBytes,workerHeapLimitMiB:1024,expectedOperationalCases:57,expectedSupportingCases:9},"Prepared execution bounds");
let firstNonpass = false, networkAttemptsBlocked = 0,toolingIpcSuppressed = 0;
const observations: CaseObservation[] = [], benchmarks: BenchmarkObservation[] = [];
async function retainFirst(path: string,state: string) { if (state !== "pass" && !firstNonpass) { await writeArtifact(directory,"first-nonpassing.json",{path,state,observedAt:new Date().toISOString(),policy:"Retained before continuing;never replaced by a later rerun"},"First nonpassing observation"); firstNonpass = true; } }
for (const contract of selected) {
  await appendFile(resolve(directory,"progress.ndjson"),`${JSON.stringify({job:`case:${contract.id}`,state:"started",at:new Date().toISOString()})}\n`,{mode:0o600});
  const envelope = await work(`case:${contract.id}`); networkAttemptsBlocked += envelope.networkAttemptsBlocked; toolingIpcSuppressed += envelope.toolingIpcSuppressed ?? 0;
  let observation: CaseObservation;
  if (envelope.result) observation = envelope.result.observation as CaseObservation;
  else observation = {id:contract.id,state:envelope.failure === "ENGINE_LICENSE_UNAVAILABLE" ? "unsupported" : "unknown",observedStatus:"not_observed",findings:[],measurements:{},mismatches:[envelope.failure ?? "WORKER_UNAVAILABLE"],engine:null,durationMs:0,heapDeltaBytes:0,inputDigest:sha256(JSON.stringify(contract)),outputDigest:sha256(JSON.stringify(envelope)),inputUnchanged:true,artifact:`cases/${contract.id}.json`};
  if (envelope.networkAttemptsBlocked > 0) { observation.state="fail";observation.mismatches.push("Evaluation attempted forbidden transport;the isolation guard blocked it."); }
  observations.push(observation);
  artifacts.push(await writeArtifact(directory,observation.artifact,{contract,...envelope,observation},`${contract.id} exact input and observation`));
  await retainFirst(observation.artifact,observation.state);
  await appendFile(resolve(directory,"progress.ndjson"),`${JSON.stringify({job:`case:${contract.id}`,state:observation.state,at:new Date().toISOString()})}\n`);
  console.log(`${contract.id} ${observation.state} · ${observation.observedStatus}${observation.mismatches.length ? ` · ${observation.mismatches.join(" ")}` : ""}`);
}
if (!args.length) for (const contract of corpus.stress) for (const size of contract.sizes) {
  await appendFile(resolve(directory,"progress.ndjson"),`${JSON.stringify({job:`benchmark:${contract.id}:${size}`,state:"started",at:new Date().toISOString()})}\n`);
  const envelope = await work(`benchmark:${contract.id}:${size}`); networkAttemptsBlocked += envelope.networkAttemptsBlocked; toolingIpcSuppressed += envelope.toolingIpcSuppressed ?? 0;
  const observation = envelope.result?.observation as BenchmarkObservation | undefined ?? {id:contract.id,title:contract.title,size,state:envelope.failure === "ENGINE_LICENSE_UNAVAILABLE" ? "unsupported" : "unknown",samples:[],medianMs:null,p95Ms:null,peakObservedHeapBytes:null,reason:envelope.failure ?? "Worker did not return a complete measurement",artifact:`benchmarks/${contract.id}-${size}.json`};
  if (envelope.networkAttemptsBlocked > 0) { observation.state="fail";observation.reason="Evaluation attempted forbidden transport;the isolation guard blocked it."; }
  benchmarks.push(observation);
  artifacts.push(await writeArtifact(directory,observation.artifact,{contract,size,...envelope,observation},`${contract.id} size ${size} measured repetitions`));
  await retainFirst(observation.artifact,observation.state);
  await appendFile(resolve(directory,"progress.ndjson"),`${JSON.stringify({job:`benchmark:${contract.id}:${size}`,state:observation.state,at:new Date().toISOString()})}\n`);
  console.log(`${contract.id} size ${size} ${observation.state} · median ${observation.medianMs ?? "unmeasured"} ms`);
}
const counts = {pass:0,fail:0,unknown:0,unsupported:0}; for (const item of observations) counts[item.state]++;
const runnerBytes = await readFile(resolve(ROOT,"scripts/evaluation/run.ts"));
const report: EvaluationReport = {schemaVersion:1,runId,createdAt,completedAt:new Date().toISOString(),sourceCommit:binding.applicationBaseMatched?corpus.sourceCommit:binding.checkoutCommit,checkoutCommit:binding.checkoutCommit,checkoutDirty:binding.checkoutDirty,applicationBaseMatched:binding.applicationBaseMatched,corpusSha256:freeze.sha256,corpusId:corpus.id,runnerSha256:sha256(runnerBytes),sourceManifestSha256:manifestLink.sha256,runtime:{node:process.version,platform:process.platform,architecture:process.arch,engine:"Bryntum Gantt Enterprise 8.0.0",repetitions:3,licensed:Boolean(process.env.BRYNTUM_LICENSE_KEY),networkAttemptsBlocked,toolingIpcSuppressed,fixtureClock:FIXTURE_NOW},scope:{label:"Provider-disabled controlled computation;no production authority",operationalCaseCount:selected.filter(item => ["single_show","tour"].includes(item.group)).length,supportingCaseCount:selected.filter(item => ["time","readiness"].includes(item.group)).length,productionWrites:0,providerCalls:0,modelCalls:0,databaseConnections:0,approvalsGranted:0},counts,analysis:analyseCases(corpus,observations),cases:observations,benchmarks,pending:corpus.pending,limitations:["The operational pass count includes correctly rejected unsafe proposals;it is not a feasible-plan count.","Product engine adapters commit temporal graphs only. Domain resource findings and the evaluation-owned native resource/assignment benchmark are separate evidence.","A synthetic reviewed source or computational person identity is not a real supplier fact,admission,approval or completed physical task.","Concurrent host activity is not isolated;these are observations on a shared local machine,not dedicated performance guarantees.","Only three repetitions per benchmark. p95 is the largest of three observed samples,not a population estimate. First sample includes cold module loading.","Heap is observed immediately before and after each repetition;transient peak allocation is not instrumented. Runtime and machine differences limit comparisons.","Useful-batch time is an upper bound measured when generateCandidates returns;the runner does not instrument the first individual useful proposal.","The declared corpus is purposefully adversarial and not a statistical sample. There are no confidence intervals or claims about unseen productions.","Model,human,provider,live reconciliation and native-browser qualifications remain separately pending.","This source version is independent of the retained-rental and fresh late-day quote lifecycle units."],artifacts};
const reportLink = await writeArtifact(directory,"report.json",report,"Complete immutable evaluation report");
await writeFile(resolve(directory,"COMPLETED.json"),`${JSON.stringify({report:reportLink,completedAt:report.completedAt},null,2)}\n`,{flag:"wx",mode:0o600});
console.log(`Retained report: .artifacts/evaluation-stage16/runs/${runId}/report.json`);
console.log(`Cases ${counts.pass} pass / ${counts.fail} fail / ${counts.unknown} unknown / ${counts.unsupported} unsupported;benchmarks ${benchmarks.filter(item=>item.state==="pass").length}/${benchmarks.length} pass.`);
if (counts.fail || counts.unknown || counts.unsupported || benchmarks.some(item => item.state!=="pass")) process.exitCode = 1;
