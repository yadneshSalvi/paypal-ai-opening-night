/** Explicitly synthetic component snapshots. No service, DB or provider claims. */
import { randomUUID } from "node:crypto";
import type { ConsoleData, ReadinessReport } from "../src/domain/contracts";
import { createFixture } from "../src/domain/fixture";
import { readiness } from "../src/domain/readiness";
import type { CrewCueExecution, CrewRecordSummary } from "../src/domain/crew/contracts";
import { atVenue } from "../src/domain/time";

export function presentationFixture(): ConsoleData {
  const tenantId = randomUUID(), show = createFixture(tenantId, "2026-11-12T12:00:00.000Z");
  show.title = "Controlled presentation snapshot"; show.venue = "Synthetic test room"; show.crewProtocol = 1; show.crewCues = [];
  return { show, readiness: (["DOORS", "SUPPORT_START", "HEADLINER_START"] as const).map(scope => readiness(show, scope)), currentActor: { id: "producer:" + randomUUID(), tenantId, roles: ["producer", "stage_manager"], personId: "sam" }, serverAt: "2026-11-12T12:00:00.000Z", controlledQa: true, crew: { protocol: 1, duties: [], cues: [], history: [], legacyFactCount: 0 } };
}
export function withSyntheticGo(input: ConsoleData, id = randomUUID()): ConsoleData {
  const data = structuredClone(input), show = data.show, sheet = show.sheets.at(-1)!;
  show.revision++; show.state = "go"; show.goReportId = "a".repeat(64); show.clock = atVenue("18:45");
  data.serverAt = "2026-11-12T12:01:00.000Z";
  data.readiness = data.readiness.map(report => ({ ...report, revision: show.revision, ready: report.scope === "DOORS", gates: report.gates.map(gate => ({ ...gate, complete: report.scope === "DOORS" })), blockers: report.scope === "DOORS" ? [] : report.blockers }));
  const raw: CrewCueExecution = { protocol: 1, id, commandId: randomUUID(), tenantId: show.tenantId, showId: show.id, actorId: "crew:sam:controlled-component", personId: "sam", recordedAt: data.serverAt, fixtureAt: show.clock, revision: show.revision, source: "controlled_client", detail: "Synthetic component input, not an actual operational cue", planVersion: show.planVersion, planDigest: "b".repeat(64), sheetVersion: sheet.version, sheetDigest: sheet.digest, policyVersion: show.policy.version, type: "cue", kind: "DOORS_GO", reportId: show.goReportId, precedingCueId: null, signature: "test-only-not-a-valid-server-signature" };
  const summary: CrewRecordSummary = { id, commandId: raw.commandId, type: "cue", kind: "DOORS_GO", personId: "sam", personName: "Synthetic stage manager", actorId: raw.actorId, detail: raw.detail, recordedAt: raw.recordedAt, fixtureAt: raw.fixtureAt, planVersion: raw.planVersion, sheetVersion: raw.sheetVersion, sheetDigest: raw.sheetDigest, status: "current", signatureFingerprint: "c".repeat(64) };
  show.crewCues = [raw]; data.crew!.cues = [{ kind: "DOORS_GO", title: "Controlled cue", personIds: ["sam"], record: summary }];
  return data;
}
export function revise(input: ConsoleData, update?: (data: ConsoleData) => void): ConsoleData {
  const data = structuredClone(input); data.show.revision++; data.serverAt = new Date(Date.parse(input.serverAt) + 1000).toISOString();
  data.readiness.forEach((report: ReadinessReport) => { report.revision = data.show.revision; }); update?.(data); return data;
}
