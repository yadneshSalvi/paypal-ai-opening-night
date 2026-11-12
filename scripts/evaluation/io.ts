import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, lstat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { ArtifactLink, EvaluationCorpus } from "../../src/domain/evaluation/contracts";
export const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function assertWorkspace() {
  if (resolve(process.cwd()) !== ROOT || execFileSync("git", ["-C", ROOT, "rev-parse", "--show-toplevel"], { cwd: ROOT, encoding: "utf8" }).trim() !== ROOT) throw new Error("Use the exact isolated evaluation checkout as the working directory");
}
/** Evaluation commits add the harness without changing the declared application's source version. */
export function applicationSourceBinding(baseCommit:string){
  if(!/^[a-f0-9]{40}$/.test(baseCommit))throw new Error("Application source binding requires a full commit identity");
  const paths=["src","public","package.json","package-lock.json","next.config.ts","tsconfig.json","next-env.d.ts","vendor"];
  const changed=execFileSync("git",["-C",ROOT,"diff","--no-ext-diff","--no-textconv","--name-only",baseCommit,"--",...paths],{cwd:ROOT,encoding:"utf8"}).trim().split("\n").filter(Boolean);
  const untracked=execFileSync("git",["-C",ROOT,"ls-files","--others","--exclude-standard","--",...paths],{cwd:ROOT,encoding:"utf8"}).trim().split("\n").filter(Boolean);
  const owned=/^(?:src\/domain\/evaluation\/|src\/components\/evaluation\/|src\/app\/evaluation\/|public\/evaluation\/)/;
  const applicationChanges=[...new Set([...changed,...untracked])].filter(path=>!owned.test(path)).sort();
  return {applicationBaseCommit:baseCommit,applicationBaseMatched:applicationChanges.length===0,applicationChanges,checkoutCommit:execFileSync("git",["-C",ROOT,"rev-parse","HEAD"],{cwd:ROOT,encoding:"utf8"}).trim(),checkoutDirty:Boolean(execFileSync("git",["-C",ROOT,"status","--porcelain"],{cwd:ROOT,encoding:"utf8"}).trim())};
}
export async function frozenCorpus() {
  const bytes = await readFile(resolve(ROOT,"src/domain/evaluation/corpus-v3.json"));
  const freeze = JSON.parse(await readFile(resolve(ROOT,"docs/evaluation/corpus-freeze-v3.json"),"utf8")) as { sha256: string; sourceCommit: string; frozenAt: string };
  if (sha256(bytes) !== freeze.sha256) throw new Error("Frozen corpus bytes changed;execution refused");
  const corpus = JSON.parse(bytes.toString("utf8")) as EvaluationCorpus;
  if (corpus.schemaVersion !== 1 || corpus.cases.length !== 66 || new Set(corpus.cases.map(item => item.id)).size !== 66 || corpus.sourceCommit !== freeze.sourceCommit || corpus.frozenAt !== freeze.frozenAt) throw new Error("Corpus contract is inconsistent");
  return { bytes, corpus, freeze };
}
export function assertPublicData(bytes: string) {
  if (/(?:\/Users\/|\/home\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bAIza[A-Za-z0-9_-]{25,})/.test(bytes)) throw new Error("Artifact privacy boundary rejected private path or credential-shaped content");
  if (process.env.BRYNTUM_LICENSE_KEY && bytes.includes(process.env.BRYNTUM_LICENSE_KEY)) throw new Error("Artifact privacy boundary rejected engine configuration");
}
/** Exclusive publication. A later run cannot replace a prior result or its first failure. */
export async function writeArtifact(directory: string, path: string, value: unknown, label: string): Promise<ArtifactLink> {
  if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.split("/").some(part => part === ".." || part.startsWith(".")) || path.startsWith("/")) throw new Error("Artifact path is outside the controlled manifest");
  const target = resolve(directory,path);
  if (!target.startsWith(`${resolve(directory)}/`)) throw new Error("Artifact path escaped its run");
  const bytes = typeof value === "string" ? value : `${JSON.stringify(value,null,2)}\n`;
  assertPublicData(bytes);
  await mkdir(resolve(target,".."),{recursive:true,mode:0o700});
  await writeFile(target,bytes,{flag:"wx",mode:0o600});
  return { path, sha256:sha256(bytes),bytes:Buffer.byteLength(bytes),label };
}
async function walk(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const full = resolve(directory,entry.name);
    if (entry.isSymbolicLink()) throw new Error("Source provenance cannot follow a symlink");
    if (entry.isDirectory()) paths.push(...await walk(full));
    else if (entry.isFile() && /\.(?:ts|tsx|json|mjs|cjs|js|mts|cts)$/.test(entry.name)) paths.push(full);
  }
  return paths;
}
export async function sourceManifest() {
  const {corpus}=await frozenCorpus(),binding=applicationSourceBinding(corpus.sourceCommit);
  const paths = [...await walk(resolve(ROOT,"src/domain")), ...["io.ts","run.ts","worker.ts","isolate.mjs"].map(path=>resolve(ROOT,"scripts/evaluation",path)), ...["src/server/engine.ts","src/server/tour/engine.ts","src/server/env.ts","src/server/database-connections.ts","package.json","package-lock.json"].map(path=>resolve(ROOT,path)), ...await walk(resolve(ROOT,"node_modules/@bryntum/gantt-node-enterprise")), ...await walk(resolve(ROOT,"node_modules/@js-temporal/polyfill")), ...await walk(resolve(ROOT,"node_modules/tsx/dist")), ...await walk(resolve(ROOT,"node_modules/dotenv/lib")), ...await walk(resolve(ROOT,"node_modules/zod"))].sort();
  const files = [];
  for (const path of paths) { if (!(await lstat(path)).isFile()) throw new Error("Source provenance requires regular files"); const bytes = await readFile(path); files.push({ path: relative(ROOT,path),bytes:bytes.length,sha256:sha256(bytes) }); }
  return { schemaVersion:1,sourceCommit:binding.checkoutCommit,...binding,scope:"Application base is checked separately from the evaluator checkout. Exact evaluator/domain/installed dependency bytes are hashed;no environment,license value,database or prior evidence included",node:{version:process.version,sha256:sha256(await readFile(process.execPath))},files };
}
