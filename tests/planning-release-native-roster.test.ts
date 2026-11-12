/** Actual installed model, synthetic input only. Root owns real-browser virtualization proof. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { dom } from './presentation-dom';
import { ProjectModel } from '@bryntum/gantt-enterprise';
import { timelineProjection } from '../src/domain/adapters';
import { presentationFixture } from './presentation-fixture';
after(()=>{assert.equal((globalThis as any).openingNightEvaluationGuard.state.networkAttemptsBlocked,0);dom.window.close();});
test('installed committed project retains the appended fifteenth resource and its exact LX assignment',async()=>{const {show}=presentationFixture(),base=show.resources.length,person=structuredClone(show.resources.find(row=>row.id==='priya')!);assert.equal(base,14);person.id='input-stage20-controlled-mira';person.name='Controlled Mira';show.resources.push(person);show.tasks.find(task=>task.id==='lx-program')!.resources=[person.id];const original=JSON.stringify(show);const project=new ProjectModel({timeZone:show.zone,startDate:show.tasks[0]!.start,hoursPerDay:24,daysPerWeek:7,calendar:'release-all-hours',calendars:[{id:'release-all-hours',name:'Controlled explicit calls',unspecifiedTimeIsWorking:true}],...timelineProjection(show.tasks,show.dependencies,show.resources,false)});try{await project.commitAsync();assert.equal(project.resourceStore.count,15);assert.equal(project.resourceStore.getById(person.id)?.get('name'),'Controlled Mira');assert.equal(String(project.resourceStore.getAt(14)?.id),person.id);assert.ok(project.assignmentStore.records.some(row=>String(row.get('resourceId'))===person.id&&String(row.get('eventId'))==='lx-program'));assert.equal(JSON.stringify(show),original);}finally{project.destroy();}});
