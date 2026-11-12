import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Actor } from "../src/domain/contracts";
import { applyCommand, recordRescueRun, type Command } from "../src/domain/commands";
import type { ProducerConsentEnvelope, ReviewerConsentEnvelope } from "../src/domain/plan-consents";
import { isolatedDatabase } from "./isolated-database";

/** No model or financial provider. Quotes use the actual signed local supplier RPC. */
export async function planConsentHarness() {
  const database = await isolatedDatabase();
  const store = await import("../src/server/store"), service = await import("../src/server/plan-consents/service");
  const { sessionTokenHash } = await import("../src/server/session-records");
  const rfq = await import("../src/server/supplier-rfq"), rpc = await import("../src/app/api/enrolled-suppliers/[supplier]/rpc/route");
  const engine = await import("../src/server/engine");
  await store.migrate();
  const transport: import("../src/server/supplier-protocol").SupplierTransport = request => rpc.POST(request, { params: Promise.resolve({ supplier: new URL(request.url).pathname.split("/").at(-2)! }) });
  async function command(actor: Actor, value: Command) {
    const current = await store.getShow(actor.tenantId);
    return (await store.transactCommand(actor, randomUUID(), current.revision, value, show => applyCommand(show, actor, value))).show;
  }
  async function production() {
    const session = await store.createSession(undefined, "plan-consent-controlled:" + randomUUID());
    let show = await command(session.actor, { type: "load_incidents" });
    const rfqId = randomUUID(); await rfq.beginSupplierRfq(session.actor, rfqId, show.revision);
    assert.equal((await rfq.collectSupplierRfq(show.tenantId, rfqId, AbortSignal.timeout(10000), transport)).status, "complete");
    show = await store.getShow(show.tenantId);
    const candidates = await engine.generateCandidates(show);
    const candidate = candidates.find(value => value.family === "budget" && value.patch.offerId.includes("northside"))!;
    assert.equal(candidate.report.engine?.status, "passed", candidate.report.engine?.reason ?? "Missing actual engine report");
    assert.equal(candidate.report.status, "feasible_with_approval", JSON.stringify(candidate.report.issues));
    assert.ok(candidate.approvals.some(value => value.role === "artist_representative"));
    show = (await store.transactCommand(session.actor, randomUUID(), show.revision, { type: "controlled-plan-consent-engine" }, current => recordRescueRun(current, session.actor, candidates))).show;
    return { ...session, show, candidate, rfqId, authority: { actor: session.actor, sessionHash: sessionTokenHash(session.token) } };
  }
  async function envelope(value: Awaited<ReturnType<typeof production>>, command: ProducerConsentEnvelope["command"]): Promise<ProducerConsentEnvelope> {
    const workspace = await service.consentWorkspace(value.authority);
    return { version: 1, commandId: randomUUID(), scope: workspace.scope, expectedRevision: workspace.revision, approvalRevision: workspace.approvalRevision, command };
  }
  async function invitation(value: Awaited<ReturnType<typeof production>>) {
    const candidate = value.candidate, request = await envelope(value, { type: "invite", candidateId: candidate.id, candidateDigest: candidate.digest, requirementId: "artist-set", representativeName: "Controlled Artist Representative", representationBasis: "A declared test representative for this controlled production. No actual person's authority or participation is claimed.", sourceId: candidate.patch.tasks.find(task => task.id === "headliner")!.sourceId, validityMinutes: 15, sourceReviewed: true, invitationReviewed: true });
    const result = await service.executeProducerConsent(value.authority, request), token = result.receipt.result.reviewPath!.split("#")[1]!;
    return { request, result, token, review: await service.reviewConsent(token) };
  }
  async function decision(token: string, decision: "approve" | "decline" = "approve"): Promise<ReviewerConsentEnvelope> {
    const view = await service.reviewConsent(token);
    return { version: 1, commandId: randomUUID(), requestId: view.review.requestId, reviewDigest: view.reviewDigest, expiresAt: view.review.expiresAt, capabilityFingerprint: view.capabilityFingerprint, decision, declaredName: view.review.representative.invitedName, authorityConfirmed: true, contentReviewed: true, statement: "Controlled representative explicitly reviewed this exact artist change. This is test evidence, not a real human decision." };
  }
  async function approval(value: Awaited<ReturnType<typeof production>>) {
    return envelope(value, { type: "approve_plan", candidateId: value.candidate.id, candidateDigest: value.candidate.digest, approvals: value.candidate.approvals.map(item => item.id), reviewed: true });
  }
  return { database, store, service, rfq, engine, sessionTokenHash, command, production, envelope, invitation, decision, approval, close: database.close };
}
