import { randomUUID } from "node:crypto";
import type { Actor, Candidate, FinancialEvidence, ShowSnapshot } from "../src/domain/contracts";
import { createFixture } from "../src/domain/fixture";
import { applyCommand, recordRescueRun } from "../src/domain/commands";
import { enumerateCandidates } from "../src/domain/scheduling";
import { digest } from "../src/domain/hash";
export function base() { const show = createFixture(randomUUID()); const actor: Actor = { id: "producer:test", tenantId: show.tenantId, roles: ["producer", "stage_manager", "department_lead", "foh"], personId: null }; return { show, actor }; }
export function disrupted() { const { show, actor } = base(); return { show: applyCommand(show, actor, { type: "load_incidents" }), actor }; }
export function withRun() { const { show, actor } = disrupted(); const candidates = enumerateCandidates(show); for (const c of candidates) c.report.engine = testEngine(c); return { show: recordRescueRun(show, actor, candidates), actor }; }
/** Unit-test double only. Integration tests use real Bryntum commits. */
export function testEngine(candidate: Candidate) { return { engine: "bryntum-gantt-enterprise" as const, version: "8.0.0" as const, status: "passed" as const, computedAt: new Date().toISOString(), durationMs: 1, inputDigest: digest(candidate.patch), reason: null, dates: [] }; }
export function approved() { const { show, actor } = withRun(); const c = show.runs[0].candidates.find(c => c.id.startsWith("doors-brightline"))!; return { actor, show: applyCommand(show, actor, { type: "approve", candidateId: c.id, candidateDigest: c.digest, approvals: c.approvals.map(a => a.id) }) }; }
export function evidence(show: ShowSnapshot, overrides: Partial<FinancialEvidence> = {}): FinancialEvidence { const id = randomUUID(); return { id, operationId: randomUUID(), kind: "capture", purpose: "ticket", status: "completed", amountMinor: 5000, currency: "USD", source: "live_sandbox", verified: true, planVersion: show.planVersion, providerResourceId: `TEST-${id}`, parentId: null, ticketId: null, recordedAt: new Date().toISOString(), ...overrides }; }
export function publishForTest() { const { show, actor } = approved(); show.financialEvidence.push(evidence(show, { kind: "authorization", purpose: "rental", amountMinor: 78000 })); show.facts.push({ id: randomUUID(), kind: "supplier_confirmed", planVersion: show.planVersion, actorId: "supplier:test", role: "supplier", recordedAt: new Date().toISOString(), fixtureAt: show.clock, source: "sample", detail: "Test fixture supplier confirmation" }); return { actor, show: applyCommand(show, actor, { type: "publish" }) }; }
