/** Design-core read models: header, recovery studio, supplier ghost preview and GO staging. Controlled in-memory fixtures only. */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, useId } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { dom, motion, parse, wait } from "./design-core-dom";
import type { Candidate, ConsoleData, ShowSnapshot } from "../src/domain/contracts";
import { allReadiness } from "../src/domain/readiness";
import { candidateFunnel } from "../src/domain/scheduling";
import { financialSummary } from "../src/domain/finance";
import { formatMoney } from "../src/domain/time";
import { paymentProof, taskExecutionPresentation } from "../src/domain/task-presentation";
import { crewProductionOverview } from "../src/server/crew/projection";
import { approved, base, evidence, publishForTest, withRun } from "./helpers";
import { controlledCommercialInputs, crewAck, crewAttest, crewCue, crewPublished, crewTrust } from "./crew-fixtures";
import { atVenue } from "../src/domain/time";
import { HeaderCue, HeaderDock, HeaderIdentity, HeaderStakes, RehearsalNotice, exposureMeter, headerCounters, headerModel } from "../src/components/production-header";
import { CandidateFunnel, GhostLane, RecoveryView, RejectedFamilyCard, SupplierOfferCards, useSupplierGhost } from "../src/components/recovery-view";
import { funnelCounts, funnelModel, planTabChips, recoveryHeadlines, rejectedFamilies } from "../src/components/recovery-headlines";
import { supplierGhostPreview } from "../src/components/presentation/supplier-preview";
import { GoStaging, goStagingModel } from "../src/components/presentation/go-staging";
import { EvidenceView, BoxOfficeView } from "../src/components/operations-views";
import type { ViewProps } from "../src/components/production-console";
const { createRoot } = await import("react-dom/client");

let root: Root | null = null, container: HTMLDivElement;
async function render(node: React.ReactNode) { if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); } await act(async () => root!.render(node)); }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); motion.reduced = false; });
after(() => dom.window.close());

const consoleData = (show: ShowSnapshot, extra: Partial<ConsoleData> = {}): ConsoleData => ({ show, readiness: allReadiness(show, crewTrust.verify), currentActor: { id: "producer:test", tenantId: show.tenantId, roles: ["producer", "stage_manager"], personId: null }, serverAt: new Date().toISOString(), ...extra });
const crewData = (show: ShowSnapshot, extra: Partial<ConsoleData> = {}) => consoleData(show, { crew: crewProductionOverview(show), ...extra });
const viewProps = (data: ConsoleData): ViewProps => ({ data, onData: () => undefined, run: async () => null, busy: null, licenseKey: "" });
const header = (data: ConsoleData) => parse(renderToStaticMarkup(<><HeaderIdentity data={data} /><HeaderCue data={data} /><HeaderStakes data={data} /><HeaderDock data={data} /><RehearsalNotice data={data} /></>));
/** Every critical person except the last `missing` acknowledges; duties are signed. No cue is called. */
function crewReady(missing = 0) {
  const value = crewPublished(); let show = controlledCommercialInputs(value.show); show.clock = atVenue("18:45");
  const people = show.resources.filter(row => row.kind === "person" && row.critical && !row.reserve);
  const signers = ["sam", "tom", "priya", "avery"], ordered = [...people.filter(row => signers.includes(row.id)), ...people.filter(row => !signers.includes(row.id))];
  for (const person of ordered.slice(0, ordered.length - missing)) show = crewAck(show, person.id);
  show = crewAttest(show, "tom", "focus_signed_off"); show = crewAttest(show, "priya", "cue_signed_off"); show = crewAttest(show, "avery", "foh_contingency");
  return show;
}
const doors = (data: ConsoleData) => data.readiness.find(row => row.scope === "DOORS")!;

