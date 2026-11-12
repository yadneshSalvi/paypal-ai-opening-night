/** Mounted recovery/state checks. No model, database, audio or native-widget rendering. */
import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { ConsoleData } from '../src/domain/contracts';
import type { IntelligenceConversation, IntelligenceRunView, IntelligenceWorkspace } from '../src/domain/intelligence';
import { allReadiness } from '../src/domain/readiness';
import { crewProductionOverview } from '../src/server/crew/projection';
import { base } from './helpers';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:4596/intelligence', pretendToBeVisual: true });
for (const name of ['window','self','document','HTMLElement','HTMLSelectElement','Element','Node','Event','MouseEvent','KeyboardEvent','location','history','localStorage','sessionStorage','MutationObserver'] as const) Object.defineProperty(globalThis,name,{configurable:true,value:dom.window[name]});
Object.defineProperty(globalThis,'getComputedStyle',{configurable:true,value:dom.window.getComputedStyle.bind(dom.window)});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{configurable:true,value:true});
const { createRoot } = await import('react-dom/client');
const { PlanningDesk } = await import('../src/components/intelligence/planning-desk');
const originalFetch = globalThis.fetch; let root: Root | null = null;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=null;document.body.replaceChildren();sessionStorage.clear();globalThis.fetch=originalFetch;});
after(()=>dom.window.close());
function fixture() {
  const {show,actor}=base(),now=new Date().toISOString();
  const data:ConsoleData={show,currentActor:actor,serverAt:now,controlledQa:true,controlledPlanningQa:true,readiness:allReadiness(show),crew:crewProductionOverview(show)};
  const id=randomUUID(),requestId=randomUUID();
  const run:IntelligenceRunView={id:randomUUID(),requestId,conversationId:id,sequence:1,state:'completed',revision:show.revision,sourceDigest:'a'.repeat(64),createdAt:now,result:{choices:[{finish_reason:'stop',message:{role:'assistant',content:'Original source-linked controlled answer.'}}]},model:'gpt-6.1-sol',reasoning:'max',provenance:'controlled_fixture',message:'Original saved response.',retryAfterMs:2500};
  const conversation:IntelligenceConversation={id,runs:[run],prompts:[{runId:run.id,text:'Original question.'}],receipts:[],plan:null,pending:false,canContinue:true,continuationMessage:null};
  const workspace:IntelligenceWorkspace={conversations:[{id,createdAt:now}],proposals:[],providerAvailable:true,providerMode:'controlled_fixture',sessionExpiresAt:'2030-01-01T00:00:00.123456Z',sessionAccessId:'b'.repeat(64)};
  return {data,conversation,workspace,run,key:`opening-night-planning:${show.tenantId}:${id}`,draftKey:`opening-night-draft-conversation:${show.tenantId}`};
}
async function mount(value:ReturnType<typeof fixture>, missingOriginal=false, handler?: (path:string, init:RequestInit|undefined)=>Promise<Response|undefined>) {
  const calls:{path:string;method:string}[]=[];
  globalThis.fetch=async(input,init)=>{
    const path=String(input),method=init?.method??'GET'; calls.push({path,method});if(!handler)assert.equal(method,'GET');
    assert.equal(new Headers(init?.headers).get('x-opening-night-production'),value.data.show.tenantId);
    const custom=await handler?.(path,init);if(custom)return custom;
    if(path==='/api/intelligence')return Response.json(value.workspace);
    if(path===`/api/intelligence?conversationId=${value.conversation.id}`)return Response.json(value.conversation);
    if(path.startsWith('/api/intelligence?requestId=')&&missingOriginal)return Response.json({code:'PLANNING_NOT_FOUND',error:'No original request found.'},{status:404});
    throw new Error(`Unexpected mounted request ${path}`);
  };
  const container=document.createElement('div');document.body.append(container);root=createRoot(container);
  await act(async()=>root!.render(<PlanningDesk data={value.data} onData={()=>undefined} canvas={{tasks:value.data.show.tasks,dependencies:value.data.show.dependencies,resources:value.data.show.resources,licenseKey:''}}/>));
  return {container,calls};
}
const button=(label:string)=>{const value=[...document.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent?.trim()===label);assert.ok(value,label);return value;};
async function click(target:HTMLElement){await act(async()=>{target.focus();target.click();});}

