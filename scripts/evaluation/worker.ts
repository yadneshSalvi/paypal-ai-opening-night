import { frozenCorpus, sha256 } from "./io";
import { executeCase } from "../../src/domain/evaluation/cases";
import { executeBenchmark } from "../../src/domain/evaluation/benchmarks";
const guard = (globalThis as typeof globalThis & { openingNightEvaluationGuard?: { state: {networkAttemptsBlocked:number;toolingIpcSuppressed:number} } }).openingNightEvaluationGuard;
if (!guard) throw new Error("Import scripts/evaluation/isolate.mjs before the worker");
let suppressedDiagnostics = 0;
// Vendor diagnostics must never echo runtime configuration. Results use a single bounded JSON channel.
for (const key of ["log","warn","error","info","debug"] as const) console[key] = () => { suppressedDiagnostics++; };
const job = process.argv[2] ?? "", licensed = Boolean(process.env.BRYNTUM_LICENSE_KEY);
try {
  const { corpus } = await frozenCorpus();
  let result: unknown;
  if (/^case:[STCR]\d{2}$/.test(job)) {
    const contract = corpus.cases.find(item => item.id === job.slice(5));
    if (!contract) throw new Error("Unknown frozen case");
    result = await executeCase(contract,{engine:licensed});
  } else if (/^benchmark:B0[1-4]:\d{1,3}$/.test(job)) {
    const [,id,sizeText] = job.split(":"), size = Number(sizeText);
    if (!corpus.stress.some(item => item.id === id && item.sizes.includes(size))) throw new Error("Unknown frozen benchmark size");
    if (!licensed && id !== "B04") throw new Error("ENGINE_LICENSE_UNAVAILABLE");
    result = await executeBenchmark(id!,size);
  } else throw new Error("Unknown evaluation job");
  const envelope = { schemaVersion:1,job,licensed,suppressedDiagnostics,networkAttemptsBlocked:guard.state.networkAttemptsBlocked,toolingIpcSuppressed:guard.state.toolingIpcSuppressed,result };
  process.stdout.write(JSON.stringify(envelope));
} catch (error) {
  const code = error instanceof Error && error.message === "ENGINE_LICENSE_UNAVAILABLE" ? "ENGINE_LICENSE_UNAVAILABLE" : "WORKER_UNAVAILABLE";
  process.stdout.write(JSON.stringify({schemaVersion:1,job,failure:code,errorFingerprint:sha256(error instanceof Error ? error.name : typeof error),suppressedDiagnostics,networkAttemptsBlocked:guard.state.networkAttemptsBlocked,toolingIpcSuppressed:guard.state.toolingIpcSuppressed}));
  process.exitCode = 2;
}