test("header strip mirrors the current DOORS report exactly at 0/8, partial and 8/8", () => {
  const empty = consoleData(base().show), none = header(empty), report = doors(empty);
  assert.equal(report.gates.length, 8); assert.equal(report.gates.filter(row => row.complete).length, 0);
  assert.equal(none.querySelectorAll(".readiness-segment").length, 8); assert.equal(none.querySelectorAll(".readiness-segment.complete").length, 0);
  assert.equal(none.querySelector(".cue-badge > span:last-child")!.textContent, "0/8"); assert.ok(none.querySelector(".cue-badge.red")); assert.match(none.querySelector(".cue-badge")!.textContent!, /STANDBY/);
  assert.match(none.querySelector(".readiness-strip")!.getAttribute("aria-label")!, /0 of 8 gates clear/);
  for (const [index, segment] of [...none.querySelectorAll(".readiness-segment")].entries()) { assert.equal(segment.getAttribute("data-gate"), report.gates[index]!.id); assert.equal(segment.getAttribute("data-state"), "pending"); assert.ok(segment.getAttribute("aria-label")!.startsWith(report.gates[index]!.label + ": pending")); assert.equal(segment.getAttribute("href"), report.gates[index]!.href); }

  const partial = crewData(crewReady(2)), some = header(partial), current = doors(partial), clear = current.gates.filter(row => row.complete).map(row => row.id);
  assert.ok(clear.length > 0 && clear.length < current.gates.length, "fixture is partially ready");
  assert.deepEqual([...some.querySelectorAll(".readiness-segment.complete")].map(node => node.getAttribute("data-gate")), clear);
  assert.equal(some.querySelector('.readiness-segment[data-gate="crew"]')!.getAttribute("data-state"), "pending", "a pending gate is never filled");
  assert.equal(some.querySelector(".cue-badge > span:last-child")!.textContent, `${clear.length}/${current.gates.length}`);

  const ready = crewData(crewReady()), all = header(ready);
  assert.equal(doors(ready).ready, true); assert.equal(all.querySelectorAll(".readiness-segment.complete").length, doors(ready).gates.length);
  assert.equal(all.querySelector(".cue-badge.green"), null, "a clear conjunction alone never lights the cue green"); assert.match(all.querySelector(".cue-badge")!.textContent!, /IN PROGRESS/);

  const stale = structuredClone(ready); stale.show.revision++;
  const unread = header(stale); assert.equal(unread.querySelectorAll(".readiness-segment").length, 0); assert.match(unread.querySelector(".readiness-strip")!.textContent!, /READINESS UNREAD/); assert.equal(headerModel(stale).segments, null);
});

test("header identity shows the approved version with its scenario approval time only when a decision is stored", () => {
  const before = header(consoleData(base().show)); assert.equal(before.querySelector(".header-version")!.textContent, "PLAN v1");
  const value = approved(), data = consoleData(value.show), event = value.show.events.findLast(row => row.type === "rescue.approved")!;
  assert.equal(event.at, value.show.approvedPlan!.approvedAt);
  assert.match(header(data).querySelector(".header-version")!.textContent!, new RegExp(`^v${value.show.planVersion} · approved \\d\\d:\\d\\d$`));
  assert.equal(header(data).querySelector(".header-show")!.textContent, value.show.title);
});

test("background counters appear only for a stored, incomplete obligation and read the current report", () => {
  assert.deepEqual(headerCounters(consoleData(base().show)), [], "no approved remedy and no published sheet");
  const decided = consoleData(approved().show); assert.deepEqual(headerCounters(decided).map(row => [row.id, row.done, row.total]), [["refunds", 0, 38]], "approval stores the canceled-perk remedy; no sheet is published yet");
  const published = consoleData(publishForTest().show); assert.deepEqual(headerCounters(published).map(row => [row.id, row.done, row.total]), [["refunds", 0, 38], ["crew", 0, 11]]);
  const nine = crewData(crewReady(2)), counters = headerCounters(nine);
  assert.deepEqual(counters.map(row => [row.id, row.done, row.total]), [["crew", 9, 11]], "38/38 remedies are complete, so only the crew batch remains");
  assert.match(header(nine).querySelector('[data-counter="crew"]')!.textContent!, /Crew 9\/11/); assert.equal(header(nine).querySelector('[data-counter="refunds"]'), null);
  assert.equal(financialSummary(nine.show).refundedVipCount, 38);
  const stale = structuredClone(nine); stale.show.revision++; assert.deepEqual(headerCounters(stale), [], "no current report, no counter");
  assert.deepEqual(headerCounters(crewData(crewReady())), [], "complete batches leave the header");
});

