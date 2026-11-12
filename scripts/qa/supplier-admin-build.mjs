/** Reuse the accepted offline compiler isolation and exact tracked font bytes for this successor. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { audienceFontCache } from './audience-prepare-fonts.mjs';
if(process.env.DATABASE_URL||process.env.JUDGE_SESSION_SECRET||process.env.VERCEL)throw new Error('Supplier builds require a clean non-runtime environment');
await audienceFontCache(true);
await import('./audience-build.mjs');
const result=JSON.parse(await readFile('.artifacts/audience-stage17/qualified-build.json','utf8'));
if(result.state!=='qualified')throw new Error('The exact offline supplier build did not qualify');
await mkdir('.private/supplier-admin',{recursive:true,mode:0o700});
await writeFile('.private/supplier-admin/BUILD.json',JSON.stringify({unit:'supplier-admin-stage19',...result,provenance:'Accepted compiler-isolation routine applied to this exact successor source; no runtime configuration, database or network authority'},null,2)+'\n',{flag:'wx',mode:0o600});
