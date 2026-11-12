/** Negative synthetic policy snapshots; positive execution uses the full service journey. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {crewReadyDoors} from './crew-fixtures';
import {enumerateStrategies} from '../src/domain/planning-workbench/strategies';
import {canAttest,dutyBlockers,headlinerPreparationKind} from '../src/domain/crew/policy';
import {readiness} from '../src/domain/readiness';
import {verifyCrewRecord} from '../src/server/crew/signatures';
import {atVenue} from '../src/domain/time';
function snapshot(){const{show}=crewReadyDoors(),candidate=enumerateStrategies(show,{kinds:['stage_soundcheck'],offerIds:[show.offers[0]!.id],substitutions:[]})[0]!;candidate.id=show.approvedPlan!.candidateId;show.runs.at(-1)!.candidates=show.runs.at(-1)!.candidates.map(row=>row.id===candidate.id?candidate:row);show.tasks=candidate.patch.tasks;show.dependencies=candidate.patch.dependencies;return show;}
test('an unchanged quiet-preparation plan never exposes the distinct amplified soundcheck duty',()=>{const{show}=crewReadyDoors(),dana=show.resources.find(row=>row.id==='dana')!;assert.equal(headlinerPreparationKind(show),'quiet_prep');assert.equal(canAttest(show,dana,'headliner_soundcheck'),false);assert.equal(canAttest(show,dana,'quiet_prep'),true);});
test('a stage-soundcheck proposal does not inherit quiet-preparation or scenario-clock completion',()=>{const show=snapshot();show.clock=atVenue('23:00');assert.equal(headlinerPreparationKind(show),'headliner_soundcheck');assert.equal(canAttest(show,show.resources.find(row=>row.id==='dana')!,'quiet_prep'),false);const gate=readiness(show,'DOORS',undefined,verifyCrewRecord).gates.find(row=>row.id==='stage-soundcheck');assert.ok(gate);assert.equal(gate.complete,false);assert.equal(readiness(show,'HEADLINER_START',undefined,verifyCrewRecord).gates.find(row=>row.id==='headliner-prep')!.complete,false);});
test('stage soundcheck and changeover retain exact assigned-person, check-in, timing and signed-preparation boundaries',()=>{const show=snapshot(),dana=show.resources.find(row=>row.id==='dana')!,sam=show.resources.find(row=>row.id==='sam')!;assert.equal(canAttest(show,sam,'headliner_soundcheck'),false);assert.ok(dutyBlockers(show,dana,'headliner_soundcheck',verifyCrewRecord).some(row=>row.includes('check-in')));assert.ok(dutyBlockers(show,dana,'headliner_soundcheck',verifyCrewRecord).some(row=>row.includes('completion time')));assert.ok(dutyBlockers(show,sam,'changeover',verifyCrewRecord).some(row=>row.includes('stage soundcheck')));});