test("exposure meter reads the capture and commitment ledgers with accurate controlled and replayed wording", () => {
  const { show } = base(); show.tickets.push({ id: "t1", tier: "standard", admissionMinor: 3500, perkMinor: 0, captureId: "CAP-1", source: "live_sandbox", refundedMinor: 0, status: "captured" }); show.financialEvidence.push(evidence(show, { amountMinor: 3500, ticketId: "t1", providerResourceId: "CAP-1" }));
  const gross = formatMoney(financialSummary(show).grossCapturedMinor); assert.equal(gross, "$35");
  const live = exposureMeter(consoleData(show)); assert.deepEqual([live.kind, live.amount, live.label, live.qualifier, live.href], ["captured", gross, "captured", "at stake", "/box-office"]);
  assert.equal(header(consoleData(show)).querySelector(".exposure-meter")!.textContent, `${gross}captured· at stake`);
  assert.equal(exposureMeter(consoleData(show, { controlledQa: true })).label, "controlled captures");
  const replay = consoleData(show, { controlledQa: true, demonstration: true } as Partial<ConsoleData>); assert.equal(exposureMeter(replay).label, "replayed captures"); assert.match(header(replay).textContent!, /Replayed captures/); assert.doesNotMatch(header(replay).textContent!, /Verified gross captured|Controlled gross captures/);
  assert.match(header(consoleData(show, { controlledQa: true })).textContent!, /Controlled gross captures/); assert.match(header(consoleData(show)).textContent!, /Verified gross captured/);

  const value = approved(), candidate = value.show.runs[0]!.candidates.find(row => row.id === value.show.approvedPlan!.candidateId)!, committed = exposureMeter(consoleData(value.show));
  assert.deepEqual([committed.kind, committed.amountMinor, committed.amount, committed.label, committed.qualifier, committed.href], ["committed", candidate.cost.totalMinor, "$1,230", "committed", null, "/execution"]);
  assert.equal(exposureMeter(consoleData(value.show, { controlledQa: true })).qualifier, "controlled inputs");
  const tampered = structuredClone(value.show); tampered.approvedPlan!.digest = "0".repeat(64); assert.equal(exposureMeter(consoleData(tampered)).kind, "captured", "a decision that no longer matches its stored candidate commits nothing");
  for (const data of [consoleData(show), consoleData(value.show), replay]) assert.doesNotMatch(header(data).querySelector(".exposure-meter")!.textContent!, /profit|saved|protected/i);
});

