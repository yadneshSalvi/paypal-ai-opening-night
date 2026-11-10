import test from "node:test";
import assert from "node:assert/strict";
import { generateCandidates, commitEngine } from "../src/server/engine";
import { buildCandidate } from "../src/domain/scheduling";
import { localTime } from "../src/domain/time";
import { disrupted } from "./helpers";
test("actual Node engine validates both feasible showcase strategies", async () => { const { show } = disrupted(); const doors = buildCandidate(show, show.offers[0], "doors"); const budget = buildCandidate(show, show.offers[1], "budget"); const [a, b] = await Promise.all([commitEngine(doors), commitEngine(budget)]); assert.equal(a.status, "passed", a.reason ?? ""); assert.equal(b.status, "passed", b.reason ?? ""); assert.equal(localTime(a.dates.find(d => d.id === "lx-focus")!.start), "17:30"); assert.equal(localTime(b.dates.find(d => d.id === "headliner")!.end), "22:25"); assert.equal(a.dates.length, doors.patch.tasks.length); });
test("actual engine rejects inconsistent direct fix", async () => { const { show } = disrupted(); const report = await commitEngine(buildCandidate(show, show.offers[0], "direct")); assert.equal(report.status, "rejected"); assert.match(report.reason ?? "", /moved|rejected/); });
test("clone commits preserve canonical show and published baseline", async () => { const { show } = disrupted(); const before = JSON.stringify(show); const candidates = await generateCandidates(show); assert.equal(candidates.length, 12); assert.ok(candidates.every(c => c.report.engine && c.report.engine.status !== "unavailable")); assert.equal(JSON.stringify(show), before); assert.equal(candidates.find(c => c.family === "artist")?.report.status, "infeasible"); });
