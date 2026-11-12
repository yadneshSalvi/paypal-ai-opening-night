/**
 * The fixture show is dated 2026-11-14 and carries its own scenario clock. A rehearsal opened on any later real day
 * must behave exactly like one opened before the show: the wall clock stamps records and bounds real-time
 * authorities, and it never decides whether the fixture plan is feasible, approvable or ready.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand, commandEnvelope } from "../src/domain/commands";
import { readiness } from "../src/domain/readiness";
import type { ShowSnapshot } from "../src/domain/contracts";
import { approved, base, publishForTest, withRun } from "./helpers";
import { exitCode, licenseStatements, licenseVerdict, parseArguments, sessionCookie } from "../scripts/ops/judge-path-check.mjs";

const RealDate = Date;
/** Runs synchronous domain work with `new Date()` and `Date.now()` moved to the given instant. */
function atWallClock<T>(instant: string, work: () => T): T {
  const offset = RealDate.parse(instant) - RealDate.now();
  class ShiftedDate extends RealDate {
    constructor(...values: unknown[]) { if (values.length) super(...(values as [number])); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
  try { return work(); } finally { globalThis.Date = RealDate; }
}
const advances = (commandEnvelope.shape.command.options.find(option => option.shape.type.value === "advance")!.shape as unknown as { time: { options: string[] } }).time.options;
const gates = (show: ShowSnapshot) => (["DOORS", "HEADLINER_START"] as const).map(scope => { const report = readiness(show, scope); return { scope, ready: report.ready, gates: report.gates.map(gate => `${gate.label}:${gate.complete}`) }; });

function journey() {
  const opened = base().show, run = withRun().show, plan = approved(), published = publishForTest();
  const candidates = run.runs[0]!.candidates.map(candidate => ({ id: candidate.id, status: candidate.report.status, issues: candidate.report.issues.map(issue => issue.code).sort(), doorsAt: candidate.patch.doorsAt, cost: candidate.cost.totalMinor }));
  let show = plan.show; const clocks: string[] = [];
  for (const time of advances) { show = applyCommand(show, plan.actor, { type: "advance", time } as never); clocks.push(show.clock); }
  return {
    outcome: { showDate: opened.showDate, openingClock: opened.clock, doorsAt: opened.doorsAt, curfewAt: opened.curfewAt, accessUntil: opened.accessUntil, tasks: opened.tasks.length, candidates, approvedCandidate: plan.show.approvedPlan!.candidateId, approvedDoors: plan.show.doorsAt, clocks, state: show.state, afterAdvance: gates(show), sheetVersion: published.show.sheets.at(-1)!.version, afterPublish: gates(published.show) },
    stamps: { createdAt: opened.createdAt, approvedAt: plan.show.approvedPlan!.approvedAt, lastEventAt: show.events.at(-1)!.at, lastEventFixtureAt: show.events.at(-1)!.fixtureAt },
  };
}

test("a rehearsal opened long after the fixture show date plans, approves, publishes and advances identically", () => {
  const reference = atWallClock("2026-11-13T12:00:00Z", journey);
  assert.equal(reference.outcome.showDate, "2026-11-14"); assert.equal(reference.outcome.tasks, 82);
  assert.ok(reference.outcome.candidates.some(candidate => candidate.status.startsWith("feasible")), "the reference rehearsal must have an approvable plan");
  for (const instant of ["2026-11-14T23:30:00Z", "2026-11-15T12:00:00Z", "2026-12-30T18:00:00Z", "2026-12-31T23:59:00Z", "2027-06-01T00:00:00Z"]) {
    const later = atWallClock(instant, journey);
    assert.deepEqual(later.outcome, reference.outcome, `outcome changed for a rehearsal opened at ${instant}`);
    // Records are stamped with the real day; the scenario stays on its own labeled clock.
    for (const stamp of [later.stamps.createdAt, later.stamps.approvedAt, later.stamps.lastEventAt]) assert.ok(Math.abs(Date.parse(stamp) - Date.parse(instant)) < 60_000, `${stamp} should be the wall clock ${instant}`);
    assert.equal(later.stamps.lastEventFixtureAt.slice(0, 10) <= "2026-11-15", true);
    assert.equal(later.stamps.lastEventFixtureAt, reference.stamps.lastEventFixtureAt);
  }
});

test("the shifted clock is restored after each journey", () => { atWallClock("2026-12-30T18:00:00Z", () => undefined); assert.equal(Date, RealDate); assert.ok(Math.abs(Date.now() - RealDate.now()) < 1000); });

// The owner's hosted check reads only the signed, non-secret statement of the scheduling license from the page.
const statement = (payload: object) => `{\\"licenseKey\\":\\"${Buffer.from(JSON.stringify(payload)).toString("base64")}.${Buffer.from("signature-bytes").toString("base64")}\\"}`;
test("the hosted check reads a license statement without returning the key and judges its end date", () => {
  const page = statement({ v: 1, id: "private-id", type: "trial", products: { enterprise: ["gantt"] }, supportEnd: "2026-12-25", licenseEnd: "2026-12-25" });
  const found = licenseStatements(page + page);
  assert.deepEqual(found, [{ type: "trial", licenseEnd: "2026-12-25", supportEnd: "2026-12-25" }]);
  assert.doesNotMatch(JSON.stringify(found), /private-id|signature/);
  assert.equal(licenseVerdict(found[0], Date.parse("2026-11-13T00:00:00Z"), "2026-12-31").level, "warn");
  assert.equal(licenseVerdict(found[0], Date.parse("2026-11-13T00:00:00Z"), "2026-12-20").level, "pass");
  assert.equal(licenseVerdict(found[0], Date.parse("2026-12-25T23:00:00Z"), "2026-12-31").level, "warn");
  assert.equal(licenseVerdict(found[0], Date.parse("2026-12-27T00:00:00Z"), "2026-12-31").level, "fail");
  assert.equal(licenseVerdict({ type: "eul", licenseEnd: null, supportEnd: "2027-09-14" }, Date.parse("2027-01-01T00:00:00Z"), "2026-12-31").level, "pass");
  assert.equal(licenseVerdict({ type: "trial", licenseEnd: null, supportEnd: null }, 0, "2026-12-31").level, "fail");
  assert.equal(licenseVerdict(null, 0, "2026-12-31").level, "warn");
  assert.deepEqual(licenseStatements("<html>no key here</html>"), []);
});
test("the hosted check parses its options, the session cookie and its exit code", () => {
  assert.deepEqual(parseArguments([]), { base: "https://paypal-ai-opening-night.vercel.app", until: "2026-12-31", createSession: false, json: false, strict: false, timeoutMs: 30000 });
  assert.equal(parseArguments(["--base", "http://localhost:4105/", "--create-session"]).base, "http://localhost:4105");
  assert.equal(parseArguments(["--create-session"]).createSession, true);
  assert.throws(() => parseArguments(["--base", "localhost"]), /origin/); assert.throws(() => parseArguments(["--until", "soon"]), /date/); assert.throws(() => parseArguments(["--delete-everything"]), /Unknown/);
  assert.deepEqual(sessionCookie(["other=1; Path=/", "opening-night-session=abc; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=lax"]), { value: "abc", maxAge: 604800, httpOnly: true, secure: true, sameSite: "lax" });
  assert.equal(sessionCookie(["other=1"]), null);
  assert.equal(exitCode([{ level: "pass" }, { level: "warn" }, { level: "skip" }], false), 0); assert.equal(exitCode([{ level: "warn" }], true), 1); assert.equal(exitCode([{ level: "pass" }, { level: "fail" }], false), 1);
});