test("guided demonstration replaces engineering QA wording with the replayed-outcome notice", () => {
  const show = crewReady(), qa = header(crewData(show, { controlledQa: true })), demo = header(crewData(show, { controlledQa: true, demonstration: true } as Partial<ConsoleData>));
  assert.match(qa.querySelector(".qa-fixture-notice")!.textContent!, /ISOLATED CREW QA · CONTROLLED READINESS INPUTS/);
  assert.match(demo.querySelector(".qa-fixture-notice")!.textContent!, /GUIDED DEMONSTRATION · payment outcomes are replayed; no PayPal request is made/); assert.doesNotMatch(demo.textContent!, /ISOLATED CREW QA|CONTROLLED READINESS INPUTS/); assert.match(demo.textContent!, /GUIDED DEMONSTRATION/);
  assert.equal(header(crewData(show)).querySelector(".qa-fixture-notice"), null);
  const authorized = show.tasks.find(row => row.id === "rental-authorized")!, captured = show.tasks.find(row => row.id === "rental-captured")!;
  const complete = { ...authorized, state: "complete" as const }, done = { ...captured, state: "complete" as const };
  assert.equal(taskExecutionPresentation(show, complete, { controlledQa: true }).label, "Fixture authorization");
  assert.deepEqual(taskExecutionPresentation(show, complete, { controlledQa: true, demonstration: true } as never), { label: "Replayed authorization", source: "Replayed outcome; no PayPal request is made", tone: "amber" });
  assert.equal(taskExecutionPresentation(show, done, { controlledQa: true, demonstration: true } as never).label, "Replayed capture");
  const box = renderToStaticMarkup(<BoxOfficeView {...viewProps(crewData(show, { controlledQa: true, demonstration: true } as Partial<ConsoleData>))} />); assert.match(box, /REPLAYED CAPTURES/); assert.doesNotMatch(box, /CONTROLLED FINANCIAL INPUTS|fixture captures/);
});

test("money-lane proof card states type, amount, status and a redacted identifier, never delivery", () => {
  const show = crewReady(), authorized = show.tasks.find(row => row.id === "rental-authorized")!, proof = paymentProof(show, authorized)!;
  assert.deepEqual([proof.type, proof.amountMinor, proof.settled], ["Rental authorization", 78000, true]); assert.match(proof.redactedId!, /^….{4}$/);
  assert.doesNotMatch(JSON.stringify(proof), /deliver/i);
  assert.equal(paymentProof(show, show.tasks.find(row => row.id === "lx-focus")!), null);
  const pending = approved().show, waiting = paymentProof(pending, pending.tasks.find(row => row.id === "rental-captured")!)!;
  assert.deepEqual([waiting.amountMinor, waiting.redactedId, waiting.settled, waiting.status], [null, null, false, "Not recorded"]);
});

test("funnel counts equal the stored attempts and the unique-rejected total is not a sum of rule chips", async () => {
  const { show } = withRun(), run = show.runs.at(-1)!, counts = funnelCounts(run), domain = candidateFunnel(run.candidates);
  assert.deepEqual({ generated: counts.generated, schemaValid: counts.schemaValid, temporalValid: counts.temporalValid, evidenceValid: counts.evidenceValid, approvable: counts.approvable, rejected: counts.rejected, pending: counts.pending, reasons: counts.reasons }, domain);
  const model = funnelModel(counts, "23:00"); assert.deepEqual(model.stages.map(row => row.id), ["generated", "schema", "temporal", "evidence", "approvable"]);
  assert.equal(model.stages[0]!.count, run.candidates.length); assert.equal(model.stages[4]!.count, run.candidates.filter(row => ["feasible", "feasible_with_approval"].includes(row.report.status)).length);
  for (let index = 1; index < model.stages.length; index++) assert.ok(model.stages[index]!.count <= model.stages[index - 1]!.count, "a later stage never exceeds an earlier one");
  const chipSum = model.reasons.reduce((sum, row) => sum + row.count, 0);
  assert.equal(model.uniqueRejected, run.candidates.filter(row => row.report.status === "infeasible").length); assert.ok(chipSum > model.uniqueRejected, "rule chips overlap in this stored run"); assert.deepEqual(model.provenance, [{ id: "deterministic_enumerator", label: "Deterministic enumerator", count: run.candidates.length }]);
  await render(<CandidateFunnel model={model} />);
  assert.deepEqual([...container.querySelectorAll(".funnel-strip li")].map(node => [node.getAttribute("data-stage"), node.getAttribute("data-count"), node.querySelector("b")!.textContent]), model.stages.map(row => [row.id, String(row.count), String(row.count)]));
  assert.deepEqual([...container.querySelectorAll(".funnel-reasons [data-rule]")].map(node => [node.getAttribute("data-rule"), Number(node.getAttribute("data-count"))]), model.reasons.map(row => [row.code, row.count]));
  assert.equal(container.querySelector("[data-unique-rejected]")!.textContent, String(model.uniqueRejected)); assert.match(container.textContent!, /not a sum/); assert.match(container.textContent!, /Crew rest · \d+/);
  const empty = funnelModel(funnelCounts(undefined)); await render(<CandidateFunnel model={empty} />); assert.deepEqual([...container.querySelectorAll(".funnel-strip b")].map(node => node.textContent), ["—", "—", "—", "—", "—"], "no run, no numbers");
});

