import type { Actor, ShowSnapshot, Ticket } from "../contracts";
import { createFixture, consoleIncident, flightIncident } from "../fixture";
import { atVenue } from "../time";
import { touringTemplate, sampleVenue, sampleTourDraft, sampleAlternatives, sampleTime, syntheticSource } from "../tour/fixture";
import { instantiate, recordDigest } from "../tour/templates";
import { candidatePlan } from "../tour/constraints";
import type { PlannedProduction, ProductionTemplate, Tour, TourResource } from "../tour/contracts";

export const FIXTURE_NOW = "2026-11-12T06:00:00.000Z";
/** Stable computational identities. They never refer to database/session/admission records. */
export function fixtureId(index: number): string { return `eeeeeeee-0000-4000-8000-${String(index).padStart(12, "0")}`; }
export function singleFixture(): { show: ShowSnapshot; actor: Actor } {
  // createFixture uses shared CREW declarations; clone before any adversarial mutation.
  const show = structuredClone(createFixture("evaluation-only:alder-v1", FIXTURE_NOW));
  show.incidents = [flightIncident(), consoleIncident()];
  return { show, actor: { id: "evaluation:producer", tenantId: show.tenantId, roles: ["producer"], personId: null } };
}
export function reservedTickets(count = 400): Ticket[] {
  return Array.from({ length: count }, (_, index) => ({ id: `computational-pending-${index + 1}`, tier: index % 2 ? "standard" : "vip", admissionMinor: 3500, perkMinor: index % 2 ? 0 : 1500, captureId: null, source: "sample", refundedMinor: 0, status: "reserved" }));
}
export function tourFixture(alternative: "early" | "morning" | "transfer" | "rail" = "morning") {
  const template: ProductionTemplate = { id: fixtureId(1), kind: "template", revision: 1, digest: "", archived: false, createdAt: FIXTURE_NOW, updatedAt: FIXTURE_NOW, actorId: "evaluation:producer", reason: "Fresh synthetic evaluation input; no human approval", spec: touringTemplate(), origin: "synthetic_fixture", compilerBinding: null };
  template.digest = recordDigest(template);
  const stops = [["Denver", "Lantern Theatre", "2026-11-20", "America/Denver"], ["Omaha", "Prairie Rooms", "2026-11-22", "America/Chicago"], ["Chicago", "Mercury Hall", "2026-11-23", "America/Chicago"]] as const;
  const productions = stops.map(([city, venue, date, zone], index) => instantiate(template, fixtureId(10 + index), `Computational Night Ferries · ${city}`, date, sampleVenue(venue, city, date, zone), "evaluation:producer", FIXTURE_NOW));
  for (const production of productions) { production.allocations = { "stage-manager": "sam", "lighting-programmer": "priya", "lighting-tech": "tom", console: "tour-console" }; production.digest = recordDigest(production); }
  const tour: Tour = { ...sampleTourDraft(productions), id: fixtureId(2), kind: "tour", revision: 1, digest: "", archived: false, createdAt: FIXTURE_NOW, updatedAt: FIXTURE_NOW, actorId: "evaluation:producer", reason: "Synthetic planning fixture; no booking or real availability" };
  tour.digest = recordDigest(tour);
  const choice = { early: 0, morning: 1, transfer: 2, rail: 3 }[alternative];
  const next = candidatePlan(tour, productions, sampleAlternatives(tour)[choice]!);
  return { template, ...next };
}

