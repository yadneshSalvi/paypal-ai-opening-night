import { randomUUID } from "node:crypto";
import { DomainError } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { PlannedProduction, ShiftSwap, TourRecord, TourCommand, Tour } from "@/domain/tour/contracts";
import { recordDigest, resourcesForCall } from "@/domain/tour/templates";
import { active, expected, record, records, sourceState, currentRoster, type TourContext } from "./store";
import { evaluateWithEngine, evolve } from "./comparisons";

function assignmentChange(production: PlannedProduction, callId: string, fromId: string, toId: string) {
  const next = structuredClone(production), call = next.calls.find(call => call.id === callId);
  if (!call) throw new DomainError("TOUR_CALL_MISSING", "The requested call no longer exists.", 404);
  const slots = call.slotIds.filter(slot => (next.assignmentOverrides[call.id]?.[slot] ?? next.allocations[slot]) === fromId);
  if (slots.length !== 1) throw new DomainError("TOUR_SWAP_ASSIGNMENT", "The requester must own one exact current assignment on this call.");
  if (resourcesForCall(next, call).includes(toId)) throw new DomainError("TOUR_SWAP_ASSIGNMENT", "The proposed recipient already owns an assignment on this call.");
  next.assignmentOverrides[call.id] = { ...next.assignmentOverrides[call.id], [slots[0]!]: toId }; return next;
}
function decision(context: TourContext, kind: ShiftSwap["decisions"][number]["kind"], reason: string, at: string) { return { actorId: context.authority.actor.id, personId: context.authority.actor.personId, sessionFingerprint: digest(context.authority.sessionHash), at, kind, reason }; }
export async function requestSwap(context: TourContext, action: Extract<TourCommand["action"], { type: "swap.request" }>, at: string): Promise<ShiftSwap> {
  const { db, authority } = context, tenant = authority.actor.tenantId;
  if (!authority.actor.personId || authority.actor.roles.length !== 1 || authority.actor.roles[0] !== "crew") throw new DomainError("TOUR_SWAP_PERSON_REQUIRED", "Only the assigned person can request this shift swap. A producer cannot stand in for them.", 403);
  const tour = await record(db, tenant, action.tourId, "tour"); active(tour); currentRoster(context, tour); expected(tour, action.expectedTourRevision);
  if (!tour.productionIds.includes(action.productionId)) throw new DomainError("TOUR_SWAP_SCOPE", "This production is outside the selected tour.", 404);
  const production = await record(db, tenant, action.productionId, "production"); active(production); expected(production, action.expectedProductionRevision);
  const requester = tour.resources.find(resource => resource.personId === authority.actor.personId), recipient = tour.resources.find(resource => resource.id === action.recipientResourceId && resource.kind === "person" && resource.personId);
  if (!requester || !recipient || requester.id === recipient.id) throw new DomainError("TOUR_SWAP_PEOPLE", "Select a different currently admitted crew member in this tour.", 400);
  if (!context.root.resources.some(person => person.id === recipient.personId && person.kind === "person")) throw new DomainError("TOUR_SWAP_PEOPLE", "The recipient is no longer on the admitted roster.", 409);
  if (action.reverseOf) {
    const original = await record(db, tenant, action.reverseOf, "swap");
    if (original.state !== "approved" || original.productionId !== production.id || original.callId !== action.callId || original.toResourceId !== requester.id || original.fromResourceId !== recipient.id) throw new DomainError("TOUR_SWAP_REVERSAL", "A reversal must be a new request by the currently assigned recipient, returning this same call to its original requester.");
  }
  const values = (await records(db, tenant)).filter((record): record is PlannedProduction => record.kind === "production" && tour.productionIds.includes(record.id));
  const source = await sourceState(db, tenant, values), next = assignmentChange(production, action.callId, requester.id, recipient.id);
  const report = await evaluateWithEngine(tour, values.map(value => value.id === next.id ? next : value), source.current, await records(db, tenant));
  const swap: ShiftSwap = { id: randomUUID(), kind: "swap", revision: 1, digest: "", archived: false, createdAt: at, updatedAt: at, actorId: authority.actor.id, reason: action.reason, tourId: tour.id, tourRevision: tour.revision, productionId: production.id, productionRevision: production.revision, callId: action.callId, fromResourceId: requester.id, toResourceId: recipient.id, requesterPersonId: requester.personId!, recipientPersonId: recipient.personId!, state: "requested", decisions: [decision(context, "requested", action.reason, at)], reverseOf: action.reverseOf, report, productionBindings: values.map(value => ({ id: value.id, revision: value.revision, digest: value.digest })) };
  swap.digest = recordDigest(swap); return swap;
}
export async function decideSwap(context: TourContext, action: Extract<TourCommand["action"], { type: "swap.decide" }>, at: string): Promise<TourRecord[]> {
  const { db, authority } = context, tenant = authority.actor.tenantId;
  const swap = await record(db, tenant, action.id, "swap"); active(swap); expected(swap, action.expectedRevision);
  if (["declined", "withdrawn", "approved"].includes(swap.state)) throw new DomainError("TOUR_SWAP_CLOSED", "This proposal already has its final result. Reversal requires a new attributed request.");
  const next = evolve(swap, authority.actor.id, action.reason, at), person = authority.actor.personId;
  if (action.decision === "withdraw") {
    if (person !== swap.requesterPersonId || authority.actor.roles.length !== 1 || authority.actor.roles[0] !== "crew") throw new DomainError("TOUR_SWAP_REQUESTER_REQUIRED", "Only the original requester can withdraw this proposal.", 403);
    next.state = "withdrawn"; next.decisions.push(decision(context, "withdrawn", action.reason, at)); return [next];
  }
  if (action.decision === "accept" || action.decision === "decline") {
    if (person !== swap.recipientPersonId || authority.actor.roles.length !== 1 || authority.actor.roles[0] !== "crew") throw new DomainError("TOUR_SWAP_RECIPIENT_REQUIRED", "Only the named recipient can accept or decline. The producer cannot impersonate their decision.", 403);
    if (swap.state !== "requested") throw new DomainError("TOUR_SWAP_ALREADY_DECIDED", "The recipient's original decision is already saved.");
    if (action.decision === "decline") { next.state = "declined"; next.decisions.push(decision(context, "declined", action.reason, at)); return [next]; }
  } else if (person || !authority.actor.roles.includes("producer")) throw new DomainError("TOUR_SWAP_APPROVER_REQUIRED", "Responsible production approval is a separate producer action.", 403);
  const tour = await record(db, tenant, swap.tourId, "tour"); active(tour); currentRoster(context, tour); expected(tour, swap.tourRevision);
  const productions: PlannedProduction[] = [];
  for (const binding of [...swap.productionBindings].sort((a, b) => a.id.localeCompare(b.id))) {
    const production = await record(db, tenant, binding.id, "production"); active(production);
    if (production.revision !== binding.revision || production.digest !== binding.digest) throw new DomainError("TOUR_SWAP_STALE", "A bound production changed. Retain this proposal and request a new swap against the current calls.");
    productions.push(production);
  }
  const production = productions.find(value => value.id === swap.productionId)!, changed = assignmentChange(production, swap.callId, swap.fromResourceId, swap.toResourceId);
  const source = await sourceState(db, tenant, productions);
  next.report = await evaluateWithEngine(tour, productions.map(value => value.id === changed.id ? changed : value), source.current, await records(db, tenant));
  if (next.report.hard.length || next.report.unknown.length || next.report.engine?.status !== "passed") throw new DomainError("TOUR_SWAP_BLOCKED", "This swap does not currently satisfy skills, availability, travel, rest and source requirements. It remains unapplied.");
  if (action.decision === "accept") { next.state = "accepted"; next.decisions.push(decision(context, "accepted", action.reason, at)); return [next]; }
  if (swap.state !== "accepted" || !swap.decisions.some(value => value.kind === "requested" && value.personId === swap.requesterPersonId) || !swap.decisions.some(value => value.kind === "accepted" && value.personId === swap.recipientPersonId)) throw new DomainError("TOUR_SWAP_CONSENT_REQUIRED", "The requester and named recipient must each make their own current decision before responsible approval.");
  next.state = "approved"; next.decisions.push(decision(context, "approved", action.reason, at));
  return [evolve(changed, authority.actor.id, `Approved attributed swap for ${production.calls.find(call => call.id === swap.callId)!.label}`, at), evolve(tour, authority.actor.id, "Applied a separately consented crew swap", at), next];
}