test("funnel counts rise once for a newly saved run, never prefill, and are instant under reduced motion", async () => {
  const { show } = withRun(), first = funnelModel(funnelCounts(show.runs.at(-1)!)), second = { ...first, runId: "second-run" }, generated = () => container.querySelector('[data-stage="generated"] b')!.textContent;
  await render(<CandidateFunnel model={first} />); assert.equal(generated(), String(first.stages[0]!.count), "a run that already existed is shown as stored");
  await render(<CandidateFunnel model={first} computing />); assert.equal(generated(), "—"); assert.equal(container.querySelector(".funnel-reasons"), null, "nothing is shown while a run is being computed");
  await render(<CandidateFunnel model={second} />); assert.equal(generated(), "0", "a new run starts from zero, not from a prefilled number"); assert.equal(container.querySelector(".candidate-funnel")!.getAttribute("data-settled"), "false");
  await act(async () => { await wait(1000); }); assert.equal(generated(), String(first.stages[0]!.count)); assert.equal(container.querySelector(".candidate-funnel")!.getAttribute("data-settled"), "true");
  motion.reduced = true; await render(<CandidateFunnel model={{ ...first, runId: "third-run" }} />); assert.equal(generated(), String(first.stages[0]!.count), "reduced motion shows the stored count at once"); assert.equal(container.querySelector(".candidate-funnel")!.getAttribute("data-settled"), "true");
});

test("plan tabs carry exactly three primary chips, amber approval chips, and a diagnostic plan has no select action", () => {
  const { show } = withRun(), data = consoleData(show), candidates = show.runs.at(-1)!.candidates, featured = recoveryHeadlines(show, candidates, Date.parse(data.serverAt));
  const doorsPlan = candidates.find(row => row.id.startsWith("doors-brightline"))!, budget = candidates.find(row => row.id.startsWith("budget-northside"))!, artist = candidates.find(row => row.id.startsWith("artist-brightline"))!;
  assert.deepEqual(planTabChips(show, doorsPlan).primary, ["Doors 19:00 ±0", "+$1,230", "4 calls changed"]);
  assert.deepEqual(planTabChips(show, budget).primary, ["Doors 20:05 +65 min", "+$1,140", "6 calls changed"]);
  assert.ok(planTabChips(show, doorsPlan).approvals.some(row => row.label === "VIP soundcheck canceled · producer approval"));
  assert.ok(planTabChips(show, budget).approvals.some(row => row.label === "Doors 20:05 · producer approval")); assert.ok(planTabChips(show, budget).approvals.some(row => row.label === "Headliner set −15 min · artist representative approval"));
  assert.deepEqual(planTabChips(show, artist), { primary: ["Doors 20:35 +95 min", "+$1,410", "6 calls changed"], approvals: [], diagnostic: { tone: "red", label: "Crew rest 9h30 < 10h", code: "CREW_REST" }, selectable: false });

  const page = parse(renderToStaticMarkup(<RecoveryView {...viewProps(data)} />)), tabs = [...page.querySelectorAll(".plan-tab")];
  assert.deepEqual(tabs.map(node => node.getAttribute("data-plan")), featured.map(row => row.id)); assert.equal(tabs.length, 3);
  for (const tab of tabs) assert.deepEqual([...tab.querySelectorAll(".plan-chips.primary .plan-chip")].map(node => node.getAttribute("data-chip")), ["doors", "cost", "people"]);
  const diagnostic = tabs.find(node => node.getAttribute("data-diagnostic") === "red")!; assert.ok(diagnostic, "the rejected family stays in the comparison");
  assert.equal(diagnostic.querySelectorAll('[data-chip="diagnostic"]').length, 1); assert.equal(diagnostic.querySelectorAll('[data-chip="approval"]').length, 0); assert.equal(diagnostic.querySelector(".plan-chip.red")!.textContent, "Crew rest 9h30 < 10h");
  assert.deepEqual([...diagnostic.querySelectorAll("button")].map(node => node.getAttribute("role")), ["radio"], "preview only: no select action"); assert.match(diagnostic.textContent!, /has no select action/);
  const selectable = tabs.filter(node => !node.hasAttribute("data-diagnostic")); assert.equal(selectable.length, 2);
  for (const tab of selectable) { assert.ok(tab.querySelectorAll('.plan-chip.amber[data-chip="approval"]').length >= 3); assert.equal(tab.querySelectorAll('[data-chip="diagnostic"]').length, 0); assert.equal(tab.querySelectorAll("button.button").length, 1); }
  assert.match(selectable[0]!.querySelector("button.button")!.textContent!, /Review commitments/);
  const rail = page.querySelector(".recovery-rail")!; assert.ok(rail.querySelector(".candidate-funnel")); assert.equal(rail.querySelectorAll(".offer-card").length, 3); assert.match(rail.querySelector(".exposure-compare")!.textContent!, /Review commitments/); assert.doesNotMatch(rail.querySelector(".exposure-compare")!.textContent!, /profit protected/i);
  assert.equal(page.querySelector(".ghost-lane.empty")!.getAttribute("role"), "status");
});

