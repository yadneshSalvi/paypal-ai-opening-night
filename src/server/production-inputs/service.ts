import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ConstraintIssue, ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { planningDigest, qualificationIssues, topologicalOrder } from "@/domain/scheduling";
import { inputEnvelopeSchema, type InputAuthority, type InputCommandResult, type InputEdition, type InputEnvelope, type InputPreview, type InputProposal, type InputProposalView, type InputWorkspace } from "@/domain/production-inputs/contracts";
import { inputPlanCurrent, inputPublicationCurrent, productionInputIssues } from "@/domain/production-inputs/constraints";
import { applyInputDraft, inputFacts, validateInputCitations } from "@/domain/production-inputs/proposal";
import { commitGraphEngine } from "../engine";
import { listSources } from "../sources/store";
import { sealIntelligence } from "../intelligence/private-payload";
import { inputAuthority, inputContext, inputFail, inputNow, inputObject, inputReceipt, inputShow, inputTransaction, inputUnexpired, saveInputReceipt } from "./store";
import { inputSourceCurrent, inputSources, retainedInputSource, retainInputSource } from "./sources";

const currentDigest = (show: ShowSnapshot) => digest({ planning: planningDigest(show), curfewAt: show.curfewAt, accessUntil: show.accessUntil, approvedPlan: show.approvedPlan, lastSheet: show.sheets.at(-1)?.digest ?? null, inputs: show.productionInputs ?? null });
interface ProposalRow { id: string; tenant_id: string; actor_id: string; session_hash: string; proposal_cipher: string; proposal_digest: string; base_revision: number; input_revision: number; exact_expiry: string }
const proposalSelect = `*,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_expiry`;
async function proposalById(db: PoolClient, tenantId: string, id: string): Promise<{ row: ProposalRow; proposal: InputProposal }> {
  const row = (await db.query<ProposalRow>(`SELECT ${proposalSelect} FROM on_production_input_proposals WHERE tenant_id=$1 AND id=$2`, [tenantId, id])).rows[0];
  if (!row) inputFail("INPUT_PROPOSAL_NOT_FOUND", "This proposal belongs to another production.", 404);
  const proposal = inputObject<InputProposal>(tenantId, id, "proposal", row.proposal_cipher, row.proposal_digest);
  const { digest: proposalDigest, ...content } = proposal;
  if (digest(content) !== proposalDigest || proposal.id !== row.id || proposal.scope.actorId !== row.actor_id || proposal.baseRevision !== row.base_revision || proposal.inputRevision !== row.input_revision || proposal.expiresAt !== row.exact_expiry) inputFail("INPUT_INTEGRITY", "The original typed proposal cannot be verified.", 503);
  return { row, proposal };
}
async function previewById(db: PoolClient, tenantId: string, id: string) {
  const row = (await db.query<{ preview_cipher: string; preview_digest: string }>("SELECT preview_cipher,preview_digest FROM on_production_input_previews WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0];
  if (!row) inputFail("INPUT_PREVIEW_NOT_FOUND", "This preview belongs to another production.", 404);
  const preview = inputObject<InputPreview>(tenantId, id, "preview", row.preview_cipher, row.preview_digest), { digest: hash, ...content } = preview;
  if (preview.id !== id || digest(content) !== hash) inputFail("INPUT_INTEGRITY", "The original input preview cannot be verified.", 503);
  return preview;
}
async function requireProposal(db: PoolClient, authority: InputAuthority, envelope: InputEnvelope, proposalId: string, hash: string, show: ShowSnapshot) {
  const { row, proposal } = await proposalById(db, show.tenantId, proposalId);
  if (row.session_hash !== authority.sessionHash || digest(proposal.scope) !== digest(envelope.scope)) inputFail("INPUT_ORIGINAL_PRODUCER_REQUIRED", "Continue this proposal using its original exact producer access.", 403);
  if (proposal.digest !== hash) inputFail("INPUT_PROPOSAL_CHANGED", "The reviewed proposal has different immutable content.");
  if (!await inputUnexpired(db, proposal.expiresAt)) inputFail("INPUT_PROPOSAL_EXPIRED", "This proposal's fixed review window ended. Its original content remains retained.", 410);
  if (proposal.baseRevision !== show.revision || proposal.inputRevision !== (show.productionInputs?.revision ?? 0)) inputFail("INPUT_STALE_PROPOSAL", "The production or admitted inputs changed. Review a separate current proposal.");
  if ((await db.query("SELECT 1 FROM on_production_input_decisions WHERE tenant_id=$1 AND proposal_id=$2", [show.tenantId, proposal.id])).rowCount) inputFail("INPUT_ALREADY_DECIDED", "This proposal already has an immutable producer decision. Read its original receipt.");
  for (const binding of proposal.sourceBindings) {
    const source = await retainedInputSource(db, show.tenantId, binding.id);
    if (digest(source) !== binding.digest || !await inputSourceCurrent(db, show.tenantId, source)) inputFail("INPUT_SOURCE_CHANGED", "A cited source was superseded or changed after this proposal. Its original version remains available.");
  }
  validateInputCitations(proposal.draft, proposal.sources);
  return proposal;
}
function graphIssues(show: ShowSnapshot): ConstraintIssue[] {
  const issues = productionInputIssues(show);
  for (const message of topologicalOrder(show.tasks, show.dependencies).invalid) issues.push({ code: "INPUT_GRAPH_INVALID", stage: "graph", severity: "hard", message, resourceId: null, taskId: null, sourceId: show.productionInputs!.editionId });
  for (const task of show.tasks.filter(item => item.state !== "complete" && !item.cancellation)) {
    issues.push(...qualificationIssues(show, task));
    if (task.requiredSkill && !task.resources.length) issues.push({ code: "INPUT_QUALIFIED_PERSON_REQUIRED", stage: "semantic", severity: "hard", message: `${task.name} needs a sourced qualified assignment.`, resourceId: null, taskId: task.id, sourceId: task.sourceId });
  }
  const add = (code: string, message: string, taskId: string, resourceId: string | null = null) => issues.push({ code, stage: "temporal", severity: "hard", message, resourceId, taskId, sourceId: show.productionInputs!.editionId });
  for (const dependency of show.dependencies) {
    const from = show.tasks.find(task => task.id === dependency.from), to = show.tasks.find(task => task.id === dependency.to);
    if (from && to && Date.parse(from.end) + dependency.lagMinutes * 60000 > Date.parse(to.start)) add("INPUT_DEPENDENCY_ORDER", `${to.name} starts before ${from.name} and its required lag clear.`, to.id);
  }
  const active = show.tasks.filter(task => task.critical && task.state !== "complete" && !task.cancellation && task.durationMinutes > 0 && (task.lane !== "people" || task.sourceConstraints));
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    const first = active[i]!, second = active[j]!;
    if (Date.parse(first.start) < Date.parse(second.end) && Date.parse(second.start) < Date.parse(first.end)) for (const id of first.resources.filter(id => second.resources.includes(id))) add("INPUT_RESOURCE_OVERLAP", `${show.resources.find(resource => resource.id === id)?.name ?? id}: ${first.name} overlaps ${second.name}.`, second.id, id);
  }
  return issues;
}
async function propose(db: PoolClient, authority: InputAuthority, envelope: InputEnvelope, show: ShowSnapshot) {
  if (envelope.command.type !== "propose") return inputFail("INPUT_COMMAND", "Choose a typed proposal.", 400);
  if ((await db.query<{ count: number }>("SELECT count(*)::integer AS count FROM on_production_input_proposals WHERE tenant_id=$1", [show.tenantId])).rows[0]!.count >= 200) inputFail("INPUT_PROPOSAL_LIMIT", "This production has reached its 200 retained input-proposal bound.", 422);
  const id = randomUUID(), createdAt = await inputNow(db), draft = envelope.command.draft;
  const sourceIds = [...new Set(inputFacts(draft).flatMap(fact => fact.citations.map(cite => cite.sourceId)))].sort(), sources = [];
  for (const sourceId of sourceIds) { const source = await retainedInputSource(db, show.tenantId, sourceId); if (!await inputSourceCurrent(db, show.tenantId, source)) inputFail("INPUT_SOURCE_CHANGED", "Choose the current version of every cited source."); sources.push(source); }
  validateInputCitations(draft, sources);
  applyInputDraft(show, draft, id, id, createdAt); // Reject nonexistent identities and malformed mappings before retaining a proposal.
  const content = { id, draft, sourceBindings: sources.map(source => ({ id: source.id, digest: digest(source) })), sources, scope: envelope.scope, baseRevision: show.revision, inputRevision: envelope.inputRevision, createdAt, expiresAt: envelope.scope.sessionExpiresAt };
  const proposal: InputProposal = { ...content, digest: digest(content) };
  await db.query("INSERT INTO on_production_input_proposals(id,tenant_id,actor_id,session_hash,expires_at,proposal_cipher,proposal_digest,base_revision,input_revision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [id, show.tenantId, envelope.scope.actorId, authority.sessionHash, proposal.expiresAt, sealIntelligence(show.tenantId, inputContext(id, "proposal"), proposal), digest(proposal), show.revision, envelope.inputRevision, createdAt]);
  for (const source of sources) await db.query("INSERT INTO on_production_input_source_bindings(tenant_id,proposal_id,source_id,source_digest) VALUES($1,$2,$3,$4)", [show.tenantId, id, source.id, digest(source)]);
  return proposal;
}
async function proposalView(db: PoolClient, authority: InputAuthority, show: ShowSnapshot, id: string): Promise<InputProposalView> {
  const { row, proposal } = await proposalById(db, show.tenantId, id);
  const saved = (await db.query<{ kind: "approve" | "reject"; reason: string; recordedAt: string; editionId: string | null }>(`SELECT kind,reason,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt",edition_id AS "editionId" FROM on_production_input_decisions WHERE tenant_id=$1 AND proposal_id=$2`, [show.tenantId, id])).rows[0] ?? null;
  const preview = (await db.query<{ id: string }>("SELECT id FROM on_production_input_previews WHERE tenant_id=$1 AND proposal_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [show.tenantId, id])).rows[0];
  let state: InputProposalView["state"] = saved?.kind === "approve" ? "admitted" : saved ? "rejected" : "proposed", blocker: string | null = null;
  if (!saved) {
    if (!await inputUnexpired(db, proposal.expiresAt)) { state = "expired"; blocker = "The fixed proposal access ended."; }
    else if (row.session_hash !== authority.sessionHash || proposal.scope.sessionFingerprint !== (await inputAuthority(db, authority)).sessionFingerprint) { state = "stale"; blocker = "This proposal belongs to different original producer access."; }
    else if (show.revision !== proposal.baseRevision || (show.productionInputs?.revision ?? 0) !== proposal.inputRevision) { state = "stale"; blocker = "The production or admitted input edition changed."; }
    else for (const binding of proposal.sourceBindings) if (!await inputSourceCurrent(db, show.tenantId, await retainedInputSource(db, show.tenantId, binding.id))) { state = "stale"; blocker = "A cited source version is no longer current."; break; }
  }
  return { proposal, state, blocker, decision: saved, latestPreview: preview ? await previewById(db, show.tenantId, preview.id) : null };
}
export async function productionInputWorkspace(authority: InputAuthority): Promise<InputWorkspace> {
  const documents = await listSources(authority);
  return inputTransaction(async db => {
    const show = await inputShow(db, authority.actor.tenantId, true), scope = await inputAuthority(db, authority), sources = await inputSources(db, show.tenantId);
    const rows = (await db.query<{ id: string }>("SELECT id FROM on_production_input_proposals WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC", [show.tenantId])).rows;
    const proposals = []; for (const row of rows) proposals.push(await proposalView(db, authority, show, row.id));
    const editions = (await db.query<{ id: string; edition_cipher: string; edition_digest: string }>("SELECT id,edition_cipher,edition_digest FROM on_production_input_editions WHERE tenant_id=$1 ORDER BY revision DESC", [show.tenantId])).rows.map(row => inputObject<InputEdition>(show.tenantId, row.id, "edition", row.edition_cipher, row.edition_digest));
    return { version: 1, scope, revision: show.revision, inputRevision: show.productionInputs?.revision ?? 0, serverAt: await inputNow(db), production: { title: show.title, venue: show.venue, zone: show.zone, showDate: show.showDate }, sources, documents, proposals, editions, resources: show.resources, tasks: show.tasks.map(({ id, name, resources, requiredSkill }) => ({ id, name, resources, requiredSkill })), venue: { accessFrom: show.productionInputs?.venue.accessFrom ?? null, accessUntil: show.accessUntil, amplifiedCurfew: show.curfewAt, minimumRestMinutes: show.policy.minimumRestMinutes, maximumShiftMinutes: show.policy.maxShiftMinutes }, currentInput: show.productionInputs ?? null, currentPlan: inputPlanCurrent(show), publicationCurrent: inputPublicationCurrent(show), provenanceNotice: "These are producer-reviewed declared planning inputs. Source quotations preserve provenance; they do not independently verify people, certifications, physical work, supplier capacity or venue authority." };
  });
}
export async function readProductionInputCommand(authority: InputAuthority, commandId: string) {
  return inputTransaction(async db => { await inputShow(db, authority.actor.tenantId, true); const scope = await inputAuthority(db, authority); const result = await inputReceipt(db, authority, scope, commandId); if (!result) inputFail("INPUT_COMMAND_NOT_FOUND", "No saved result exists for that exact original instruction and access.", 404); return result; });
}
export async function executeProductionInput(authority: InputAuthority, raw: InputEnvelope, engineRun: typeof commitGraphEngine = commitGraphEngine): Promise<InputCommandResult> {
  const envelope = inputEnvelopeSchema.parse(raw);
  return inputTransaction(async db => {
    const show = await inputShow(db, authority.actor.tenantId, true);
    await inputAuthority(db, authority, envelope.scope);
    const original = await inputReceipt(db, authority, envelope.scope, envelope.commandId, digest(envelope)); if (original) return original;
    if (show.revision !== envelope.expectedRevision || (show.productionInputs?.revision ?? 0) !== envelope.inputRevision) inputFail("INPUT_STALE_REVISION", "The production or admitted inputs changed. Review the current edition before a new instruction.");
    const command = envelope.command;
    const result = { revision: show.revision, inputRevision: envelope.inputRevision, message: "" } as InputCommandResult["receipt"]["result"];
    if (command.type === "retain_source" || command.type === "admit_document") {
      const source = await retainInputSource(db, envelope); Object.assign(result, { sourceId: source.id, digest: digest(source), message: "The exact immutable source is retained. It has no authority to change planning inputs." });
    } else if (command.type === "propose") {
      const proposal = await propose(db, authority, envelope, show); Object.assign(result, { proposalId: proposal.id, digest: proposal.digest, message: "The source-cited typed proposal is retained. Preview it against current authority and the real engine before separate approval." });
    } else if (command.type === "preview") {
      const proposal = await requireProposal(db, authority, envelope, command.proposalId, command.proposalDigest, show), createdAt = await inputNow(db);
      const applied = applyInputDraft(show, proposal.draft, proposal.id, proposal.id, createdAt), engine = await engineRun(applied.show.tasks, applied.show.dependencies, show.zone), issues = graphIssues(applied.show);
      if (engine.status !== "passed") issues.push({ code: engine.status === "unavailable" ? "INPUT_ENGINE_UNKNOWN" : "INPUT_ENGINE_REJECTED", stage: "temporal", severity: engine.status === "unavailable" ? "unknown" : "hard", message: engine.reason ?? "The exact engine graph did not pass.", resourceId: null, taskId: null, sourceId: engine.inputDigest });
      const id = randomUUID(), content = { id, proposalId: proposal.id, proposalDigest: proposal.digest, scope: envelope.scope, baseRevision: show.revision, inputRevision: envelope.inputRevision, currentDigest: currentDigest(show), sourceBindings: proposal.sourceBindings, differences: applied.differences, issues, engine, status: engine.status === "unavailable" ? "unknown" as const : issues.length ? "schedule_requires_replan" as const : "ready_for_input_review" as const, notice: "This review admits planning facts only. It withdraws current plan/publication clearance; no payment, work, identity or technical sign-off is approved. A conflicting input may be admitted with its blockers visible, but cannot make an invalid schedule executable.", createdAt, expiresAt: proposal.expiresAt };
      const preview: InputPreview = { ...content, digest: digest(content) };
      await db.query("INSERT INTO on_production_input_previews(id,tenant_id,proposal_id,preview_cipher,preview_digest,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, show.tenantId, proposal.id, sealIntelligence(show.tenantId, inputContext(id, "preview"), preview), digest(preview), createdAt, preview.expiresAt]);
      Object.assign(result, { proposalId: proposal.id, previewId: id, digest: preview.digest, message: engine.status === "unavailable" ? "The engine outcome is unknown. This retained preview cannot be approved." : issues.length ? "The real-engine preview is retained with scheduling blockers. Admission requires explicit review; the schedule remains blocked." : "The source/current-authority/engine preview is retained for separate producer approval." });
    } else if (command.type === "reject") {
      const proposal = await requireProposal(db, authority, envelope, command.proposalId, command.proposalDigest, show);
      await db.query("INSERT INTO on_production_input_decisions(tenant_id,proposal_id,kind,reason,actor_id,session_hash,command_id,recorded_at) VALUES($1,$2,'reject',$3,$4,$5,$6,$7)", [show.tenantId, proposal.id, command.reason, authority.actor.id, authority.sessionHash, envelope.commandId, await inputNow(db)]);
      Object.assign(result, { proposalId: proposal.id, message: "The producer's refusal is retained. No planning input was admitted." });
    } else {
      const preview = await previewById(db, show.tenantId, command.previewId);
      if (preview.digest !== command.previewDigest || digest(preview.scope) !== digest(envelope.scope) || preview.currentDigest !== currentDigest(show) || preview.baseRevision !== show.revision || preview.inputRevision !== envelope.inputRevision) inputFail("INPUT_STALE_PREVIEW", "This preview no longer binds the exact production, source or original producer access.");
      if (!await inputUnexpired(db, preview.expiresAt)) inputFail("INPUT_PREVIEW_EXPIRED", "This original preview window ended. No expiry was extended.", 410);
      if (preview.status === "unknown" || preview.engine.status === "unavailable") inputFail("INPUT_ENGINE_UNKNOWN", "The engine result is unknown; no input approval can use this preview.");
      const proposal = await requireProposal(db, authority, envelope, preview.proposalId, preview.proposalDigest, show), approvedAt = await inputNow(db), applied = applyInputDraft(show, proposal.draft, proposal.id, proposal.id, approvedAt);
      if (digest(applied.differences) !== digest(preview.differences) || preview.engine.inputDigest !== digest({ tasks: applied.show.tasks, dependencies: applied.show.dependencies })) inputFail("INPUT_PREVIEW_CHANGED", "The exact proposed graph no longer matches its retained engine report.");
      const before = { resources: show.resources, tasks: show.tasks, policy: show.policy, curfewAt: show.curfewAt, accessUntil: show.accessUntil, approvedPlan: show.approvedPlan, state: show.state, goReportId: show.goReportId };
      const after = { resources: applied.show.resources, tasks: applied.show.tasks, policy: applied.show.policy, curfewAt: applied.show.curfewAt, accessUntil: applied.show.accessUntil };
      const content = { id: proposal.id, revision: applied.state.revision, proposalId: proposal.id, previewId: preview.id, approvedAt, actorId: authority.actor.id, sourceIds: proposal.sources.map(source => source.id), state: applied.state, before, after, differences: applied.differences, issues: preview.issues, engine: preview.engine };
      const edition: InputEdition = { ...content, digest: digest(content) };
      await db.query("INSERT INTO on_production_input_editions(id,tenant_id,revision,proposal_id,preview_id,edition_cipher,edition_digest,approved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [edition.id, show.tenantId, edition.revision, proposal.id, preview.id, sealIntelligence(show.tenantId, inputContext(edition.id, "edition"), edition), digest(edition), approvedAt]);
      await db.query("INSERT INTO on_production_input_decisions(tenant_id,proposal_id,kind,reason,actor_id,session_hash,command_id,edition_id,recorded_at) VALUES($1,$2,'approve',$3,$4,$5,$6,$7,$8)", [show.tenantId, proposal.id, "Producer reviewed the exact sources, declared planning authority and scheduling consequences. Separate plan approval and publication remain required.", authority.actor.id, authority.sessionHash, envelope.commandId, edition.id, approvedAt]);
      const next = applied.show; next.revision++; next.updatedAt = approvedAt; if (next.state === "go") next.state = "standby"; next.goReportId = null;
      for (const source of proposal.sources) if (!next.sources.some(item => item.id === source.id)) next.sources.push({ id: source.id, title: source.title, source: source.provenance === "controlled_declaration" ? "sample" : "modelled", detail: `Producer-reviewed declared planning input; no independent certification or physical authority verification. ${source.authorityNote}`, recordedAt: source.createdAt });
      const event = { id: randomUUID(), type: "production.inputs_admitted", message: `Admitted input edition ${edition.revision}: ${proposal.draft.title}. Prior plan and source history remain retained; current engine-backed approval and publication are required.`, at: approvedAt, fixtureAt: show.clock, actorId: authority.actor.id, source: "sample" as const, revision: next.revision };
      next.events.push(event);
      await db.query("UPDATE on_shows SET snapshot=$2,revision=$3,updated_at=clock_timestamp() WHERE tenant_id=$1", [show.tenantId, next, next.revision]);
      await db.query("INSERT INTO on_events(id,tenant_id,revision,event) VALUES($1,$2,$3,$4)", [event.id, show.tenantId, next.revision, event]);
      Object.assign(result, { proposalId: proposal.id, previewId: preview.id, editionId: edition.id, digest: edition.digest, revision: next.revision, inputRevision: edition.revision, message: "The reviewed input edition is admitted. Its source-backed constraints now drive the canonical roster and schedule; a fresh valid plan and current publication are required." });
    }
    await inputAuthority(db, authority, envelope.scope); // Actual completion time, including expiry while the engine was running.
    return saveInputReceipt(db, authority, envelope, result);
  });
}
