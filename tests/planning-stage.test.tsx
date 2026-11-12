/** Mounted illustrative geometry only. Actual viewport/print acceptance is a separate native gate. */
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { dom } from './presentation-dom';
import { presentationFixture } from './presentation-fixture';
import { digest } from '../src/domain/hash';
import { ProductionSelectionProvider, useLinkedSelection } from '../src/components/presentation/selection';
import { StageMap } from '../src/components/stage-map';
const {createRoot}=await import('react-dom/client');
let root:Root|null=null,container:HTMLDivElement;let transportAttempts=0;const originalFetch=globalThis.fetch;
function Selection(){const linked=useLinkedSelection();return <output data-selected>{linked?.detail?.title??'No selection'}</output>;}
function View({data}:{data:ReturnType<typeof presentationFixture>}){return <ProductionSelectionProvider data={data}><StageMap data={data}/><Selection/></ProductionSelectionProvider>;}
async function mount(data= presentationFixture()){container=document.createElement('div');document.body.append(container);root=createRoot(container);globalThis.fetch=async()=>{transportAttempts++;throw Error('No stage action may dispatch');};await act(async()=>root!.render(<View data={data}/>));return data;}
const button=(label:string)=>{const found=[...container.querySelectorAll<HTMLButtonElement>('button')].find(row=>row.textContent?.trim()===label);assert.ok(found,label);return found;};
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=null;document.body.replaceChildren();sessionStorage.clear();globalThis.fetch=originalFetch;assert.equal(transportAttempts,0);});
after(()=>dom.window.close());
test('both illustrative perspectives preserve the same canonical selection and immutable production',async()=>{const data=await mount(),before=digest(data);const node=container.querySelector<HTMLButtonElement>('.presentation-stage-selectors button')!;await act(async()=>node.click());const selected=container.querySelector('[data-selected]')!.textContent;assert.notEqual(selected,'No selection');await act(async()=>button('Spatial illustration').click());assert.equal(button('Spatial illustration').getAttribute('aria-pressed'),'true');assert.match(container.textContent!,/geometry and dimensions are unverified/);assert.match(container.querySelector('.stage-map-top')!.textContent!,/SPATIAL/);assert.equal(container.querySelector('[data-selected]')!.textContent,selected);await act(async()=>button('Plan view').click());assert.equal(container.querySelector('[data-selected]')!.textContent,selected);assert.equal(digest(data),before);});
test('another current production clears the local perspective and linked source identity',async()=>{await mount();await act(async()=>button('Spatial illustration').click());const node=container.querySelector<HTMLButtonElement>('.presentation-stage-selectors button')!;await act(async()=>node.click());const other=presentationFixture();await act(async()=>root!.render(<View data={other}/>));assert.equal(button('Plan view').getAttribute('aria-pressed'),'true');assert.equal(container.querySelector('[data-selected]')!.textContent,'No selection');assert.match(container.textContent!,/no scale or surveyed dimensions/);});
test('reduced-motion input and print events never add a cue, animation or request',async()=>{const data=await mount(),before=digest(data);assert.equal(matchMedia('(prefers-reduced-motion: reduce)').matches,true);await act(async()=>button('Spatial illustration').click());await act(async()=>{window.dispatchEvent(new Event('beforeprint'));window.dispatchEvent(new Event('afterprint'));});assert.equal(digest(data),before);assert.equal(container.querySelector('animate,animateTransform'),null);assert.equal(container.querySelector('audio,video'),null);});
