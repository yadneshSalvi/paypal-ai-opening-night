import type { ArtifactLink, EvaluationCorpus, EvaluationReport, PublishedRun } from "@/domain/evaluation/contracts";
export class EvidenceReadError extends Error {
  constructor(public readonly code:"FETCH_FAILED"|"HASH_MISMATCH"|"SIZE_MISMATCH"|"INVALID_REPORT"|"TOO_LARGE"|"CRYPTO_UNAVAILABLE",message:string){super(message);this.name="EvidenceReadError";}
}
export async function verifiedJson<T>(artifact:ArtifactLink,signal:AbortSignal):Promise<T>{
  if(!/^\/evaluation\/run-\d{8}T\d{9}Z-[a-f0-9]{8}\/(?:report|corpus)\.json$/.test(artifact.path)||!/^[a-f0-9]{64}$/.test(artifact.sha256)||!Number.isSafeInteger(artifact.bytes)||artifact.bytes<1||artifact.bytes>2*1024*1024)throw new EvidenceReadError("INVALID_REPORT","The pinned evidence manifest is invalid.");
  const response=await fetch(artifact.path,{signal,cache:"no-store",credentials:"omit",redirect:"error"});
  if(!response.ok)throw new EvidenceReadError("FETCH_FAILED",`The saved evidence could not be read (HTTP ${response.status}).`);
  const reader=response.body?.getReader();let chunks:Uint8Array[]=[];let count=0;
  if(reader){try{while(true){const next=await reader.read();if(next.done)break;count+=next.value.byteLength;if(count>artifact.bytes||count>2*1024*1024){await reader.cancel();throw new EvidenceReadError("TOO_LARGE","The saved evidence exceeds its pinned size.");}chunks.push(next.value);}}finally{reader.releaseLock();}}
  else{const bytes=new Uint8Array(await response.arrayBuffer());chunks=[bytes];count=bytes.byteLength;}
  if(count!==artifact.bytes)throw new EvidenceReadError("SIZE_MISMATCH","The saved evidence has a different size from its publication receipt.");
  const combined=new Uint8Array(count);let offset=0;for(const chunk of chunks){combined.set(chunk,offset);offset+=chunk.length;}
  if(!globalThis.crypto?.subtle)throw new EvidenceReadError("CRYPTO_UNAVAILABLE","This browser cannot verify the saved evidence. Use the linked files and hashes to inspect it independently.");
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",combined))).map(value=>value.toString(16).padStart(2,"0")).join("");
  if(hash!==artifact.sha256)throw new EvidenceReadError("HASH_MISMATCH","The saved evidence does not match its pinned SHA-256. It has not been accepted for display.");
  try{return JSON.parse(new TextDecoder().decode(combined)) as T;}catch{throw new EvidenceReadError("INVALID_REPORT","The verified file is not readable JSON.");}
}
export function validatePair(report:EvaluationReport,corpus:EvaluationCorpus,run:PublishedRun){
  if(report.schemaVersion!==1||corpus.schemaVersion!==1||report.runId!==run.runId||report.corpusId!==corpus.id||report.corpusSha256!==run.corpus.sha256||report.sourceManifestSha256!==run.sourceManifest.sha256||report.sourceCommit!==corpus.sourceCommit||!Array.isArray(report.cases)||!Array.isArray(corpus.cases)||report.cases.length!==corpus.cases.length||new Set(report.cases.map(item=>item.id)).size!==report.cases.length||report.cases.some(item=>!corpus.cases.some(contract=>contract.id===item.id)||!["pass","fail","unknown","unsupported"].includes(item.state))||!Array.isArray(report.benchmarks)||!Array.isArray(report.pending))throw new EvidenceReadError("INVALID_REPORT","The saved report and its frozen case contract do not match.");
  const counts={pass:0,fail:0,unknown:0,unsupported:0};for(const item of report.cases)counts[item.state]++;
  if(Object.entries(counts).some(([name,value])=>report.counts[name as keyof typeof counts]!==value))throw new EvidenceReadError("INVALID_REPORT","The saved summary differs from its individual case observations.");
}