test("rejected-family card names the family, its representative and rule evidence, and holds the engine report", () => {
  const { show } = withRun(), candidates = show.runs.at(-1)!.candidates, families = rejectedFamilies(show, candidates);
  assert.deepEqual(families.map(row => [row.key, row.name, row.size]), [["artist", "Protect artist", 3], ["direct", "Keep original calls", 3]]);
  for (const family of families) assert.ok(candidates.filter(row => row.family === family.key).every(row => row.report.status === "infeasible"));
  const card = parse(renderToStaticMarkup(<RejectedFamilyCard family={families[0]!} supplier="Brightline Rentals" />)), details = card.querySelector("details")!;
  assert.equal(details.hasAttribute("open"), false, "collapsed by default"); assert.match(details.querySelector("summary")!.textContent!, /Rejected family · Protect artist/); assert.match(details.textContent!, new RegExp(families[0]!.representative.id)); assert.match(details.textContent!, /Crew rest/);
  assert.match(details.querySelector(".engine-report")!.textContent!, /bryntum-gantt-enterprise 8\.0\.0/); assert.match(details.querySelector(".engine-report")!.textContent!, /passed/);
});

function GhostHarness({ show, candidates }: { show: ShowSnapshot; candidates: Candidate[] }) { const state = useSupplierGhost(show, candidates), id = useId(); return <><GhostLane id={id} preview={state.ghost} pinned={Boolean(state.pinned && state.pinned === state.active)} /><SupplierOfferCards show={show} candidates={candidates} state={state} describedBy={id} /></>; }
test("a supplier offer previews its ghost delivery and doors consequence on focus, hover and select without changing the plan", async () => {
  const { show } = withRun(), candidates = show.runs.at(-1)!.candidates, before = JSON.stringify(show);
  const north = supplierGhostPreview(show, "offer-northside-1", candidates)!, bright = supplierGhostPreview(show, "offer-brightline-1", candidates)!, sister = supplierGhostPreview(show, "offer-sister-1", candidates)!;
  assert.equal(north.headline, "Northside AV: delivery 18:40"); assert.match(north.consequence, /^Doors 20:05 \+65 min · Protect budget \(validated candidate\)$/); assert.equal(north.doorsDeltaMinutes, 65); assert.equal(north.ranges[0]!.id, "presentation-offer:offer-northside-1"); assert.equal(north.ranges.length, 3);
  assert.match(bright.consequence, /^Doors 19:00 ±0 · Protect doors \(validated candidate\)$/); assert.match(sister.consequence, /evidence missing/); assert.equal(supplierGhostPreview(show, "unknown-offer", candidates), null);
  assert.match(supplierGhostPreview(show, "offer-northside-1", [])!.consequence, /No saved candidate evaluated this offer revision/, "no stored candidate, no inferred doors time");

  await render(<GhostHarness show={show} candidates={candidates} />);
  const lane = () => container.querySelector(".ghost-lane")!, card = (id: string) => container.querySelector<HTMLButtonElement>(`.offer-card[data-offer="${id}"]`)!;
  assert.ok(lane().classList.contains("empty")); assert.equal(card("offer-northside-1").getAttribute("aria-describedby"), lane().id);
  await act(async () => card("offer-northside-1").focus());
  assert.match(lane().textContent!, /Northside AV: delivery 18:40/); assert.match(lane().textContent!, /Doors 20:05 \+65 min/); assert.equal(lane().getAttribute("data-pinned"), "false"); assert.equal(card("offer-northside-1").getAttribute("aria-pressed"), "false");
  await act(async () => card("offer-northside-1").blur()); assert.ok(lane().classList.contains("empty"), "focus preview ends with focus");
  await act(async () => { card("offer-northside-1").focus(); card("offer-northside-1").click(); });
  assert.equal(card("offer-northside-1").getAttribute("aria-pressed"), "true"); await act(async () => card("offer-northside-1").blur()); assert.match(lane().textContent!, /Doors 20:05 \+65 min/, "a selected preview persists"); assert.equal(lane().getAttribute("data-pinned"), "true");
  await act(async () => card("offer-brightline-1").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))); assert.match(lane().textContent!, /Brightline Rentals: delivery 17:15/); assert.match(lane().textContent!, /Doors 19:00 ±0/);
  await act(async () => card("offer-brightline-1").dispatchEvent(new MouseEvent("mouseout", { bubbles: true }))); assert.match(lane().textContent!, /Northside AV: delivery 18:40/, "hover is only a shortcut over the selected preview");
  assert.match(lane().textContent!, /ACTIVE PLAN UNCHANGED/); assert.equal(JSON.stringify(show), before, "the stored production is untouched");
});

