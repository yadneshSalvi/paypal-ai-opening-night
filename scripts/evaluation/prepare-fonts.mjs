import {readFile,readdir,mkdir,writeFile,lstat,chmod} from "node:fs/promises";
import {resolve,basename} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {execFileSync} from "node:child_process";
const root=fileURLToPath(new URL("../../",import.meta.url)).replace(/\/$/,"");
if(process.cwd()!==root||execFileSync("git",["-C",root,"rev-parse","--show-toplevel"],{cwd:root,encoding:"utf8"}).trim()!==root)throw new Error("Use the isolated evaluation checkout");
const [source]=process.argv.slice(2);if(!source||!source.endsWith("/.next/static"))throw new Error("Supply the explicitly approved read-only static font cache");
const output=resolve(root,".private/evaluation-font-cache-v2");await mkdir(output,{recursive:false,mode:0o700});
const selected=new Map();const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
for(const filename of await readdir(resolve(source,"chunks"))){
  if(!filename.endsWith(".css"))continue;const cssFile=resolve(source,"chunks",filename);if(!(await lstat(cssFile)).isFile())throw new Error("Font provenance requires regular CSS files");
  const bytes=await readFile(cssFile),css=bytes.toString();
  for(const match of css.matchAll(/@font-face\s*\{([^}]+)\}/g)){
    const body=match[1],family=/font-family\s*:\s*([^;]+)/i.exec(body)?.[1]??"";
    const name=/jetbrains/i.test(family)?"JetBrains Mono":/oswald/i.test(family)?"Oswald":/inter/i.test(family)?"Inter":null;
    if(!name||/fallback/i.test(family)||!/font-style\s*:\s*normal/i.test(body)||!/unicode-range\s*:\s*(?:U\+0{1,4}-(?:00)?FF|U\+\?\?)/i.test(body))continue;
    const url=/url\(["']?([^)'"\s]+)["']?\)/.exec(body)?.[1];if(!url||!url.endsWith(".woff2"))continue;
    const font=basename(url);if(!/^[A-Za-z0-9_.-]+\.woff2$/.test(font))throw new Error("Font reference escaped the approved media directory");
    const weight=/font-weight\s*:\s*([^;]+)/.exec(body)?.[1]??"";const unicode=/unicode-range\s*:\s*([^;]+)/.exec(body)?.[1]??"";
    const row={family:name,font,weight,unicode,cssFile:filename,cssSha256:hash(bytes)};
    if(selected.has(name)&&selected.get(name).font!==font)throw new Error("Ambiguous accepted font;select a single exact face");selected.set(name,row);
  }
}
if(selected.size!==3)throw new Error(`Expected exactly three accepted Latin variable-font faces;found ${selected.size}`);
const records=[];const cssByFamily={};
const publicFonts=resolve(root,"public/evaluation/fonts");await mkdir(publicFonts,{recursive:true});const declaredFonts=JSON.parse(await readFile(resolve(publicFonts,"manifest.json"),"utf8")).faces;
for(const row of selected.values()){
  const origin=resolve(source,"media",row.font),target=resolve(output,row.font);if(!(await lstat(origin)).isFile())throw new Error("Font provenance cannot follow symlinks");
  execFileSync("/bin/cp",["-c",origin,target],{cwd:root});await chmod(target,0o600);
  const [before,after]=await Promise.all([readFile(origin),readFile(target)]);if(hash(before)!==hash(after)||(await lstat(target)).nlink!==1)throw new Error("Font COW copy failed byte/inode qualification");
  const publicFile=resolve(publicFonts,row.font);try{const existing=await readFile(publicFile);if(hash(existing)!==hash(after))throw new Error("Existing public font differs");}catch(error){if(error.code!=="ENOENT")throw error;execFileSync("/bin/cp",["-c",target,publicFile],{cwd:root});await chmod(publicFile,0o444);}
  if(!declaredFonts.some(face=>face.family===row.family&&face.sha256===hash(after)&&face.bytes===after.length))throw new Error("Font bytes differ from the qualified public font manifest");
  records.push({...row,bytes:after.length,sha256:hash(after),copy:"APFS COW;independent inode,no hard link"});
  cssByFamily[row.family]=`/* latin */\n@font-face{font-family:'${row.family}';font-style:normal;font-weight:${row.weight};font-display:swap;src:url(/evaluation/fonts/${row.font}) format('woff2');unicode-range:${row.unicode};}`;
}
const require=createRequire(import.meta.url),{getFontAxes}=require(resolve(root,"node_modules/next/dist/compiled/@next/font/dist/google/get-font-axes.js")),{getGoogleFontsUrl}=require(resolve(root,"node_modules/next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js"));
const responses=Object.fromEntries(Object.entries(cssByFamily).map(([family,css])=>[getGoogleFontsUrl(family,getFontAxes(family,["variable"],["normal"]),"swap"),css]));
const mock=`module.exports=${JSON.stringify(responses)};\n`;
await writeFile(resolve(output,"responses.cjs"),mock,{flag:"wx",mode:0o600});
await writeFile(resolve(output,"responses-turbopack.cjs"),mock,{flag:"wx",mode:0o600});
await writeFile(resolve(output,"provenance.json"),JSON.stringify({schemaVersion:1,source:"Explicitly approved accepted N1 compiled CSS/font cache;read-only",externalRequests:0,records},null,2)+"\n",{flag:"wx",mode:0o600});
console.log(JSON.stringify({faces:records.map(({family,bytes,sha256})=>({family,bytes,sha256})),externalRequests:0}));
