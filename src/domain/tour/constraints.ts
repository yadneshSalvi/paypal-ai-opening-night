import { DomainError } from "../contracts";
import { digest } from "../hash";
import type { CandidateInput, ConstraintFinding, PlannedProduction, Tour, TourDraft, TourReport, RestResult, TravelLeg } from "./contracts";
import { assertUnique, resourcesForCall } from "./templates";
import { intervalOverlap, minutesBetween, plusMinutes, zoned } from "./time";

export function finding(code: string, severity: ConstraintFinding["severity"], message: string, productionIds: string[] = [], callIds: string[] = [], resourceIds: string[] = [], sourceIds: string[] = []): ConstraintFinding { return { id: `${code}:${digest({ message, productionIds, callIds, resourceIds, sourceIds }).slice(0, 24)}`, code, severity, message, productionIds, callIds, resourceIds, sourceIds }; }
export function validateTour(draft: TourDraft, productions: PlannedProduction[]) {
  assertUnique(draft.productionIds, "production membership"); assertUnique(draft.resources.map(resource => resource.id), "shared resource"); assertUnique(draft.resources.flatMap(resource => resource.personId ? [resource.personId] : []), "admitted person identity"); assertUnique(draft.legs.map(leg => leg.id), "travel leg"); assertUnique(draft.sources.map(source => source.id), "route source");
  for (const id of draft.productionIds) if (!productions.some(production => production.id === id && !production.archived)) throw new DomainError("TOUR_PRODUCTION_NOT_CURRENT", "Every tour member must be an active production in this library.");
  for (const resource of draft.resources) { if (resource.sourceIds.some(id => !draft.sources.some(source => source.id === id))) throw new DomainError("TOUR_SOURCE_REFERENCE", "Resource availability and requirements must use retained tour sources.", 400); if (resource.kind !== "person" && resource.personId || resource.kind === "person" && resource.capacity !== 1) throw new DomainError("TOUR_RESOURCE_IDENTITY", "A person has one exclusive identity; equipment cannot inherit personal authority.", 400); for (const interval of resource.availability) if (Date.parse(zoned(interval.start).instant) >= Date.parse(zoned(interval.end).instant)) throw new DomainError("TOUR_AVAILABILITY_WINDOW", "Availability must end after it starts.", 400); }
  for (const leg of draft.legs) {
    if (leg.fromProductionId === leg.toProductionId || !draft.productionIds.includes(leg.fromProductionId) || !draft.productionIds.includes(leg.toProductionId)) throw new DomainError("TOUR_LEG_MEMBERSHIP", "Every travel leg must connect two different shows in this tour.", 400);
    assertUnique(leg.resourceIds, "travelling resource");
    if (leg.resourceIds.some(id => !draft.resources.some(resource => resource.id === id))) throw new DomainError("TOUR_LEG_RESOURCE", "A travel leg names a resource outside the current tour.", 400);
    if (leg.resourceIds.some(resource => draft.legs.some(other => other.id !== leg.id && other.fromProductionId === leg.fromProductionId && other.resourceIds.includes(resource)))) throw new DomainError("TOUR_AMBIGUOUS_PATH", "A travelling resource needs one explicit onward journey per production.", 400);
    if (leg.sourceIds.some(id => !draft.sources.some(source => source.id === id))) throw new DomainError("TOUR_SOURCE_REFERENCE", "A travel leg names an unknown route source.", 400);
    zoned(leg.departure);
  }
}
interface Occupancy { productionId: string; callId: string; resourceId: string; start: string; end: string; units: number; travel: boolean }
export function evaluateTour(tour: TourDraft, allProductions: PlannedProduction[]): TourReport {
  validateTour(tour, allProductions);
  const productions = tour.productionIds.map(id => allProductions.find(production => production.id === id)!);
  const findings: ConstraintFinding[] = [], occupancy: Occupancy[] = [], rests: RestResult[] = [];
  let travelMinor = 0, labourMinor = 0, unknownItems = 0, travelMinutes: number | null = 0;
  const add = (code: string, severity: ConstraintFinding["severity"], message: string, productionIds: string[] = [], callIds: string[] = [], resourceIds: string[] = [], sourceIds: string[] = []) => findings.push(finding(code, severity, message, productionIds, callIds, resourceIds, sourceIds));
  const usedSources = new Set<string>();
  for (const production of productions) {
    if (!production.calls.length) add("NO_CALLS", "unknown", `${production.name} has no scheduled calls.`, [production.id]);
    for (const issue of production.unknowns.filter(issue => issue.hard)) add("SOURCE_REQUIREMENT", "unknown", issue.label, [production.id], [], [], issue.sourceIds);
    if (!production.venue.access || !production.venue.accessUntil || !production.venue.curfew) add("VENUE_WINDOW_UNKNOWN", "unknown", `${production.venue.name}: access, curfew and final access must all be sourced.`, [production.id], [], [], production.venue.sourceIds);
    if (production.minimumRestMinutes == null || production.maxDutyMinutes == null) add("POLICY_UNKNOWN", "unknown", `${production.name} is missing its rest or maximum-duty policy.`, [production.id]);
    for (const call of production.calls) {
      if (call.earliest && Date.parse(call.start.instant) < Date.parse(call.earliest.instant)) add("EARLIEST_START", "hard", `${call.label} begins before its retained source window.`, [production.id], [call.id], [], call.sourceIds);
      if (call.latest && Date.parse(call.end.instant) > Date.parse(call.latest.instant)) add("LATEST_END", "hard", `${call.label} ends after its retained source window.`, [production.id], [call.id], [], call.sourceIds);
      if (production.venue.access && Date.parse(call.start.instant) < Date.parse(production.venue.access.instant)) add("VENUE_ACCESS", "hard", `${call.label} begins before venue access.`, [production.id], [call.id], [], production.venue.sourceIds);
      if (production.venue.accessUntil && Date.parse(call.end.instant) > Date.parse(production.venue.accessUntil.instant)) add("VENUE_ACCESS", "hard", `${call.label} ends after final venue access.`, [production.id], [call.id], [], production.venue.sourceIds);
      if (call.amplified && production.venue.curfew && Date.parse(call.end.instant) > Date.parse(production.venue.curfew.instant)) add("CURFEW", "hard", `${call.label} exceeds the hard amplified-audio curfew.`, [production.id], [call.id], [], production.venue.sourceIds);
      if (!call.sourceIds.length) add("CALL_SOURCE_UNKNOWN", "unknown", `${call.label} has no retained source or explicit assumption.`, [production.id], [call.id]);
      for (const sourceId of [...call.sourceIds, ...production.venue.sourceIds]) usedSources.add(`${production.id}:${sourceId}`);
      for (const slotId of call.slotIds) {
        const resourceId = production.assignmentOverrides[call.id]?.[slotId] ?? production.allocations[slotId], slot = production.slots.find(slot => slot.id === slotId)!;
        for (const sourceId of slot.sourceIds) usedSources.add(`${production.id}:${sourceId}`);
        const resource = tour.resources.find(resource => resource.id === resourceId);
        if (!resource) { add("RESOURCE_UNASSIGNED", "unknown", `${call.label}: ${slot?.label ?? slotId} is not allocated to a current tour resource.`, [production.id], [call.id]); continue; }
        if (resource.capacity < slot.capacity) add("RESOURCE_CAPACITY", "hard", `${resource.label} provides capacity ${resource.capacity}; ${slot.label} requires ${slot.capacity}.`, [production.id], [call.id], [resource.id], slot.sourceIds);
        if (resource.kind === "person" && !resource.personId) add("PERSON_UNADMITTED", "unknown", `${resource.label} is a planning requirement without an admitted person identity.`, [production.id], [call.id], [resource.id], resource.sourceIds);
        if (!resource.sourceIds.length || tour.sources.some(source => resource.sourceIds.includes(source.id) && source.status === "unknown")) add("RESOURCE_SOURCE_UNKNOWN", "unknown", `${resource.label} needs a reviewed source or explicit assumption for its availability and resource declaration.`, [production.id], [call.id], [resource.id], resource.sourceIds);
        for (const source of tour.sources.filter(source => resource.sourceIds.includes(source.id) && source.status === "assumption")) add("RESOURCE_ASSUMPTION_REVIEW", "approval", `Review ${resource.label}: ${source.note}`, [production.id], [], [resource.id], [source.id]);
        if (resource.kind !== slot.kind) add("RESOURCE_KIND", "hard", `${resource.label} is not the required ${slot.kind}.`, [production.id], [call.id], [resource.id]);
        for (const skill of new Set([...slot.skills, ...(resource.kind === "person" ? call.requiredSkills : [])])) if (!resource.skills.includes(skill)) add("QUALIFICATION", "hard", `${resource.label} lacks ${skill} for ${call.label}.`, [production.id], [call.id], [resource.id], [...slot.sourceIds, ...call.sourceIds]);
        const windows = resource.availability.map(interval => ({ start: zoned(interval.start).instant, end: zoned(interval.end).instant }));
        if (resource.availabilityStatus === "unknown" || !windows.length) add("AVAILABILITY_UNKNOWN", "unknown", `${resource.label}'s availability is not established.`, [production.id], [call.id], [resource.id], resource.sourceIds);
        else if (!windows.some(interval => Date.parse(interval.start) <= Date.parse(call.start.instant) && Date.parse(interval.end) >= Date.parse(call.end.instant))) add("AVAILABILITY", "hard", `${resource.label} is unavailable for ${call.label}.`, [production.id], [call.id], [resource.id], resource.sourceIds);
        if (resource.availabilityStatus === "assumption") add("AVAILABILITY_REVIEW", "approval", `Review the declared availability assumption for ${resource.label}.`, [production.id], [], [resource.id], resource.sourceIds);
        if (resource.kind === "person") { if (resource.forecastHourlyMinor == null) unknownItems++; else labourMinor += Math.round(resource.forecastHourlyMinor * call.durationMinutes / 60); }
        if (call.durationMinutes > 0) occupancy.push({ productionId: production.id, callId: call.id, resourceId: resource.id, start: call.start.instant, end: call.end.instant, units: slot.capacity, travel: false });
      }
    }
    for (const edge of production.dependencies) {
      const from = production.calls.find(call => call.id === edge.from), to = production.calls.find(call => call.id === edge.to);
      if (!from || !to) { add("DEPENDENCY_MISSING", "hard", "A dependency refers to a missing canonical call.", [production.id]); continue; }
      if (minutesBetween(from.end.instant, to.start.instant) < edge.lagMinutes) add("DEPENDENCY_LAG", "hard", `${to.label} starts before ${from.label} and its ${edge.lagMinutes}-minute buffer finish.`, [production.id], [from.id, to.id], [], edge.sourceIds);
      for (const sourceId of edge.sourceIds) usedSources.add(`${production.id}:${sourceId}`);
    }
    for (const source of production.sources.filter(source => usedSources.has(`${production.id}:${source.id}`))) {
      if (source.status === "unknown") add("SOURCE_UNKNOWN", "unknown", `${source.title}: ${source.note}`, [production.id], [], [], [source.id]);
      if (source.status === "assumption") add("ASSUMPTION_REVIEW", "approval", `Review ${source.title}: ${source.note}`, [production.id], [], [], [source.id]);
    }
  }
  for (const leg of tour.legs) {
    const departure = zoned(leg.departure);
    if (leg.forecastCostMinor == null) unknownItems++; else travelMinor += leg.forecastCostMinor;
    if (leg.durationMinutes == null || leg.status === "unknown") { travelMinutes = null; add("TRAVEL_UNKNOWN", "unknown", `${leg.label}: duration or route evidence is unknown.`, [leg.fromProductionId, leg.toProductionId], [], leg.resourceIds, leg.sourceIds); }
    else if (travelMinutes != null) travelMinutes += leg.durationMinutes + leg.loadingMinutes + leg.unloadingMinutes;
    if (!leg.sourceIds.length) add("TRAVEL_SOURCE_UNKNOWN", "unknown", `${leg.label} has no retained travel input.`, [leg.fromProductionId, leg.toProductionId], [], leg.resourceIds);
    for (const source of tour.sources.filter(source => leg.sourceIds.includes(source.id))) {
      if (source.status === "unknown") add("TRAVEL_SOURCE_UNKNOWN", "unknown", source.note, [leg.fromProductionId, leg.toProductionId], [], leg.resourceIds, [source.id]);
      if (source.status === "assumption") add("TRAVEL_ASSUMPTION", "approval", `Review ${source.title}: ${source.note}`, [leg.fromProductionId, leg.toProductionId], [], leg.resourceIds, [source.id]);
    }
    if (leg.status === "assumption") add("TRAVEL_REVIEW", "approval", `Review the forecast route and buffers for ${leg.label}.`, [leg.fromProductionId, leg.toProductionId], [], leg.resourceIds, leg.sourceIds);
    if (leg.durationMinutes == null) continue;
    const start = plusMinutes(departure, -leg.loadingMinutes).instant, end = plusMinutes(departure, leg.durationMinutes + leg.unloadingMinutes).instant;
    for (const resourceId of leg.resourceIds) {
      const prior = occupancy.filter(item => !item.travel && item.resourceId === resourceId && item.productionId === leg.fromProductionId).sort((a, b) => b.end.localeCompare(a.end))[0];
      const next = occupancy.filter(item => !item.travel && item.resourceId === resourceId && item.productionId === leg.toProductionId).sort((a, b) => a.start.localeCompare(b.start))[0];
      if (prior && Date.parse(start) < Date.parse(prior.end)) add("LOADING_BEFORE_RELEASE", "hard", `${leg.label} begins loading before the travelling resource's last call ends.`, [leg.fromProductionId, leg.toProductionId], [prior.callId], [resourceId], leg.sourceIds);
      if (next && Date.parse(end) > Date.parse(next.start)) add("TRAVEL_ARRIVAL", "hard", `${leg.label} reaches the next call after travel and unloading finish.`, [leg.fromProductionId, leg.toProductionId], [next.callId], [resourceId], leg.sourceIds);
      const resource = tour.resources.find(resource => resource.id === resourceId)!;
      if (resource.availabilityStatus !== "unknown" && resource.availability.length && !resource.availability.some(interval => Date.parse(zoned(interval.start).instant) <= Date.parse(start) && Date.parse(zoned(interval.end).instant) >= Date.parse(end))) add("TRAVEL_AVAILABILITY", "hard", `${resource.label} is not available throughout ${leg.label}.`, [leg.fromProductionId, leg.toProductionId], [], [resourceId], leg.sourceIds);
      if (Date.parse(end) > Date.parse(start)) occupancy.push({ productionId: leg.fromProductionId, callId: `travel:${leg.id}`, resourceId, start, end, units: resource.capacity, travel: true });
    }
  }
  for (const resource of tour.resources) {
    const items = occupancy.filter(item => item.resourceId === resource.id);
    const events = items.flatMap(item => [{ at: Date.parse(item.start), delta: 1, item }, { at: Date.parse(item.end), delta: -1, item }]).sort((a, b) => a.at - b.at || a.delta - b.delta);
    const active = new Set<Occupancy>();
    for (const event of events) { if (event.delta < 0) active.delete(event.item); else { active.add(event.item); const used = [...active].reduce((sum, item) => sum + item.units, 0); if (used > resource.capacity && Date.parse(event.item.end) > event.at) add("RESOURCE_EXCLUSIVITY", "hard", `${resource.label} needs ${used} capacity units across ${active.size} overlapping calls or journeys; ${resource.capacity} are available.`, [...new Set([...active].map(item => item.productionId))], [...active].map(item => item.callId), [resource.id]); } }
    const duties = productions.flatMap(production => { const calls = items.filter(item => !item.travel && item.productionId === production.id); if (!calls.length) return []; return [{ production, start: calls.map(item => item.start).sort()[0]!, end: calls.map(item => item.end).sort().at(-1)! }]; }).sort((a, b) => a.start.localeCompare(b.start));
    for (let index = 1; index < duties.length; index++) {
      const prior = duties[index - 1]!, next = duties[index]!, relevantLegs: TravelLeg[] = [];
      let cursor = prior.production.id; const seen = new Set<string>();
      while (cursor !== next.production.id && !seen.has(cursor)) { seen.add(cursor); const leg = tour.legs.find(leg => leg.fromProductionId === cursor && leg.resourceIds.includes(resource.id)); if (!leg) break; relevantLegs.push(leg); cursor = leg.toProductionId; }
      const sameVenue = prior.production.venue.name === next.production.venue.name && prior.production.venue.city === next.production.venue.city && prior.production.venue.zone === next.production.venue.zone;
      const missing = !sameVenue && cursor !== next.production.id;
      if (missing) add("TRAVEL_PATH_MISSING", "unknown", `${resource.label} has no complete explicit move between ${prior.production.venue.name} and ${next.production.venue.name}.`, [prior.production.id, next.production.id], [], [resource.id]);
      if (resource.kind !== "person") continue;
      const min = Math.max(tour.minimumRestMinutes, prior.production.minimumRestMinutes ?? 0, next.production.minimumRestMinutes ?? 0);
      const unknown = missing || relevantLegs.some(leg => leg.durationMinutes == null || leg.status === "unknown");
      const blocked = relevantLegs.filter(leg => leg.durationMinutes != null).map(leg => { const departure = zoned(leg.departure); return { start: plusMinutes(departure, -leg.loadingMinutes).instant, end: plusMinutes(departure, leg.durationMinutes! + leg.unloadingMinutes).instant }; }).sort((a, b) => a.start.localeCompare(b.start));
      let freeStart = Date.parse(prior.end), longest = 0;
      for (const leg of blocked) { const start = Math.min(Date.parse(next.start), Date.parse(leg.start)); longest = Math.max(longest, (start - freeStart) / 60000); freeStart = Math.max(freeStart, Date.parse(leg.end)); }
      longest = Math.max(0, longest, (Date.parse(next.start) - freeStart) / 60000);
      const rest: RestResult = { resourceId: resource.id, fromProductionId: prior.production.id, toProductionId: next.production.id, previousEnd: prior.end, nextStart: next.start, travelMinutes: unknown ? null : relevantLegs.reduce((sum, leg) => sum + leg.durationMinutes! + leg.loadingMinutes + leg.unloadingMinutes, 0), restMinutes: unknown ? null : longest, minimumMinutes: min, slackMinutes: unknown ? null : longest - min, status: unknown ? "unknown" : longest < min ? "fail" : "pass" };
      rests.push(rest);
      if (!unknown && longest < min) add("MINIMUM_REST", "hard", `${resource.label} has ${longest} minutes of uninterrupted rest; ${min} are required. Travel, loading and unloading are duty.`, [prior.production.id, next.production.id], [], [resource.id], relevantLegs.flatMap(leg => leg.sourceIds));
    }
    if (resource.kind === "person") {
      const blocks = [...duties.map(duty => ({ start: duty.start, end: duty.end, ids: [duty.production.id] })), ...items.filter(item => item.travel).map(item => ({ start: item.start, end: item.end, ids: [item.productionId] }))].sort((a, b) => a.start.localeCompare(b.start));
      let block: typeof blocks[number] | undefined;
      for (const next of blocks) {
        if (!block || minutesBetween(block.end, next.start) >= tour.minimumRestMinutes) block = structuredClone(next);
        else { block.end = block.end > next.end ? block.end : next.end; block.ids = [...new Set([...block.ids, ...next.ids])]; }
        const max = Math.min(tour.maxDutyMinutes, ...block.ids.map(id => productions.find(production => production.id === id)?.maxDutyMinutes ?? tour.maxDutyMinutes));
        if (minutesBetween(block.start, block.end) > max) add("MAXIMUM_DUTY", "hard", `${resource.label}'s duty span is ${minutesBetween(block.start, block.end)} minutes without a complete rest break; the maximum is ${max}.`, block.ids, [], [resource.id]);
      }
    }
  }
  const unique = [...new Map(findings.map(issue => [issue.id, issue])).values()];
  const hard = unique.filter(issue => issue.severity === "hard"), unknown = unique.filter(issue => issue.severity === "unknown"), approvals = unique.filter(issue => issue.severity === "approval");
  return { status: hard.length ? "infeasible" : unknown.length ? "unknown" : approvals.length ? "needs_review" : "feasible", hard, unknown, approvals, rests, forecast: { travelMinor, labourMinor, totalMinor: travelMinor + labourMinor, unknownItems, currency: "USD" }, travelMinutes, engine: null };
}
export function candidatePlan(tour: Tour, productions: PlannedProduction[], input: CandidateInput) {
  const nextTour = structuredClone(tour), nextProductions = structuredClone(productions);
  assertUnique(input.shifts.map(shift => `${shift.productionId}:${shift.callId}`), "changed call"); assertUnique(input.legOverrides.map(override => override.legId), "changed travel leg");
  for (const shift of input.shifts) {
    if (!tour.productionIds.includes(shift.productionId)) throw new DomainError("TOUR_CANDIDATE_SCOPE", "A route alternative cannot change a show outside this tour.", 400);
    const production = nextProductions.find(production => production.id === shift.productionId), call = production?.calls.find(call => call.id === shift.callId);
    if (!call) throw new DomainError("TOUR_CALL_MISSING", "A changed call is not in the current production.", 400);
    call.start = plusMinutes(call.start, shift.minutes); call.end = plusMinutes(call.end, shift.minutes);
  }
  for (const override of input.legOverrides) {
    const index = nextTour.legs.findIndex(leg => leg.id === override.legId);
    if (index < 0 || override.leg.id !== override.legId) throw new DomainError("TOUR_CANDIDATE_SCOPE", "A route alternative cannot replace an unrelated travel leg.", 400);
    const existing = nextTour.legs[index]!;
    if (override.leg.fromProductionId !== existing.fromProductionId || override.leg.toProductionId !== existing.toProductionId || digest([...override.leg.resourceIds].sort()) !== digest([...existing.resourceIds].sort())) throw new DomainError("TOUR_CANDIDATE_SCOPE", "Route comparisons preserve their affected shows and resources. Review membership changes separately.", 400);
    nextTour.legs[index] = structuredClone(override.leg);
  }
  return { tour: nextTour, productions: nextProductions };
}

