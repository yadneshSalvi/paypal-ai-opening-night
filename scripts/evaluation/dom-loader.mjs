import { readFile } from "node:fs/promises";
const cssUrl=new URL("../../src/components/evaluation/evaluation.module.css",import.meta.url).href;
export async function load(url,context,nextLoad){
  if(url===cssUrl){const text=await readFile(new URL(url),"utf8");const names=Object.fromEntries([...text.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map(match=>[match[1],match[1]]));return{format:"module",shortCircuit:true,source:`export default ${JSON.stringify(names)}`};}
  return nextLoad(url,context);
}
