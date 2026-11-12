/** Supplied display fixtures only. Service qualification uses real signed RFQs and native engine commits. */
import { randomBytes, randomUUID } from "node:crypto";
import type { ConsentCommandResult, ConsentEnvelope, ConsentReview, ProducerConsentEnvelope, ProducerConsentWorkspace, ReviewerConsentView } from "../src/domain/plan-consents";
import { digest } from "../src/domain/hash";
import { withRun } from "./helpers";
import { consentDigest, prepareConsent, producerClientScope, reviewerClientScope } from "../src/components/plan-consents/recovery";

const exact = (milliseconds: number) => new Date(milliseconds).toISOString().replace(/Z$/, "000Z");
export function consentUiFixture() {
  const { show, actor } = withRun(), candidate = show.runs.at(-1)!.candidates.find(item => item.family === "budget" && item.patch.offerId.includes("northside"))!, offer = show.offers.find(item => item.id === candidate.patch.offerId)!;
  const before = show.tasks.find(item => item.id === "headliner")!, after = candidate.patch.tasks.find(item => item.id === "headliner")!;
  const changes: ConsentReview["changes"] = [{ taskId: after.id, name: after.name, before: { start: before.start, end: before.end, minutes: before.durationMinutes }, proposed: { start: after.start, end: after.end, minutes: after.durationMinutes } }];
  const workspace: ProducerConsentWorkspace = { scope: { tenantId: show.tenantId, actorId: actor.id, sessionExpiresAt: exact(Date.now() + 3600000), sessionFingerprint: digest(randomUUID()) }, revision: show.revision, approvalRevision: 0, serverAt: exact(Date.now()), production: { title: show.title, venue: show.venue, showDate: show.showDate, zone: show.zone }, actorRoles: actor.roles, sources: show.sources, candidates: [{ candidate, current: true, blocker: null, supplierName: offer.supplier, depositMinor: offer.depositMinor, commercialCapMinor: offer.feeMinor + offer.depositMinor, changes, requests: [] }], requests: [] };
  const review: ConsentReview = { version: 1, requestId: randomUUID(), production: workspace.production, candidate: { id: candidate.id, name: candidate.name, digest: candidate.digest, sourceDigest: candidate.sourceDigest, baseRevision: show.revision }, requirement: { id: "artist-set", label: "Headliner set −15 min", role: "artist_representative" }, representative: { invitedName: "Controlled Representative", basis: "Controlled display fixture; no real person or artist decision is claimed.", source: show.sources.find(item => item.id === after.sourceId)! }, changes, proposedDoorsAt: candidate.patch.doorsAt, createdAt: exact(Date.now()), expiresAt: exact(Date.now() + 900000), provenance: "controlled_declaration", authorityNotice: "Controlled display fixture with separately declared consent. No identity, payment, physical work or GO evidence." };
  const reader: ReviewerConsentView = { review, reviewDigest: digest(review), state: "awaiting_representative", blocker: null, decision: null, revoked: null, committed: null, capabilityFingerprint: digest(randomUUID()), serverAt: exact(Date.now()) };
  const token = randomBytes(32).toString("base64url");
  return { workspace, reader, token };
}
export function uiInvitation(workspace: ProducerConsentWorkspace): ProducerConsentEnvelope {
  const candidate = workspace.candidates[0]!.candidate;
  return { version: 1, commandId: randomUUID(), scope: workspace.scope, expectedRevision: workspace.revision, approvalRevision: workspace.approvalRevision, command: { type: "invite", candidateId: candidate.id, candidateDigest: candidate.digest, requirementId: "artist-set", representativeName: "Controlled Representative", representationBasis: "Controlled test designation with no actual human authority claim.", sourceId: candidate.patch.tasks.find(task => task.id === "headliner")!.sourceId, validityMinutes: 15, sourceReviewed: true, invitationReviewed: true } };
}
export async function uiConsentResult(view: ProducerConsentWorkspace | ReviewerConsentView, envelope: ConsentEnvelope): Promise<ConsentCommandResult> {
  const scope = "scope" in view ? producerClientScope(view) : reviewerClientScope(view), pending = await prepareConsent(scope, envelope);
  let result: ConsentCommandResult["receipt"]["result"];
  if ("command" in envelope) {
    if (envelope.command.type === "invite") result = { requestId: randomUUID(), reviewDigest: digest(envelope.command), reviewPath: "/approvals/review#" + randomBytes(32).toString("base64url"), message: "One controlled exact review invitation is saved." };
    else if (envelope.command.type === "revoke") result = { requestId: envelope.command.requestId, reviewDigest: envelope.command.reviewDigest, message: "Original review access stopped; its historical decision remains." };
    else result = { candidateDigest: envelope.command.candidateDigest, revision: envelope.expectedRevision + 1, planVersion: 3, externalApprovals: [], message: "Producer plan approval saved. Execution remains separate." };
  } else {
    const decision = { id: randomUUID(), requestId: envelope.requestId, decision: envelope.decision, declaredName: envelope.declaredName, statement: envelope.statement, reviewDigest: envelope.reviewDigest, recordedAt: exact(Date.now()), reviewerId: "plan-review:" + envelope.requestId };
    result = { requestId: envelope.requestId, reviewDigest: envelope.reviewDigest, decision: { ...decision, receiptDigest: await consentDigest(decision) }, message: "The separate controlled declaration is saved. Producer approval is still separate." };
  }
  const content = { version: 1 as const, commandId: envelope.commandId, action: "command" in envelope ? envelope.command.type : envelope.decision, scopeId: scope.fingerprint, expiresAt: scope.expiresAt, requestDigest: pending.requestDigest, acceptedAt: exact(Date.now()), result };
  return { receipt: { ...content, receiptDigest: await consentDigest(content) }, replayed: false };
}