test("GO staging cannot enter GO without a verified recorded GO for the current report", async () => {
  const fill = crewData(crewReady(2)); assert.deepEqual([goStagingModel(fill).stage, goStagingModel(fill).bar], ["fill", null]);
  assert.equal(goStagingModel(fill).items.at(-1)!.id, "crew"); assert.equal(goStagingModel(fill).items.at(-1)!.word, "9/11 acknowledged"); assert.equal(goStagingModel(fill).items.filter(row => !row.complete).length, 1, "crew is the only amber item left");
  const readyShow = crewReady(), standby = crewData(readyShow); assert.deepEqual([goStagingModel(standby).stage, goStagingModel(standby).bar], ["standby", "STANDBY — DOORS 19:00"]);

  const forged = structuredClone(standby); forged.show.state = "go"; forged.show.goReportId = "a".repeat(64);
  assert.equal(goStagingModel(forged).stage, "standby", "a state flag without its recorded cue is not a GO");
  const called = crewData(crewCue(readyShow, "sam", "DOORS_GO")), go = goStagingModel(called);
  assert.deepEqual([go.stage, go.bar], ["go", "GO — DOORS 19:00"]); assert.ok(go.cue); assert.ok(header(called).querySelector(".cue-badge.green"), "the header cue light is green only now");
  const moved = structuredClone(called); moved.show.revision++; assert.equal(goStagingModel(moved).stage, "unread", "a GO against an older report is not presented");
  const withdrawn = structuredClone(called); doors(withdrawn).gates[0]!.complete = false; doors(withdrawn).ready = false; assert.equal(goStagingModel(withdrawn).stage, "fill", "a withdrawn gate withdraws the GO state");
  assert.equal(header(withdrawn).querySelector(".cue-badge.green"), null);

  motion.reduced = true;
  await render(<GoStaging data={fill} />); let section = container.querySelector(".go-staging")!;
  assert.deepEqual([section.getAttribute("data-stage"), section.getAttribute("data-staged"), section.getAttribute("data-collapsed")], ["fill", "true", "false"], "reduced motion skips the read-through");
  assert.deepEqual([...section.querySelectorAll(".go-stack li")].map(node => [node.getAttribute("data-gate"), node.getAttribute("data-clear"), node.querySelector(".go-state")!.textContent]), doors(fill).gates.map(row => [row.id, String(row.complete), row.complete ? "Clear" : "Pending"]), "fixed report order with the words kept");
  assert.equal(section.querySelector(".go-bar"), null); assert.match(section.querySelector(".go-headliner-chip.amber")!.textContent!, /^HEADLINER_START · on site 19:35 expected$/);
  await render(<GoStaging data={standby} />); section = container.querySelector(".go-staging")!;
  assert.equal(section.getAttribute("data-collapsed"), "true"); assert.equal(section.querySelector(".go-bar strong")!.textContent, "STANDBY — DOORS 19:00"); assert.equal(section.querySelector(".go-bar.go"), null); assert.equal(section.querySelector(".go-bar a")!.getAttribute("href"), "/execution#cue-execution"); assert.equal(section.querySelector(".go-stack-wrap")!.hasAttribute("inert"), true);
  await render(<GoStaging data={forged} />); assert.equal(container.querySelector(".go-bar.go"), null); assert.equal(container.querySelector(".go-bar strong")!.textContent, "STANDBY — DOORS 19:00");
  await render(<GoStaging data={called} />); section = container.querySelector(".go-staging")!;
  assert.equal(section.querySelector(".go-bar.go strong")!.textContent, "GO — DOORS 19:00"); assert.ok(section.querySelector(".go-headliner-chip.amber"), "the separate headliner gate stays amber beside the GO bar"); assert.match(section.querySelector(".go-bar")!.textContent!, /GO recorded/);
});

