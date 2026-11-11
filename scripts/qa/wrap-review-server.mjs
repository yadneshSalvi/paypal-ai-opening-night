/** Local review harness, never a production route or a provider capability. */
import "./wrap-fixture-provider.mjs";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import next from "next";
const hostname="127.0.0.1",port=4538,origin=`http://${hostname}:${port}`,cookieName="opening-night-wrap-4538-session";
if(process.env.VERCEL||globalThis.openingNightProviderEgressGuard?.version!==2)throw new Error("Provider-disabled local review only");
const fixture=JSON.parse(readFileSync(".artifacts/wrap-4538-private/native-fixture.json","utf8"));
if(fixture.state!=="ready"||fixture.database!=="on_wrap_4538_100ba102"||fixture.origin!==origin)throw new Error("Exact ready restricted fixture required");
const app=next({dev:false,hostname,port});await app.prepare();const handler=app.getRequestHandler();
const page='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Opening Night local review</title><style>body{font:18px system-ui;background:#121217;color:#f0e8d4;margin:8vh auto;padding:24px;max-width:640px}label,input,select,button{display:block;margin:24px 0}input{box-sizing:border-box;width:100%;padding:16px}button{padding:16px 24px;font:inherit}small{line-height:1.7}</style><h1>Open the controlled wrap account.</h1><p>Restricted local review. The invoices, transfers and model responses use injected transports. No actual provider action or physical work is claimed.</p><form method="post" action="/__wrap_fixture"><label>Review persona<select name="persona"><option value="producer">Producer · complete wrap account</option><option value="priya">Priya · personal hours and paid transfer</option><option value="tom">Tom · personal hours and unclaimed transfer</option><option value="other">Other producer · separate empty account</option></select></label><label>Private review key<input name="key" type="password" required autocomplete="off"></label><button type="submit">Open controlled wrap desk</button></form><small>The review key selects only the newly prepared fictional account. Its original session expiry remains unchanged.</small></html>';
createServer(async(req,res)=>{
  try{
    // A distinct local cookie avoids disturbing protected runtimes on the same host.
    const ownCookie=req.headers.cookie?.split(";").map(value=>value.trim()).find(value=>value.startsWith(cookieName+"="));
    if(ownCookie) req.headers.cookie=[...(req.headers.cookie??"").split(";").map(value=>value.trim()).filter(value=>!value.startsWith("opening-night-ai-qa-session=")),"opening-night-ai-qa-session="+ownCookie.slice(cookieName.length+1)].join("; ");
    const originalSetHeader=res.setHeader;res.setHeader=function(name,value){if(name.toLowerCase()==="set-cookie")value=Array.isArray(value)?value.map(item=>String(item).replace(/^opening-night-ai-qa-session=/,cookieName+"=")):String(value).replace(/^opening-night-ai-qa-session=/,cookieName+"=");return originalSetHeader.call(this,name,value);};
    if(req.url?.split('?')[0]!=="/__wrap_fixture")return handler(req,res);
    res.setHeader("Cache-Control","private, no-store");res.setHeader("Referrer-Policy","same-origin");res.setHeader("X-Frame-Options","DENY");res.setHeader("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    if(req.headers.host!==`${hostname}:${port}`){res.writeHead(403);return res.end("Exact loopback origin required");}
    if(req.method==="GET"){res.setHeader("Content-Type","text/html; charset=utf-8");return res.end(page);}
    if(req.method!=="POST"||req.headers.origin!==origin){res.writeHead(403);return res.end("Same-origin form required");}
    let body="";for await(const chunk of req){body+=chunk;if(body.length>1024){res.writeHead(413);return res.end();}}
    const fields=new URLSearchParams(body),persona=fields.get("persona")??"producer",key=Buffer.from(fields.get("key")??""),expected=Buffer.from(fixture.bootstrapKey);
    if(key.length!==expected.length||!timingSafeEqual(key,expected)){res.writeHead(403);return res.end("Review key did not match");}
    if(Date.now()>=Date.parse(fixture.producer.expiresAt)){res.writeHead(410);return res.end("Original review session expired");}
    if(persona==="priya"||persona==="tom"){res.writeHead(303,{Location:"/crew/access#"+encodeURIComponent(fixture.crew[persona].token)});return res.end();}
    if(!["producer","other"].includes(persona)){res.writeHead(400);return res.end("Choose a retained review persona");}
    res.setHeader("Set-Cookie",`${cookieName}=${fixture[persona].token}; HttpOnly; SameSite=Lax; Path=/; Expires=${new Date(fixture.producer.expiresAt).toUTCString()}`);res.writeHead(303,{Location:"/wrap"});res.end();
  }catch{res.writeHead(500);res.end("Controlled review could not complete");}
}).listen(port,hostname,()=>console.log(`Restricted controlled review ready at ${origin}; providers disabled.`));