test('historical conversation remains readable and only an explicit separate action opens a new draft',async()=>{
  const value=fixture();value.conversation.canContinue=false;value.conversation.continuationMessage='Historical conversation. Original evidence remains readable.';sessionStorage.setItem(value.draftKey,value.conversation.id);
  const {container,calls}=await mount(value);
  assert.match(container.textContent!,/Historical conversation/);assert.match(container.textContent!,/Original source-linked controlled answer/);
  assert.equal((globalThis as any).openingNightMountedPlanningOptions,null);
  await click(button('Start a separate conversation'));
  assert.notEqual(sessionStorage.getItem(value.draftKey),value.conversation.id);
  assert.equal((globalThis as any).openingNightMountedPlanningOptions.initial,null);
  assert.equal((globalThis as any).openingNightMountedPlanningOptions.sessionAccessId,value.workspace.sessionAccessId);
  assert.equal((globalThis as any).openingNightMountedPlanningOptions.sessionExpiresAt,value.workspace.sessionExpiresAt);
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.method==='GET'));
  const select=document.querySelector<HTMLSelectElement>('select[aria-label="Saved planning conversation"]')!;
  await act(async()=>{select.value=value.conversation.id;select.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.match(container.textContent!,/Original source-linked controlled answer/);assert.equal(value.conversation.runs.length,1);
});
test('restoring completed history cannot erase a different unresolved original request',async()=>{
  const value=fixture(),unknown=randomUUID();sessionStorage.setItem(value.key,unknown);sessionStorage.setItem(value.draftKey,value.conversation.id);
  const {container,calls}=await mount(value,true);
  assert.equal(sessionStorage.getItem(value.key),unknown);assert.equal(button('Start a separate conversation').disabled,true);
  await click(button('Read original request'));
  assert.match(container.textContent!,/No original result was found.*instruction remains held/);
  assert.equal(sessionStorage.getItem(value.key),unknown);assert.equal(calls.filter(call=>call.path===`/api/intelligence?requestId=${unknown}`).length,1);assert.equal(calls.filter(call=>call.method==='POST').length,0);
});
test('only the exact terminal request clears its local hold; other production journals remain intact',async()=>{
  const value=fixture(),otherKey=`opening-night-planning:${randomUUID()}:${randomUUID()}`,otherId=randomUUID();sessionStorage.setItem(value.key,value.run.requestId);sessionStorage.setItem(otherKey,otherId);
  await mount(value);assert.equal(sessionStorage.getItem(value.key),null);assert.equal(sessionStorage.getItem(otherKey),otherId);
  assert.equal(document.querySelector('button')?.hasAttribute('autofocus'),false);assert.equal(button('Start a separate conversation').disabled,false);
});
test('an unknown original provider run stays held and never presents a replacement create action',async()=>{
  const value=fixture();value.run.state='indeterminate';value.run.result=null;value.conversation.pending=true;value.conversation.canContinue=false;value.conversation.continuationMessage='Original request held; no replacement was sent.';sessionStorage.setItem(value.key,value.run.requestId);
  const {container,calls}=await mount(value,true);assert.match(container.textContent!,/Original request held/);assert.equal(button('Start a separate conversation').disabled,true);
  await click(button('Read original request'));assert.equal(sessionStorage.getItem(value.key),value.run.requestId);assert.ok(calls.every(call=>call.method==='GET'));
});

test('an explicit missing-result review retries the exact original instruction after another read',async()=>{
  const value=fixture(),requestId=randomUUID(),command={requestId,conversationId:value.conversation.id,afterRunId:value.run.id,prompt:'Retain this exact source question.'};
  const saved={version:1,tenantId:value.data.show.tenantId,sessionExpiresAt:value.workspace.sessionExpiresAt,sessionAccessId:value.workspace.sessionAccessId,command};
  sessionStorage.setItem(value.key,requestId);sessionStorage.setItem(`${value.key}:instruction`,JSON.stringify(saved));
  let postCount=0;
  const {container,calls}=await mount(value,true,async(path,init)=>{
    if(path==='/api/intelligence'&&init?.method==='POST'){
      postCount++;assert.equal(init.body,JSON.stringify(command));assert.equal(new Headers(init.headers).get('x-opening-night-planning-expiry'),saved.sessionExpiresAt);assert.equal(new Headers(init.headers).get('x-opening-night-planning-access'),saved.sessionAccessId);
      const run={...value.run,id:randomUUID(),requestId,sequence:2};value.conversation.runs.push(run);return Response.json(run);
    }
  });
  assert.equal(postCount,0);await click(button('Read original request'));
  assert.match(container.textContent!,/Retain this exact source question/);assert.equal(postCount,0);
  await click(button('Retry this exact instruction'));
  assert.equal(postCount,1);assert.equal(calls.filter(call=>call.path===`/api/intelligence?requestId=${requestId}`).length,2);
  assert.equal(sessionStorage.getItem(value.key),null);assert.equal(sessionStorage.getItem(`${value.key}:instruction`),null);assert.equal(button('Start a separate conversation').disabled,false);
});
test('a replacement session detected after the missing-result preview keeps the original instruction and sends no POST',async()=>{
  const value=fixture(),requestId=randomUUID(),command={requestId,conversationId:value.conversation.id,afterRunId:value.run.id,prompt:'Original access only.'};
  const saved={version:1,tenantId:value.data.show.tenantId,sessionExpiresAt:value.workspace.sessionExpiresAt,sessionAccessId:value.workspace.sessionAccessId,command},bytes=JSON.stringify(saved);
  sessionStorage.setItem(value.key,requestId);sessionStorage.setItem(`${value.key}:instruction`,bytes);
  const {container,calls}=await mount(value,true);await click(button('Read original request'));
  value.workspace.sessionAccessId='c'.repeat(64);
  await click(button('Retry this exact instruction'));
  assert.match(container.textContent!,/different or ended original access/);assert.equal(calls.filter(call=>call.method==='POST').length,0);assert.equal(sessionStorage.getItem(`${value.key}:instruction`),bytes);assert.equal(sessionStorage.getItem(value.key),requestId);
});
