import {readFile,readdir,lstat,readlink,writeFile,realpath} from "node:fs/promises";
import {createReadStream} from "node:fs";
import {createHash} from "node:crypto";
import {resolve,relative} from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
const root=fileURLToPath(new URL("../../",import.meta.url)).replace(/\/$/,"");
if(process.cwd()!==root)throw new Error("Use the exact isolated evaluation checkout");
const git=(...args)=>execFileSync("git",["-C",root,...args],{cwd:root,encoding:"utf8"}).trim();
if(git("status","--porcelain"))throw new Error("Commit the exact qualified unit before freezing");
const commit=git("rev-parse","HEAD"),hash=value=>createHash("sha256").update(value).digest("hex");
async function file(path){const state=await lstat(path);if(!state.isFile()||state.nlink!==1)throw new Error("Freeze requires independent regular files");const digest=createHash("sha256");for await(const chunk of createReadStream(path))digest.update(chunk);return{path:relative(root,path),bytes:state.size,sha256:digest.digest("hex")};}
async function tree(path,{skipCache=false,dependencies=false}={}){const rows=[];for(const entry of await readdir(path,{withFileTypes:true})){if(skipCache&&path===resolve(root,".next")&&entry.name==="cache")continue;const full=resolve(path,entry.name);if(entry.isSymbolicLink()){const insideDependencies=(await realpath(full)).startsWith(`${root}/node_modules/`);if(!insideDependencies||!dependencies&&!(skipCache&&full.startsWith(`${root}/.next/node_modules/`)))throw new Error("Freeze cannot follow an external symlink");const target=await readlink(full);rows.push({path:relative(root,full),kind:"internal_symlink",target,sha256:hash(target)});}else if(entry.isDirectory())rows.push(...await tree(full,{skipCache,dependencies}));else if(entry.isFile())rows.push(await file(full));}return rows.sort((a,b)=>a.path.localeCompare(b.path));}
const qualified=JSON.parse(await readFile(resolve(root,".artifacts/evaluation-stage16/qualified-build.json"),"utf8"));
if(qualified.state!=="qualified"||qualified.networkOrDatabaseAttempts!==0||qualified.privateTraceHits!==0||qualified.privateByteHits!==0)throw new Error("Freeze requires a qualified guarded production build");
const prepared=JSON.parse(await readFile(resolve(root,".artifacts/evaluation-stage16/builds",qualified.id,"prepared.json"),"utf8"));
for(const expected of prepared.inputs){const actual=await file(resolve(root,expected.path));if(actual.sha256!==expected.sha256||actual.bytes!==expected.bytes)throw new Error("Compiled source input changed after the qualified build");}
const source=[];for(const path of execFileSync("git",["-C",root,"ls-files","-z"],{cwd:root,encoding:"utf8"}).split("\0").filter(Boolean).sort())source.push(await file(resolve(root,path)));
const dependencies=await tree(resolve(root,"node_modules"),{dependencies:true}),build=await tree(resolve(root,".next"),{skipCache:true});
const index=JSON.parse(await readFile(resolve(root,"public/evaluation/index.json"),"utf8"));
const result={schemaVersion:1,createdAt:new Date().toISOString(),commit,applicationBase:"96ff4cd357c6653f5bdfaaf6177f786762fc81a8",qualifiedBuild:qualified,report:index.runs[0],node:{version:process.version,sha256:(await file(process.execPath)).sha256},source:{files:source.length,sha256:hash(JSON.stringify(source))},dependencies:{files:dependencies.length,sha256:hash(JSON.stringify(dependencies))},productionBuild:{files:build.length,sha256:hash(JSON.stringify(build)),excluded:"Mutable .next/cache only"},scope:"No environment/credential contents copied;report-only4587,no database/session/provider/model capability",manifests:{source,dependencies,build}};
const path=resolve(root,".artifacts/evaluation-stage16",`freeze-${commit}.json`),text=JSON.stringify(result,null,2)+"\n";await writeFile(path,text,{flag:"wx",mode:0o600});
await writeFile(resolve(root,".artifacts/evaluation-stage16/freeze-current.json"),JSON.stringify({schemaVersion:1,commit,path:`.artifacts/evaluation-stage16/freeze-${commit}.json`,sha256:hash(text)},null,2)+"\n",{flag:"wx",mode:0o600});
console.log(JSON.stringify({commit,source:result.source,dependencies:result.dependencies,productionBuild:result.productionBuild,freezeSha256:hash(text)},null,2));
