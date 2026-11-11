import { randomUUID } from "node:crypto";
import type { ShowSnapshot } from "../src/domain/contracts";
import { digest } from "../src/domain/hash";
import { sourceParserVersion, type CompiledGraph, type SourceDocument, type SourceExtraction, type SourceFact } from "../src/domain/sources";

/** Owned fictional input for controlled parser/provider tests; no provider or human outcome is represented. */
export const sourceExample = [
  "Production: The Night Ferries. Venue: Alder Hall. Show date: 2026-11-14. Time zone: America/Chicago.",
  "Lighting paperwork review: Priya Shah reviews the patch notes from 2026-11-14T16:40:00-06:00 for 20 minutes. Department: lighting. Required skill: lx_programming. No amplified audio.",
  "Priya Shah is a person in the lighting department. Skills: lx_programming, lx_focus, rigging. Available 2026-11-14T10:00:00-06:00 through 2026-11-15T00:45:00-06:00. Capacity: one. Hourly rate: USD 35.00.",
  "Hard amplified audio curfew: 2026-11-14T23:00:00-06:00. Venue access ends 2026-11-15T00:45:00-06:00. Minimum rest before the next confirmed call: 600 minutes.",
  "The paperwork call may start no earlier than 2026-11-14T16:35:00-06:00 and must finish by 2026-11-14T17:15:00-06:00.",
].join("\n");
export function sourceFixture(show: ShowSnapshot, id = randomUUID()) {
  let offset = 0;
  const extraction: SourceExtraction = { parserVersion: sourceParserVersion, units: sourceExample.split("\n").map((line, index) => { const start = offset; offset += line.length + 1; return { id: `line:${index + 1}`, text: line, locator: { kind: "text" as const, line: index + 1, start, end: start + line.length }, caution: null }; }), notices: [], pageCount: 0, sheetCount: 0 };
  const source: SourceDocument = { id, familyId: randomUUID(), version: 1, title: "Lighting addendum", filename: "lighting-addendum.txt", role: "rider", rights: { basis: "owned", owner: "Opening Night fixture", note: "Owned fictional test source" }, kind: "text", mediaType: "text/plain", byteLength: Buffer.byteLength(sourceExample), contentHash: digest(sourceExample), extractionDigest: digest(extraction), state: "ready", current: true, createdAt: new Date().toISOString(), deletedAt: null, extraction };
  const fact = <T>(value: T, line = 1): SourceFact<T> => ({ value, citations: [{ sourceId: id, unitId: `line:${line}`, quote: extraction.units[line - 1]!.text }], assumption: null });
  const graph: CompiledGraph = {
    schemaVersion: 1, summary: "Add a sourced lighting paperwork call between existing programming and the next scheduled work.",
    production: { title: fact(show.title), venue: fact(show.venue), zone: fact(show.zone), showDate: fact(show.showDate) },
    policy: { curfewAt: fact(show.curfewAt, 4), accessUntil: fact(show.accessUntil, 4), minimumRestMinutes: fact(show.policy.minimumRestMinutes, 4) },
    resources: [{ key: "priya", targetId: "priya", name: fact("Priya Shah", 3), kind: fact("person", 3), department: fact("lighting", 3), skills: fact(["lx_programming", "lx_focus", "rigging"], 3), availableFrom: fact(show.resources.find(item => item.id === "priya")!.availableFrom, 3), availableUntil: fact(show.resources.find(item => item.id === "priya")!.availableUntil, 3), capacity: fact(1, 3), hourlyRateMinor: fact(3500, 3) }],
    tasks: [{ key: "paperwork", targetId: null, name: fact("Lighting paperwork review", 2), lane: fact("lighting", 2), start: fact("2026-11-14T16:40:00-06:00", 2), durationMinutes: fact(20, 2), resources: fact(["priya"], 2), requiredSkill: fact("lx_programming", 2), amplified: fact(false, 2), earliestStart: fact("2026-11-14T16:35:00-06:00", 5), latestEnd: fact("2026-11-14T17:15:00-06:00", 5) }],
    dependencies: [], unknowns: [], conflicts: [], unsupportedRequirements: [],
  };
  return { source, graph, fact };
}