/** Shared identities cannot hide active work merely by placing it in another itinerary. */
export function portfolioFindings(tour: Tour, productions: PlannedProduction[], values: import("./contracts").TourRecord[]): ConstraintFinding[] {
  const result: ConstraintFinding[] = [];
  for (const other of values.filter((value): value is Tour => value.kind === "tour" && !value.archived && value.id !== tour.id)) {
    const shared = tour.resources.filter(resource => other.resources.some(value => value.id === resource.id || Boolean(resource.personId && value.personId === resource.personId)));
    for (const resource of shared) {
      const outside = values.filter((value): value is PlannedProduction => value.kind === "production" && !value.archived && other.productionIds.includes(value.id) && !tour.productionIds.includes(value.id)).flatMap(production => production.calls.filter(call => resourcesForCall(production, call).includes(resource.id)).map(call => ({ production, call })));
      if (!outside.length) continue;
      result.push(finding("SHARED_PORTFOLIO_SCOPE", "unknown", `${resource.label} also has assigned calls in another active itinerary. Include those productions and their explicit travel in one complete checked tour before applying a route or swap.`, [...new Set(outside.map(value => value.production.id))], outside.map(value => value.call.id), [resource.id]));
      for (const production of productions) for (const call of production.calls.filter(call => resourcesForCall(production, call).includes(resource.id))) for (const value of outside) if (intervalOverlap(call.start.instant, call.end.instant, value.call.start.instant, value.call.end.instant)) result.push(finding("PORTFOLIO_EXCLUSIVITY", "hard", `${resource.label} has overlapping calls in two active itineraries.`, [production.id, value.production.id], [call.id, value.call.id], [resource.id]));
    }
  }
  return result;
}