test("with motion the cue stack reads through in order before it collapses, and a pending item never fills", async () => {
  const fill = crewData(crewReady(2));
  await render(<GoStaging data={fill} />); const section = container.querySelector(".go-staging")!;
  assert.equal(section.getAttribute("data-staged"), "false"); assert.equal(section.getAttribute("data-collapsed"), "false");
  assert.deepEqual([...section.querySelectorAll<HTMLElement>(".go-stack li")].map(node => node.style.getPropertyValue("--cue-index")), doors(fill).gates.map((_, index) => String(index)));
  assert.equal(section.querySelector('.go-stack li[data-gate="crew"]')!.getAttribute("data-clear"), "false");
  if (root) await act(async () => root!.unmount()); root = null;
  const standby = crewData(crewReady()); await render(<GoStaging data={standby} />);
  assert.equal(container.querySelector(".go-staging")!.getAttribute("data-collapsed"), "false", "the stack is read before the single bar appears"); assert.equal(container.querySelector(".go-bar"), null);
});

test("evidence room no longer describes implemented native AI and voice as pending integration work", () => {
  const html = renderToStaticMarkup(<EvidenceView {...viewProps(crewData(crewReady()))} />);
  assert.doesNotMatch(html, /QUALIFICATION PENDING|remain required integration work/); assert.match(html, /IMPLEMENTED · BOUNDED/); assert.match(html, /General model quality across the full incident set is unmeasured/);
});
