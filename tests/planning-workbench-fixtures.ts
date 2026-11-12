import { randomUUID } from 'node:crypto';
import type { ShowSnapshot } from '../src/domain/contracts';
import type { ProductionTemplate, TemplateSpec, Tour, TourDraft, PlannedProduction } from '../src/domain/tour/contracts';
import { instantiate, recordDigest } from '../src/domain/tour/templates';
import { sampleTime, sampleVenue, syntheticSource } from '../src/domain/tour/fixture';
import { localTime } from '../src/domain/time';

/** Declared test requirements only: no operational, financial or physical evidence. */
export function assignmentSpec(show: ShowSnapshot, taskId='lx-program'): TemplateSpec {
 const task=show.tasks.find(row=>row.id===taskId)!; if(task.lane==='commercial') throw new Error('Controlled assignment fixture requires an operating call');
 return { name:'Controlled exact programming requirement',description:'Original declared planning requirements for explicit assignment admission.',zonePolicy:'venue_wall_clock',minimumRestMinutes:600,maxDutyMinutes:1440,
 slots:[{id:'programmer',label:'Lighting programmer',kind:'person',skills:['lx_programming'],capacity:1,sourceIds:['fixture-rider']}],calls:[{id:'programming-call',label:task.name,lane:task.lane,dayOffset:0,localTime:localTime(task.start,show.zone),durationMinutes:task.durationMinutes,slotIds:['programmer'],requiredSkills:['lx_programming'],amplified:false,sourceIds:['fixture-rider']}],dependencies:[],sources:[syntheticSource()],unknowns:[],stage:{width:null,depth:null,units:'normalized',status:'illustrative',sourceIds:['fixture-rider'],pins:[{id:'planning-programmer',label:'Programming station',x:.7,y:.6,slotId:'programmer',callId:'programming-call',sourceIds:['fixture-rider']}]}};
}
export function assignmentTourDraft(show:ShowSnapshot,productions:PlannedProduction[],personId:string):TourDraft {
 const person=show.resources.find(row=>row.id===personId)!;
 return {name:'Controlled source-bound assignment tour',productionIds:productions.map(row=>row.id),resources:[{id:person.id,personId:person.id,label:person.name,kind:'person',skills:[...person.skills],capacity:1,availability:[{start:sampleTime('2026-11-13','00:00',show.zone),end:sampleTime('2026-11-19','23:59',show.zone)}],availabilityStatus:'reviewed',forecastHourlyMinor:person.rateMinor,sourceIds:['fixture-route']}],legs:[],sources:[syntheticSource('fixture-route','Declared test itinerary')],minimumRestMinutes:600,maxDutyMinutes:1440};
}
export function assignmentFixture(show:ShowSnapshot,personId='controlled-mira') {
 const at='2026-11-12T08:00:00Z',spec=assignmentSpec(show),template:ProductionTemplate={id:randomUUID(),kind:'template',revision:1,digest:'',archived:false,createdAt:at,updatedAt:at,actorId:'controlled-producer',reason:'Original declared test requirements',spec,origin:'synthetic_fixture',compilerBinding:null};template.digest=recordDigest(template);
 const production=instantiate(template,randomUUID(),'Controlled Alder Hall planning leg',show.showDate,sampleVenue(show.venue,'Chicago',show.showDate,show.zone),'controlled-producer',at);production.allocations={programmer:personId};production.digest=recordDigest(production);
 const tour:Tour={...assignmentTourDraft(show,[production],personId),id:randomUUID(),kind:'tour',revision:1,digest:'',archived:false,createdAt:at,updatedAt:at,actorId:'controlled-producer',reason:'Declared controlled itinerary'};tour.digest=recordDigest(tour);
 return {template,production,tour,mapping:[{callId:'programming-call',taskId:'lx-program'}]};
}
