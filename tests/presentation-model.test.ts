import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { acceptedRead, confirmedClockTransition, currentGo, currentHouseOpen, currentReadiness, parseSelection, pendingObservations, productionIdentity, sameProduction, selectionDetail, watchCanPresent } from "../src/components/presentation/model";
import { stageSelectionNodes } from "../src/components/presentation/stage-nodes";
import { atVenue } from "../src/domain/time";
import { presentationFixture, revise, withSyntheticGo } from "./presentation-fixture";
import type { ConsoleData } from "../src/domain/contracts";

test("selection is bounded and exact, without arbitrary metadata or authority", () => {
  for (const value of [null, [], {}, { kind: "task", id: "" }, { kind: "task", id: "x".repeat(201) }, { kind: "task", id: "load-in", secret: "irrelevant" }, { kind: "actor", id: "load-in" }]) assert.equal(parseSelection(value), null);
  assert.deepEqual(parseSelection({ kind: "task", id: "load-in" }), { kind: "task", id: "load-in" });
});
test("linked calls preserve exact assignments, dependency edges and source IDs", () => {
  const data = presentationFixture(), original = JSON.stringify(data), task = data.show.tasks.find(row => row.id === "lx-focus")!, detail = selectionDetail(data, { kind: "task", id: task.id })!;
  assert.deepEqual(detail.tasks.map(row => row.id), [task.id]); assert.deepEqual(detail.resources.map(row => row.id).sort(), [...task.resources].sort());
  assert.deepEqual(detail.dependencies.map(row => row.id).sort(), data.show.dependencies.filter(row => row.from === task.id || row.to === task.id).map(row => row.id).sort());
  assert.ok(detail.sources.every(row => row.id === task.sourceId)); assert.equal(JSON.stringify(data), original);
});
test("resource incident impact is an explicit edge, never a matching name", () => {
  const data = presentationFixture(); data.show.incidents.push({ id: "synthetic-impact", kind: "console", title: "Controlled impact", summary: "Synthetic relationship only", receivedAt: data.serverAt, sourceZone: data.show.zone, sourceText: "Fixture", earliestAvailable: data.show.clock, resourceIds: ["tom"], affectedTaskIds: ["doors"], confirmed: true, source: "sample" });
  const detail = selectionDetail(data, { kind: "resource", id: "tom" })!; assert.ok(detail.tasks.some(row => row.id === "doors")); assert.ok(detail.tasks.every(row => row.resources.includes("tom") || row.id === "doors")); assert.equal(selectionDetail(data, { kind: "resource", id: "Tom Chen" }), null);
});
test("a quoted supplier creates no invented canonical task or fulfillment edge", () => {
  const data = presentationFixture(), offer = data.show.offers[0]!, detail = selectionDetail(data, { kind: "supplier", id: offer.id })!;
  assert.equal(detail.suppliers[0], offer); assert.deepEqual(detail.tasks, []); assert.deepEqual(detail.resources, []);
  data.show.tasks[0]!.sourceId = offer.id; assert.deepEqual(selectionDetail(data, detail.selection)!.tasks.map(row => row.id), [data.show.tasks[0]!.id]);
});
test("missing source detail stays explicit without a fabricated citation", () => {
  const data = presentationFixture(); data.show.tasks[0]!.sourceId = "no-source-supplied";
  const detail = selectionDetail(data, { kind: "task", id: data.show.tasks[0]!.id })!; assert.deepEqual(detail.missingSourceIds, ["no-source-supplied"]); assert.deepEqual(detail.sources, []);
});
test("stage nodes bind current department and critical equipment IDs", () => {
  const data = presentationFixture(), nodes = stageSelectionNodes(data); assert.ok(nodes.length >= 6); assert.ok(nodes.every(row => selectionDetail(data, row.selection))); assert.equal(new Set(nodes.map(row => row.id)).size, nodes.length);
  data.show.tasks = []; data.show.resources = []; assert.deepEqual(stageSelectionNodes(data), []);
});
test("readiness alone never issues GO or HOUSE OPEN", () => {
  const data = presentationFixture(); data.readiness.forEach(row => { row.ready = true; row.gates.forEach(gate => { gate.complete = true; }); }); assert.equal(currentGo(data), null); assert.equal(currentHouseOpen(data), false); data.readiness[0]!.revision--; assert.equal(currentReadiness(data), null);
});
const invalidGo: [string, (data: ConsoleData) => void][] = [
  ["stale readiness", data => { data.readiness[0]!.revision--; }],
  ["pending gate", data => { data.readiness[0]!.gates[0]!.complete = false; }],
  ["no gates", data => { data.readiness[0]!.gates = []; }],
  ["standby state", data => { data.show.state = "standby"; }],
  ["missing report binding", data => { data.show.goReportId = null; }],
  ["foreign actor tenant", data => { data.currentActor.tenantId = randomUUID(); }],
  ["historical crew projection", data => { data.crew!.cues[0]!.record!.status = "historical"; }],
  ["unassigned cue person", data => { data.crew!.cues[0]!.personIds = ["avery"]; }],
  ["older plan", data => { data.crew!.cues[0]!.record!.planVersion--; }],
  ["older sheet digest", data => { data.crew!.cues[0]!.record!.sheetDigest = "d".repeat(64); }],
  ["raw cue absent", data => { data.show.crewCues = []; }],
  ["other command", data => { data.show.crewCues![0]!.commandId = randomUUID(); }],
  ["other raw person", data => { data.show.crewCues![0]!.personId = "avery"; }],
  ["other show", data => { data.show.crewCues![0]!.showId = "foreign-show"; }],
  ["other raw sheet", data => { data.show.crewCues![0]!.sheetDigest = "d".repeat(64); }],
  ["other raw actor", data => { data.show.crewCues![0]!.actorId = "foreign"; }],
  ["future scenario cue", data => { data.show.crewCues![0]!.fixtureAt = data.crew!.cues[0]!.record!.fixtureAt = atVenue("23:30"); }],
  ["invalid recorded instant", data => { data.show.crewCues![0]!.recordedAt = data.crew!.cues[0]!.record!.recordedAt = "invalid"; }],
];
for (const [label, mutate] of invalidGo) test(`quiet GO rejects ${label}`, () => { const data = withSyntheticGo(presentationFixture()); mutate(data); assert.equal(currentGo(data), null); });
test("synthetic component GO exercises exact projection binding without an operational claim", () => { const data = withSyntheticGo(presentationFixture()), raw = data.show.crewCues![0]!; assert.equal(currentGo(data)!.id, raw.id); assert.equal(currentGo(data)!.revision, raw.revision); assert.equal(currentHouseOpen(data), false); });
test("saved cues do not replay; a watch requires a cue recorded after its exact revision", () => {
  const before = withSyntheticGo(presentationFixture()), watch = { production: productionIdentity(before), baselineCue: currentGo(before)!.id, revision: before.show.revision };
  assert.equal(watchCanPresent(watch, before, true), null); assert.equal(watchCanPresent(watch, revise(before), true), null);
  const after = withSyntheticGo(before); assert.equal(watchCanPresent(watch, after, false), null); assert.equal(watchCanPresent(watch, after, true)!.id, currentGo(after)!.id); assert.equal(watchCanPresent(watch, withSyntheticGo(presentationFixture()), true), null);
  const oldBecameCurrent = revise(before); assert.equal(watchCanPresent({ ...watch, baselineCue: null }, oldBecameCurrent, true), null);
});
test("HOUSE OPEN needs its own current exact preceding-cue record", () => {
  const data = withSyntheticGo(presentationFixture()), raw = structuredClone(data.show.crewCues![0]!), summary = structuredClone(data.crew!.cues[0]!.record!);
  data.show.state = "house_open"; raw.id = summary.id = randomUUID(); raw.kind = summary.kind = "HOUSE_OPEN"; raw.precedingCueId = data.show.crewCues![0]!.id; raw.commandId = summary.commandId = randomUUID(); data.show.crewCues!.push(raw); data.crew!.cues.push({ kind: "HOUSE_OPEN", title: "Synthetic separate FOH command", personIds: [raw.personId], record: summary }); assert.equal(currentHouseOpen(data), true); raw.precedingCueId = randomUUID(); assert.equal(currentHouseOpen(data), false);
});
test("clock slates require a newer same-production recorded advance event", () => {
  const before = presentationFixture(), after = revise(before, data => { data.show.clock = atVenue("16:10"); data.show.events.push({ id: randomUUID(), type: "fixture.clock_advanced", message: "Controlled component input", at: data.serverAt, fixtureAt: data.show.clock, actorId: data.currentActor.id, source: "sample", revision: data.show.revision }); }); assert.equal(confirmedClockTransition(before, after)!.elapsedMinutes, 45); assert.equal(confirmedClockTransition(after, before), null);
  assert.equal(confirmedClockTransition(before, revise(before, data => { data.show.clock = after.show.clock; })), null); const foreign = structuredClone(after); foreign.show.tenantId = randomUUID(); assert.equal(confirmedClockTransition(before, foreign), null);
});
test("refresh cannot downgrade, cross scope, lose arrays or claim an older confirmation", () => {
  const data = presentationFixture(), next = revise(data); assert.equal(acceptedRead(data, next), true);
  for (const value of [null, [], {}, { show: {} }, { ...next, readiness: null }, { ...next, show: { ...next.show, offers: null } }, { ...next, serverAt: "2020-01-01T00:00:00Z" }, { ...next, currentActor: { ...next.currentActor, id: "foreign" } }, { ...next, show: { ...next.show, revision: 0 } }]) assert.equal(acceptedRead(data, value), false); assert.equal(sameProduction(data, next), true); assert.equal(sameProduction(data, presentationFixture()), false);
});
test("pending financial observations survive display and scenario time skips", () => {
  const data = presentationFixture(); data.show.financialChecks = [{ id: randomUUID(), seller: "venue", eventType: "capture-read", resources: [], status: "pending", receivedAt: data.serverAt, revision: data.show.revision, resolvedAt: null, transport: "local_fixture" }]; assert.equal(pendingObservations(data.show).length, 1); data.show.clock = atVenue("23:30"); assert.equal(pendingObservations(data.show).length, 1);
  const go = withSyntheticGo(data); assert.equal(watchCanPresent({ production: productionIdentity(data), baselineCue: null, revision: data.show.revision }, go, true), null);
});
