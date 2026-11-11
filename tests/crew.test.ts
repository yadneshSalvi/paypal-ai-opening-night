import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyCommand, recordRescueRun } from "../src/domain/commands";
import { applyCrewCommand } from "../src/domain/crew/commands";
import { crewCommandEnvelopeSchema, crewDataSchema, crewDutyKinds, type CrewRecord } from "../src/domain/crew/contracts";
import { canAttest, canCue, currentAttestation, currentCrewRecord, currentCrewReview, currentCue, currentRentalClearance, personalCalls, personalRest, technicalClearance } from "../src/domain/crew/policy";
import { currentAcknowledgments, readiness } from "../src/domain/readiness";
import { calendarProjection } from "../src/domain/adapters";
import { atVenue } from "../src/domain/time";
import { crewData, crewProductionOverview } from "../src/server/crew/projection";
import { crewSignatureTools, verifyCrewRecord } from "../src/server/crew/signatures";
import { disrupted, evidence, publishForTest, testEngine } from "./helpers";
import { enumerateCandidates } from "../src/domain/scheduling";
import { projectExecutionMilestones } from "../src/domain/milestones";
import { taskExecutionPresentation } from "../src/domain/task-presentation";
import { controlledCommercialInputs, crewAck, crewActor, crewAttest, crewCue, crewPublished, crewReadyDoors, crewTrust } from "./crew-fixtures";

const expires = new Date(Date.now() + 86400000).toISOString();
const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === expected);

