import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyCommand, recordRescueRun, type Command } from "../src/domain/commands";
import type { Actor } from "../src/domain/contracts";
import type { InputDraft, InputEnvelope } from "../src/domain/production-inputs/contracts";
import { isolatedDatabase } from "./isolated-database";

export async function inputHarness() {
  const database = await isolatedDatabase(), store = await import("../src/server/store"), service = await import("../src/server/production-inputs/service"), { sessionTokenHash } = await import("../src/server/session-records");
  const engine = await import("../src/server/engine"), rfq = await import("../src/server/supplier-rfq"), rpc = await import("../src/app/api/enrolled-suppliers/[supplier]/rpc/route");
  await store.migrate();
  const production = async () => { const session = await store.createSession(undefined, `production-inputs-controlled:${randomUUID()}`); return { ...session, authority: { actor: session.actor, sessionHash: sessionTokenHash(session.token) } }; };
  type Production = Awaited<ReturnType<typeof production>>;
  async function envelope(value: Production, command: InputEnvelope["command"]): Promise<InputEnvelope> { const view = await service.productionInputWorkspace(value.authority); return { version: 1, commandId: randomUUID(), scope: view.scope, expectedRevision: view.revision, inputRevision: view.inputRevision, command }; }
  async function source(value: Production, text: string) {
    const request = await envelope(value, { type: "retain_source", title: "Controlled production declaration", text, provenance: "controlled_declaration", authorityNote: "The producer declares these fictional planning inputs for an isolated controlled test. No actual person's skills, identity, availability or venue authority are independently verified.", rights: { basis: "owned", owner: "Controlled fixture", note: "Original test text" }, rightsConfirmed: true, replacesId: null });
    const saved = await service.executeProductionInput(value.authority, request), view = await service.productionInputWorkspace(value.authority);
    const source = view.sources.find(item => item.id === saved.receipt.result.sourceId)!;
    assert.ok(source); return { request, saved, source, citation: { sourceId: source.id, unitId: source.units[0]!.id, quote: source.units[0]!.text } };
  }
  async function proposal(value: Production, draft: InputDraft) { const request = await envelope(value, { type: "propose", draft, sourceReviewed: true }), saved = await service.executeProductionInput(value.authority, request); const view = await service.productionInputWorkspace(value.authority); return { request, saved, proposal: view.proposals.find(item => item.proposal.id === saved.receipt.result.proposalId)!.proposal }; }
  async function preview(value: Production, draft: InputDraft) {
    const proposed = await proposal(value, draft), request = await envelope(value, { type: "preview", proposalId: proposed.proposal.id, proposalDigest: proposed.proposal.digest }), saved = await service.executeProductionInput(value.authority, request);
    const view = await service.productionInputWorkspace(value.authority), preview = view.proposals.find(item => item.proposal.id === proposed.proposal.id)!.latestPreview!;
    assert.ok(preview.engine); return { ...proposed, previewRequest: request, previewSaved: saved, preview };
  }
  const approve = async (value: Production, preview: { id: string; digest: string }) => envelope(value, { type: "approve", previewId: preview.id, previewDigest: preview.digest, sourceReviewed: true, authorityDeclared: true, consequencesReviewed: true, schedulingBlockersAccepted: true });
  async function command(actor: Actor, value: Command) { const current = await store.getShow(actor.tenantId); return (await store.transactCommand(actor, randomUUID(), current.revision, value, show => applyCommand(show, actor, value))).show; }
  async function planned(value: Production) {
    let show = await command(value.actor, { type: "load_incidents" });
    const id = randomUUID(); await rfq.beginSupplierRfq(value.actor, id, show.revision);
    const transport: import("../src/server/supplier-protocol").SupplierTransport = request => rpc.POST(request, { params: Promise.resolve({ supplier: new URL(request.url).pathname.split("/").at(-2)! }) });
    assert.equal((await rfq.collectSupplierRfq(show.tenantId, id, AbortSignal.timeout(15000), transport)).status, "complete");
    show = await store.getShow(show.tenantId); const candidates = await engine.generateCandidates(show);
    show = (await store.transactCommand(value.actor, randomUUID(), show.revision, { type: "controlled-inputs-real-engine" }, current => recordRescueRun(current, value.actor, candidates))).show;
    const candidate = candidates.find(item => item.family === "doors" && item.patch.offerId.includes("brightline"))!;
    assert.equal(candidate.report.engine?.status, "passed"); assert.equal(candidate.report.status, "feasible_with_approval", JSON.stringify(candidate.report.issues));
    return command(value.actor, { type: "approve", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: candidate.approvals.map(item => item.id) });
  }
  return { database, store, service, engine, rfq, production, envelope, source, proposal, preview, approve, command, planned, close: database.close };
}