/** Larger computational tour:30 calls/show,100 modeled resources,explicit two-day gaps and road paths. */
export function scalingTour(showCount: number) {
  if (![3, 10, 30].includes(showCount)) throw new Error("Only frozen tour sizes are supported");
  const sourceIds = ["fixture-rider"];
  const spec = touringTemplate();
  spec.name = "Computational portfolio throughput fixture";
  spec.slots = Array.from({ length: 100 }, (_, index) => ({ id: `slot-${index}`, label: `Modeled ${index < 20 ? "crew" : "equipment"} ${index}`, kind: index < 20 ? "person" : "equipment", skills: [], capacity: 1, sourceIds }));
  spec.calls = Array.from({ length: 30 }, (_, index) => ({ id: `call-${index}`, label: `Computational call ${index + 1}`, lane: "stage", dayOffset: 0, localTime: `${String(8 + Math.floor(index / 3)).padStart(2, "0")}:${String(index % 3 * 20).padStart(2, "0")}`, durationMinutes: 15, slotIds: [0, 25, 50, 75].map(offset => `slot-${(index + offset) % 100}`), requiredSkills: [], amplified: index === 29, sourceIds }));
  spec.dependencies = spec.calls.slice(1).map((call, index) => ({ id: `edge-${index}`, from: spec.calls[index]!.id, to: call.id, lagMinutes: 5, sourceIds }));
  spec.stage = { width: null, depth: null, units: "normalized", status: "illustrative", sourceIds, pins: [] };
  spec.minimumRestMinutes = 600; spec.maxDutyMinutes = 1440;
  const template: ProductionTemplate = { id: fixtureId(100), kind: "template", revision: 1, digest: "", archived: false, createdAt: FIXTURE_NOW, updatedAt: FIXTURE_NOW, actorId: "evaluation:producer", reason: "Computational scaling only", spec, origin: "synthetic_fixture", compilerBinding: null };
  template.digest = recordDigest(template);
  const zoneCycle = ["America/Denver", "America/Chicago", "America/New_York"];
  const productions: PlannedProduction[] = Array.from({ length: showCount }, (_, index) => {
    const date = new Date(Date.UTC(2026, 10, 20 + index * 2)).toISOString().slice(0, 10), zone = zoneCycle[index % zoneCycle.length]!;
    const production = instantiate(template, fixtureId(200 + index), `Computational stop ${index + 1}`, date, sampleVenue(`Modeled venue ${index + 1}`, `Modeled city ${index + 1}`, date, zone), "evaluation:producer", FIXTURE_NOW);
    production.allocations = Object.fromEntries(spec.slots.map((slot, slotIndex) => [slot.id, `resource-${slotIndex}`]));
    production.digest = recordDigest(production); return production;
  });
  const resources: TourResource[] = spec.slots.map((slot, index) => ({ id: `resource-${index}`, label: `Synthetic computational ${slot.kind} ${index}`, kind: slot.kind, personId: slot.kind === "person" ? `synthetic-computational-person-${index}` : null, skills: [], capacity: 1, availability: [{ start: sampleTime("2026-11-19", "00:00", "UTC"), end: sampleTime("2027-02-01", "00:00", "UTC") }], availabilityStatus: "reviewed", forecastHourlyMinor: slot.kind === "person" ? 3500 : null, sourceIds: ["fixture-route"] }));
  const legs = productions.slice(1).map((next, index) => {
    const prior = productions[index]!, date = new Date(Date.parse(`${prior.showDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    return { id: `road-${index}`, label: "Declared computational road move; not a carrier quote", fromProductionId: prior.id, toProductionId: next.id, resourceIds: resources.map(resource => resource.id), departure: sampleTime(date, "09:00", prior.venue.zone), durationMinutes: 180, loadingMinutes: 30, unloadingMinutes: 30, mode: "road" as const, status: "reviewed" as const, forecastCostMinor: 10000, sourceIds: ["fixture-route"] };
  });
  const tour: Tour = { id: fixtureId(101), kind: "tour", revision: 1, digest: "", archived: false, createdAt: FIXTURE_NOW, updatedAt: FIXTURE_NOW, actorId: "evaluation:producer", reason: "Synthetic throughput inputs,not admitted operational authority", name: `${showCount}-show computational portfolio`, productionIds: productions.map(production => production.id), resources, legs, sources: [syntheticSource("fixture-route", "Declared computational resource and travel inputs")], minimumRestMinutes: 600, maxDutyMinutes: 1440 };
  tour.digest = recordDigest(tour); return { tour, productions };
}
export const fixtureDoorsClock = () => atVenue("19:00");