test("canonical assigned skills allow Tom focus, Priya programming, Dana sound, Avery FOH, and Sam stage cues", () => {
  const { show } = crewPublished();
  const people = Object.fromEntries(show.resources.map(person => [person.id, person]));
  assert.equal(canAttest(show, people.tom!, "focus_signed_off"), true);
  assert.equal(canAttest(show, people.tom!, "cue_signed_off"), false);
  assert.equal(canAttest(show, people.priya!, "cue_signed_off"), true);
  assert.equal(canAttest(show, people.dana!, "quiet_prep"), true);
  assert.equal(canAttest(show, people.avery!, "foh_contingency"), true);
  assert.equal(canCue(show, people.sam!, "HEADLINER_START"), true);
  assert.equal(canCue(show, people.sam!, "HOUSE_OPEN"), false);
  assert.equal(canCue(show, people.avery!, "HOUSE_OPEN"), true);
  assert.equal(canCue(show, people.avery!, "DOORS_GO"), false);
  const reserve = show.resources.find(person => person.reserve)!;
  for (const kind of crewDutyKinds) assert.equal(canAttest(show, reserve, kind), false);
  show.tasks.find(task => task.id === "lx-program")!.resources = ["tom"];
  assert.equal(canAttest(show, people.priya!, "cue_signed_off"), false);
  assert.equal(canAttest(show, people.tom!, "cue_signed_off"), false);
});
test("producer, mixed-role, wrong-tenant, non-roster and forged capability actors cannot act as a person", () => {
  const { show, actor } = crewPublished(), sheet = show.sheets.at(-1)!;
  const command = { type: "acknowledge" as const, sheetVersion: sheet.version, sheetDigest: sheet.digest, seenTaskIds: [], offline: false };
  const crew = crewActor(show, "sam");
  for (const invalid of [actor, { ...crew, roles: ["crew", "producer"] as typeof crew.roles }, { ...crew, tenantId: randomUUID() }, { ...crew, personId: "invented" }, { ...crew, id: "producer:test" }, { ...crew, executionId: "delivery-only" }]) assert.throws(() => applyCrewCommand(show, invalid, randomUUID(), command, crewTrust));
  assert.equal(show.acknowledgments.length, 0);
});
test("strict command admission rejects claimed roles, people, tenant and unknown payload fields", () => {
  const { show } = crewPublished(); const sheet = show.sheets.at(-1)!;
  const envelope = { idempotencyKey: randomUUID(), expectedRevision: show.revision, command: { type: "acknowledge", sheetVersion: sheet.version, sheetDigest: sheet.digest, seenTaskIds: [], offline: false } };
  for (const extra of [{ personId: "priya" }, { roles: ["producer"] }, { tenantId: show.tenantId }, { actorId: "crew:priya" }]) {
    assert.equal(crewCommandEnvelopeSchema.safeParse({ ...envelope, ...extra }).success, false);
    assert.equal(crewCommandEnvelopeSchema.safeParse({ ...envelope, command: { ...envelope.command, ...extra } }).success, false);
  }
});
test("crew DTO contains only the person's calls, changes, permitted duties and private history", () => {
  const { show } = crewReadyDoors(), actor = crewActor(show, "priya");
  const data = crewData(show, actor, expires), json = JSON.stringify(data);
  assert.equal(crewDataSchema.safeParse(data).success, true);
  assert.deepEqual(Object.keys(data).sort(), ["schemaVersion", "protocol", "controlledQa", "serverAt", "access", "person", "show", "sheet", "review", "acknowledgments", "rest", "duties", "cues", "readiness", "history", "contact"].sort());
  for (const field of ["financialEvidence", "tickets", "providerResourceId", "rateMinor", "hourlyRateMinor", "approvedPlan", "tenantId", "commercialCapMinor"]) assert.equal(json.includes(`"${field}"`), false, field);
  for (const other of show.resources.filter(person => person.kind === "person" && person.id !== "priya")) assert.equal(json.includes(other.name), false, other.name);
  for (const call of data.sheet.calls) assert.deepEqual(call.resources, ["priya"]);
  assert.ok(data.history.every(record => record.personId === "priya"));
  assert.deepEqual(data.duties.map(duty => duty.kind), ["focus_signed_off", "cue_signed_off"]);
  assert.equal(data.cues.length, 0);
  assert.equal(crewDataSchema.safeParse({ ...data, financialEvidence: show.financialEvidence }).success, false);
});
test("explicit adoption preserves original facts, money, history and previous cue state", () => {
  const { show, actor } = publishForTest();
  show.state = "house_open"; show.goReportId = "historical-report";
  show.facts.push({ id: randomUUID(), kind: "focus_signed_off", planVersion: show.planVersion, actorId: actor.id, role: "department_lead", recordedAt: new Date().toISOString(), fixtureAt: atVenue("18:15"), source: "sample", detail: "Earlier operator fact, not a person signoff." });
  const before = structuredClone(show);
  const next = applyCommand(show, actor, { type: "adopt_crew" }, undefined, verifyCrewRecord);
  assert.deepEqual(next.financialEvidence, before.financialEvidence); assert.deepEqual(next.facts, before.facts); assert.deepEqual(next.sheets, before.sheets); assert.deepEqual(next.acknowledgments, before.acknowledgments);
  assert.equal(next.crewAdoption?.previousState, "house_open"); assert.equal(next.crewAdoption?.previousGoReportId, "historical-report"); assert.equal(next.state, "standby");
  assert.equal(currentAttestation(next, "focus_signed_off", verifyCrewRecord), null); assert.equal(crewProductionOverview(next).legacyFactCount, 1);
  assert.equal(next.crewNextCalls?.[0]?.id, "matinee-load-in");
});
test("legacy unbound readback remains historical while a new personal readback can be recorded", () => {
  const { show, actor } = publishForTest(); const sheet = show.sheets.at(-1)!;
  const old = applyCommand(show, { ...actor, id: "crew:priya", roles: ["crew"], personId: "priya" }, { type: "acknowledge", sheetVersion: sheet.version, sheetDigest: sheet.digest, seenTaskIds: sheet.changes.filter(change => change.resourceIds.includes("priya")).map(change => change.taskId), offline: false });
  const personal = crewActor(old, "priya"), next = crewAck(old, "priya", sheet, personal);
  const data = crewData(next, personal, expires);
  assert.equal(data.acknowledgments.length, 2); assert.equal(data.acknowledgments[0]!.current, false); assert.equal(data.acknowledgments[0]!.attribution, "legacy_record"); assert.equal(data.acknowledgments[1]!.current, true);
  assert.deepEqual(next.acknowledgments[0], old.acknowledgments[0]);
});
test("fresh changed lines and exact sheet identity are required, historical offline readbacks never clear current calls", () => {
  const { show } = crewPublished(), actor = crewActor(show, "priya"), sheet = show.sheets.at(-1)!;
  assert.throws(() => applyCrewCommand(show, actor, randomUUID(), { type: "acknowledge", sheetVersion: sheet.version, sheetDigest: sheet.digest, seenTaskIds: [], offline: false }, crewTrust), code("UNREAD_CHANGES"));
  const historical = crewAck(show, "priya", show.sheets[0]!, actor);
  assert.equal(currentAcknowledgments(historical).length, 0);
  const view = crewData(historical, actor, expires); assert.equal(view.acknowledgments[0]!.current, false); assert.equal(view.sheet.changes.length > 0, true);
  assert.throws(() => applyCrewCommand(show, actor, randomUUID(), { type: "acknowledge", sheetVersion: sheet.version, sheetDigest: "f".repeat(64), seenTaskIds: [], offline: true }, crewTrust), code("SHEET_NOT_FOUND"));
});
test("current readback, work time, accepted console and current fee capture precede technical signatures", () => {
  let { show } = crewPublished();
  assert.throws(() => crewAttest(show, "tom", "focus_signed_off"), code("CURRENT_READBACK_REQUIRED"));
  show = crewAck(show, "tom");
  assert.throws(() => crewAttest(show, "tom", "focus_signed_off"), /completion time/);
  show.clock = atVenue("18:45");
  assert.throws(() => crewAttest(show, "tom", "focus_signed_off"), /Accepted console delivery/);
  controlledCommercialInputs(show);
  const accepted = show.facts.pop()!;
  assert.throws(() => crewAttest(show, "tom", "focus_signed_off"), /Accepted console delivery/);
  show.facts.push(accepted);
  show.financialEvidence.find(item => item.purpose === "rental" && item.kind === "capture")!.status = "pending";
  assert.throws(() => crewAttest(show, "tom", "focus_signed_off"), /currently verified/);
  show.financialEvidence.find(item => item.purpose === "rental" && item.kind === "capture")!.status = "completed";
  show = crewAttest(show, "tom", "focus_signed_off"); assert.ok(currentAttestation(show, "focus_signed_off", verifyCrewRecord));
});
test("programming follows focus and never acquires authority from a producer or Tom", () => {
  let { show, actor } = crewPublished(); controlledCommercialInputs(show); show.clock = atVenue("18:45");
  show = crewAck(crewAck(show, "priya"), "tom");
  assert.throws(() => crewAttest(show, "priya", "cue_signed_off"), /focus sign-off/);
  assert.throws(() => crewAttest(show, "tom", "cue_signed_off"), code("CREW_DUTY_FORBIDDEN"));
  assert.throws(() => applyCommand(show, actor, { type: "fact", kind: "cue_signed_off", detail: "Producer must not impersonate a programmer." }), code("PERSON_SIGNOFF_REQUIRED"));
  show = crewAttest(show, "tom", "focus_signed_off"); show = crewAttest(show, "priya", "cue_signed_off");
  assert.equal(technicalClearance(show, verifyCrewRecord), true); assert.equal(technicalClearance(show), false);
  assert.equal(show.crewAttestations!.at(-1)!.personId, "priya"); assert.equal(show.facts.some(fact => fact.kind === "cue_signed_off"), false);
});
test("selected supplier amounts drive signed technical prerequisites, readiness and displayed execution milestones", () => {
  const initial = disrupted();
  // A controlled early Northside quote isolates selected-price propagation;
  // the canonical late quote still needs separate artist consent.
  initial.show.offers.find(offer => offer.supplierId === "northside")!.deliveryAt = atVenue("17:15");
  const candidates = enumerateCandidates(initial.show);
  for (const candidate of candidates) candidate.report.engine = testEngine(candidate);
  initial.show = recordRescueRun(initial.show, initial.actor, candidates);
  const candidate = initial.show.runs[0]!.candidates.find(item => item.id.startsWith("doors-northside"))!;
  assert.ok(candidate);
  let show = applyCommand(initial.show, initial.actor, { type: "approve", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: candidate.approvals.map(approval => approval.id) });
  show = applyCommand(show, initial.actor, { type: "adopt_crew" }, undefined, crewTrust.verify);
  show.financialEvidence.push(evidence(show, { kind: "authorization", purpose: "rental", amountMinor: 63000, providerResourceId: "CONTROLLED-NORTHSIDE-AUTH" }));
  show.facts.push({ id: randomUUID(), kind: "supplier_confirmed", planVersion: show.planVersion, actorId: "fixture:northside", role: "supplier", recordedAt: new Date().toISOString(), fixtureAt: show.clock, source: "sample", detail: "Controlled selected-supplier prerequisite." });
  show = applyCommand(show, initial.actor, { type: "publish" }, undefined, crewTrust.verify);
  show.financialEvidence.push(evidence(show, { kind: "capture", purpose: "rental", amountMinor: 48000, parentId: "CONTROLLED-NORTHSIDE-AUTH" }));
  show.facts.push({ id: randomUUID(), kind: "delivery_accepted", planVersion: show.planVersion, actorId: "fixture:inspector", role: "department_lead", recordedAt: new Date().toISOString(), fixtureAt: atVenue("18:45"), source: "sample", detail: "Controlled acceptance only, no physical inspection." });
  show.clock = atVenue("20:45"); show = crewAck(crewAck(show, "tom"), "priya");
  assert.equal(currentRentalClearance(show).capture, null);
  assert.throws(() => crewAttest(show, "tom", "focus_signed_off"), /currently verified/);
  assert.notEqual(projectExecutionMilestones(show, crewTrust.verify).tasks.find(task => task.id === "rental-captured")!.state, "complete");
  show.financialEvidence.find(item => item.kind === "capture")!.amountMinor = 33000;
  show = crewAttest(show, "tom", "focus_signed_off"); show = crewAttest(show, "priya", "cue_signed_off");
  const projected = projectExecutionMilestones(show, crewTrust.verify), overview = crewProductionOverview(projected);
  for (const id of ["rental-authorized", "rental-captured", "lx-focus", "lx-program"]) assert.equal(projected.tasks.find(task => task.id === id)!.state, "complete", id);
  const report = readiness(show, "DOORS", undefined, crewTrust.verify);
  for (const id of ["authorization", "capture", "technical"]) assert.equal(report.gates.find(gate => gate.id === id)!.complete, true, id);
  assert.equal(report.gates.find(gate => gate.id === "capture")!.value, "$330 captured");
  assert.deepEqual(taskExecutionPresentation(projected, projected.tasks.find(task => task.id === "rental-captured")!, { crew: overview, controlledQa: true }), { label: "Fixture capture", source: "Controlled financial input; no provider qualification", tone: "amber" });
  for (const id of ["lx-focus", "lx-program"]) assert.equal(taskExecutionPresentation(projected, projected.tasks.find(task => task.id === id)!, { crew: overview, controlledQa: true }).source, "Signed personal crew record · controlled participation");
  show.financialEvidence.find(item => item.kind === "capture")!.status = "pending";
  assert.equal(readiness(show, "DOORS", undefined, crewTrust.verify).gates.find(gate => gate.id === "technical")!.complete, false);
  assert.notEqual(projectExecutionMilestones(show, crewTrust.verify).tasks.find(task => task.id === "lx-focus")!.state, "complete");
});
test("signatures bind context and reject wrong keys, altered fields, stale plans, policy, sheets and changed assignments", () => {
  const { show } = crewReadyDoors(), record = show.crewAttestations!.find(item => item.kind === "cue_signed_off")!;
  assert.equal(verifyCrewRecord(record), true); assert.equal(crewSignatureTools("other controlled secret").verify(record), false);
  for (const changed of [{ detail: "Replaced signed description." }, { personId: "tom" }, { tenantId: randomUUID() }, { showId: "other-show" }, { sheetDigest: "f".repeat(64) }, { planVersion: record.planVersion + 1 }, { actorId: "producer:all-roles" }, { fixtureAt: atVenue("19:00") }]) assert.equal(verifyCrewRecord({ ...record, ...changed }), false);
  for (const mutate of [(next: typeof show) => { next.planVersion++; }, (next: typeof show) => { next.policy.version++; }, (next: typeof show) => { next.sheets.at(-1)!.digest = "a".repeat(64); }, (next: typeof show) => { next.tasks.find(task => task.id === "lx-program")!.resources = ["tom"]; }]) {
    const next = structuredClone(show); mutate(next); assert.equal(currentAttestation(next, "cue_signed_off", verifyCrewRecord), null); assert.equal(technicalClearance(next, verifyCrewRecord), false);
  }
  const missing = structuredClone(show); missing.crewAttestations = missing.crewAttestations!.filter(item => item.id !== record.id); assert.equal(currentCrewRecord(missing, record, verifyCrewRecord), false);
});
test("10/11 and eleven historical readbacks block DOORS; the reserve never becomes the eleventh critical person", () => {
  const { show } = crewReadyDoors(); assert.equal(readiness(show, "DOORS", undefined, verifyCrewRecord).ready, true);
  show.acknowledgments = show.acknowledgments.filter(ack => ack.personId !== "lee");
  const reserve = show.resources.find(person => person.reserve)!;
  const next = crewAck(show, reserve.id);
  assert.equal(currentAcknowledgments(next).length, 10); assert.equal(readiness(next, "DOORS", undefined, verifyCrewRecord).ready, false);
  const historical = crewReadyDoors().show;
  for (const ack of historical.acknowledgments) { ack.sheetVersion = historical.sheets[0]!.version; ack.sheetDigest = historical.sheets[0]!.digest; }
  assert.equal(currentAcknowledgments(historical).length, 0); assert.equal(readiness(historical, "DOORS", undefined, verifyCrewRecord).gates.find(gate => gate.id === "crew")!.complete, false);
});
test("pending refunds and adverse current provider observations block every future cue without erasing history", () => {
  const { show } = crewReadyDoors();
  show.financialEvidence.find(item => item.kind === "refund")!.status = "pending";
  assert.equal(readiness(show, "DOORS", undefined, verifyCrewRecord).ready, false);
  assert.throws(() => crewCue(show, "sam", "DOORS_GO"), code("CREW_CUE_BLOCKED"));
  const next = crewReadyDoors().show, capture = next.financialEvidence.find(item => item.kind === "capture" && item.purpose === "rental")!;
  next.financialObservations = [{ id: randomUUID(), seller: "brightline", kind: "capture", providerResourceId: capture.providerResourceId!, status: "REVERSED", amountMinor: 48000, currency: "USD", parentId: capture.parentId, observedAt: new Date(Date.now() + 1000).toISOString(), transport: "paypal_https" }];
  for (const scope of ["DOORS", "SUPPORT_START", "HEADLINER_START"] as const) assert.equal(readiness(next, scope, undefined, verifyCrewRecord).ready, false);
  assert.equal(next.crewAttestations!.length, 3); assert.equal(next.financialEvidence.includes(capture), true);
});
test("cue reports are exact current reviews and a new incident invalidates prior signed context", () => {
  const { show, actor } = crewReadyDoors(); const report = readiness(show, "DOORS", undefined, verifyCrewRecord);
  const advanced = applyCommand(show, actor, { type: "advance", time: "19:00" }, undefined, verifyCrewRecord);
  assert.throws(() => crewCue(advanced, "sam", "DOORS_GO", report.id), code("STALE_READINESS"));
  assert.throws(() => applyCommand(show, actor, { type: "go", reportId: report.id }), code("PERSON_CUE_REQUIRED"));
  const go = crewCue(show, "sam", "DOORS_GO");
  go.planVersion++; go.approvedPlan = null; go.state = "standby"; go.goReportId = null;
  assert.equal(currentCue(go, "DOORS_GO", verifyCrewRecord), null); assert.equal(readiness(go, "DOORS", undefined, verifyCrewRecord).ready, false);
});
test("DOORS, house opening, support and headliner each require their assigned separate cue in order", () => {
  let { show, actor } = crewReadyDoors();
  assert.equal(currentCue(show, "SUPPORT_START", verifyCrewRecord), null);
  assert.throws(() => crewCue(show, "avery", "HOUSE_OPEN"), code("CREW_CUE_BLOCKED"));
  show = crewCue(show, "sam", "DOORS_GO"); assert.equal(show.state, "go");
  assert.throws(() => crewCue(show, "sam", "HOUSE_OPEN"), code("CREW_CUE_FORBIDDEN"));
  show = applyCommand(show, actor, { type: "advance", time: "19:00" }, undefined, verifyCrewRecord);
  show = crewCue(show, "avery", "HOUSE_OPEN"); assert.equal(show.state, "house_open");
  assert.equal(readiness(show, "SUPPORT_START", undefined, verifyCrewRecord).ready, false);
  show = crewAttest(show, "sam", "support_checkin"); show = crewAttest(show, "dana", "support_ready");
  assert.equal(readiness(show, "SUPPORT_START", undefined, verifyCrewRecord).ready, true);
  assert.throws(() => crewCue(show, "sam", "SUPPORT_START"), /scheduled time/);
  assert.throws(() => crewAttest(show, "sam", "headliner_checkin"), /completion time/);
  show = applyCommand(show, actor, { type: "advance", time: "20:00" }, undefined, verifyCrewRecord);
  assert.equal(currentCue(show, "SUPPORT_START", verifyCrewRecord), null);
  show = crewCue(show, "sam", "SUPPORT_START");
  assert.equal(currentCue(show, "HEADLINER_START", verifyCrewRecord), null);
  show = applyCommand(show, actor, { type: "advance", time: "20:10" }, undefined, verifyCrewRecord);
  assert.throws(() => crewAttest(show, "dana", "quiet_prep"), /check-in first/);
  show = crewAttest(show, "sam", "headliner_checkin"); show = crewAttest(show, "dana", "quiet_prep");
  assert.throws(() => crewAttest(show, "sam", "changeover"), /completion time/);
  show = applyCommand(show, actor, { type: "advance", time: "20:40" }, undefined, verifyCrewRecord); show = crewAttest(show, "sam", "changeover");
  assert.equal(readiness(show, "HEADLINER_START", undefined, verifyCrewRecord).ready, true);
  assert.throws(() => crewCue(show, "sam", "HEADLINER_START"), /scheduled time/);
  show = applyCommand(show, actor, { type: "advance", time: "20:45" }, undefined, verifyCrewRecord);
  assert.equal(currentCue(show, "HEADLINER_START", verifyCrewRecord), null);
  show = crewCue(show, "sam", "HEADLINER_START");
  assert.deepEqual(show.crewCues!.map(cue => cue.kind), ["DOORS_GO", "HOUSE_OPEN", "SUPPORT_START", "HEADLINER_START"]);
  assert.ok(show.crewCues!.every(record => verifyCrewRecord(record)));
  assert.throws(() => crewCue(show, "sam", "HEADLINER_START"), /already been recorded/);
});
test("a reissued GO preserves the earlier receipt as superseded history", () => {
  let { show } = crewReadyDoors(); show = crewCue(show, "sam", "DOORS_GO"); const first = show.crewCues![0]!;
  show.state = "standby"; show.goReportId = null; show.revision++;
  show = crewCue(show, "sam", "DOORS_GO");
  assert.equal(currentCrewRecord(show, first, verifyCrewRecord), false);
  assert.equal(crewProductionOverview(show).history.find(record => record.id === first.id)!.status, "historical");
  assert.equal(currentCue(show, "DOORS_GO", verifyCrewRecord)!.id, show.crewCues!.at(-1)!.id);
});
test("native personal Calendar preserves own call IDs and exact UTC boundaries including midnight and next-day call", () => {
  const { show } = crewPublished(); const calls = personalCalls(show, "sam");
  const projection = calendarProjection(calls, show.resources, "sam");
  assert.equal(projection.resources.length, 1); assert.equal(projection.events.length, calls.length);
  for (const call of calls) { const event = projection.events.find(item => item.id === call.id)!; assert.equal(event.startDate, call.start); assert.equal(event.endDate, call.end); assert.equal(event.resourceId, "sam"); }
  const next = projection.events.find(event => event.id === "matinee-load-in")!; assert.equal(next.startDate, atVenue("10:00", "2026-11-15"));
  const milestone = calls.find(call => call.durationMinutes === 0)!; assert.equal(projection.events.find(event => event.id === milestone.id)!.endDate, milestone.start);
});
test("rest uses the person's published finish: 10h30 passes, 9h30 fails, missing last call stays unknown", () => {
  const { show } = crewPublished();
  for (const id of ["sam", "priya"]) { const rest = personalRest(show, id); assert.equal(rest.minutes, 630); assert.equal(rest.status, "pass"); assert.equal(rest.nextCall!.id, "matinee-load-in"); }
  const artist = structuredClone(show); artist.sheets.at(-1)!.tasks.find(task => task.id === "strike")!.end = atVenue("00:30", "2026-11-15");
  assert.equal(personalRest(artist, "sam").minutes, 570); assert.equal(personalRest(artist, "priya").status, "fail");
  artist.sheets.at(-1)!.tasks = artist.sheets.at(-1)!.tasks.filter(task => !task.resources.includes("sam"));
  const unknown = personalRest(artist, "sam"); assert.equal(unknown.status, "unknown"); assert.equal(unknown.minutes, null); assert.equal(unknown.lastFinishAt, null);
  assert.equal(personalRest(show, show.resources.find(person => person.reserve)!.id).status, "not_scheduled");
});
