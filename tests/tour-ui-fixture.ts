import { randomUUID } from "node:crypto";
import { touringTemplate, sampleVenue, sampleTourDraft } from "../src/domain/tour/fixture";
import { instantiate, recordDigest, obligationDigest } from "../src/domain/tour/templates";
import { evaluateTour } from "../src/domain/tour/constraints";
import type { PersonalTour, ProductionTemplate, Tour, TourWorkspace } from "../src/domain/tour/contracts";

/** Declared synthetic inputs for component tests; no model, provider or human decisions. */
export function tourUiFixture() {
  const at = "2026-11-12T08:00:00.000Z";
  const template: ProductionTemplate = {
    id: randomUUID(), kind: "template", revision: 1, digest: "", archived: false,
    createdAt: at, updatedAt: at, actorId: "synthetic-producer", reason: "Controlled component fixture",
    spec: touringTemplate(), origin: "synthetic_fixture", compilerBinding: null,
  };
  template.digest = recordDigest(template);
  const productions = [
    ["Denver", "Lantern Theatre", "2026-11-20", "America/Denver"],
    ["Omaha", "Prairie Rooms", "2026-11-22", "America/Chicago"],
    ["Chicago", "Mercury Hall", "2026-11-23", "America/Chicago"],
  ].map(([city, venue, date, zone]) => instantiate(template, randomUUID(), `The Night Ferries · ${city}`, date!, sampleVenue(venue!, city!, date!, zone!), "synthetic-producer", at));
  for (const production of productions) {
    production.allocations = { "stage-manager": "sam", "lighting-programmer": "priya", "lighting-tech": "tom", console: "tour-console" };
    production.digest = recordDigest(production);
  }
  const tour: Tour = { ...sampleTourDraft(productions), id: randomUUID(), kind: "tour", revision: 1, digest: "", archived: false, createdAt: at, updatedAt: at, actorId: "synthetic-producer", reason: "Controlled component fixture" };
  tour.digest = recordDigest(tour);
  const data: TourWorkspace = {
    tenantId: randomUUID(), actorId: "synthetic-producer", sessionFingerprint: "a".repeat(64), expiresAt: "2026-12-31T00:00:00.000Z",
    templates: [template], productions, tours: [tour], reports: { [tour.id]: evaluateTour(tour, productions) },
    readbacks: [], comparisons: [], swaps: [], acknowledgments: [], roster: tour.resources.filter(value => value.kind === "person").map(value => ({ id: value.id, name: value.label, skills: value.skills })), history: [], controlled: true,
  };
  const personal: PersonalTour = {
    tenantId: data.tenantId, actorId: "crew:tom:synthetic", sessionFingerprint: "b".repeat(64), person: { id: "tom", name: "Tom" }, expiresAt: data.expiresAt,
    calls: productions.map(production => {
      const call = production.calls.find(value => value.id === "line-check")!;
      return { productionId: production.id, productionName: production.name, venue: production.venue.name, zone: production.venue.zone, productionRevision: production.revision, call, obligationDigest: obligationDigest(production, call, "tom"), acknowledged: false, resourceId: "tom", tourId: tour.id, tourRevision: tour.revision };
    }),
    rests: [], swaps: [], colleagues: [{ id: "priya", name: "Priya", tourId: tour.id }], history: [], controlled: true,
  };
  return { template, productions, tour, data, personal };
}
