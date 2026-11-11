import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, type Candidate } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { intelligenceStepTools, intelligenceTools, productionForIntelligence, type IntelligenceConversation, type IntelligenceToolCommand, type IntelligenceToolResult, type IntelligenceWorkspace } from "@/domain/intelligence";
import { planningDigest, qualificationIssues, validatePatch } from "@/domain/scheduling";
import { recordRescueRun } from "@/domain/commands";
import { commitEngine } from "../engine";
import { transactCommand } from "../store";
import { canonicalConversation, intelligenceSourceDigest, ownedRun, planningFail, planningShow, proposalView, receiptResult, requirePlanningAuthority, runCompletion, withPlanningTransaction, type IntelligenceAuthority, type ProposalRow, type ToolReceipt } from "./ledger";
import { sealIntelligence } from "./private-payload";
import { planningProvider } from "./provider";

export async function executeIntelligenceTool(authority: IntelligenceAuthority, command: IntelligenceToolCommand): Promise<IntelligenceToolResult> {
  const args = intelligenceTools[command.name].parse(command.args);
  return withPlanningTransaction(async db => {
    await requirePlanningAuthority(db, authority);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`intelligence-tool:${command.runId}:${command.callId}`]);
    const actor = authority.actor, run = await ownedRun(db, actor, command.runId);
    const call = runCompletion(run)?.choices[0].message.tool_calls?.find(item => item.id === command.callId);
    if (run.state !== "completed" || !call || call.function.name !== command.name || digest(JSON.parse(call.function.arguments)) !== digest(args)) planningFail("PLANNING_TOOL_BINDING", "Only an exact saved assistant call may invoke this tool.", 403);
    const previous = (await db.query<ToolReceipt>("SELECT * FROM on_intelligence_tool_receipts WHERE run_id=$1 AND call_id=$2 AND tenant_id=$3", [run.id, command.callId, actor.tenantId])).rows[0];
    if (previous) {
      if (previous.args_hash !== digest(args)) planningFail("PLANNING_TOOL_CHANGED", "The saved call has different arguments.");
      const result = receiptResult(previous); if (result) return result;
      planningFail("PLANNING_TOOL_PENDING", "This exact call is still being resolved.");
    }
    const show = await planningShow(db, actor, true), id = randomUUID();
    const response = (ok: boolean, data: unknown, message: string): IntelligenceToolResult => ({ ok, evidenceId: id, name: command.name, data, message });
    let result: IntelligenceToolResult;
    if (show.revision !== run.revision || intelligenceSourceDigest(show) !== run.source_digest) {
      result = response(false, { code: "PLANNING_SOURCE_CHANGED", currentRevision: show.revision }, "The production changed after this response. Read the current plan before proposing a change.");
    } else {
      try {
        let data: unknown;
        switch (command.name) {
          case "readProduction": data = { ...productionForIntelligence(show), sourceDigest: run.source_digest }; break;
          case "checkAssignment": {
            const assignment = intelligenceTools.checkAssignment.parse(args), task = show.tasks.find(item => item.id === assignment.taskId);
            if (!task || assignment.resourceIds.some(resource => !show.resources.some(item => item.id === resource))) planningFail("ASSIGNMENT_NOT_FOUND", "Choose an existing task and resources in this production.");
            const issues = qualificationIssues(show, { ...task, resources: assignment.resourceIds });
            data = { allowedByQualification: issues.length === 0, taskId: task.id, taskName: task.name, requiredSkill: task.requiredSkill, proposedResources: assignment.resourceIds, issues, qualifiedAlternatives: show.resources.filter(resource => task.requiredSkill && resource.skills.includes(task.requiredSkill)).map(({ id, name }) => ({ id, name })), sourceDigest: run.source_digest, changed: false, limitation: "A qualification check alone does not establish timing, availability or a permitted plan." }; break;
          }
          case "compareRecoveryPlans": {
            data = { sourceDigest: run.source_digest, revision: show.revision, candidates: (show.runs.at(-1)?.candidates ?? []).map(candidate => ({ id: candidate.id, name: candidate.name, digest: candidate.digest, summary: candidate.summary, cost: candidate.cost, report: candidate.report, current: candidate.sourceDigest === planningDigest(show), approvals: candidate.approvals.map(({ id, label, role }) => ({ id, label, role })) })), message: show.runs.length ? "Saved alternatives only. Supplier terms and approval are rechecked separately." : "Compute the recovery alternatives in the workbench before comparing them." }; break;
          }
          case "proposeRecovery": {
            const proposed = intelligenceTools.proposeRecovery.parse(args);
            const original = show.runs.at(-1)?.candidates.find(candidate => candidate.id === proposed.candidateId && candidate.digest === proposed.candidateDigest);
            if (!original || original.sourceDigest !== planningDigest(show)) planningFail("PROPOSAL_SOURCE_CHANGED", "Choose an exact current candidate from the latest saved alternatives.");
            const candidate = structuredClone(original), proposalId = randomUUID();
            for (const assignment of proposed.assignments) {
              const task = candidate.patch.tasks.find(item => item.id === assignment.taskId);
              if (!task || task.lane === "commercial" || task.milestone || assignment.resourceIds.some(resourceId => !show.resources.some(resource => resource.id === resourceId))) planningFail("PROPOSAL_ASSIGNMENT_DENIED", "Only existing operational tasks and known resources can be proposed. Commercial milestones cannot be reassigned.");
              task.resources = assignment.resourceIds;
            }
            const offer = show.offers.find(item => item.id === candidate.patch.offerId);
            if (!offer) planningFail("PROPOSAL_OFFER_MISSING", "This candidate's supplier terms are unavailable.");
            candidate.id = `intelligence-${proposalId}`; candidate.name = `AI alternative · ${original.name}`;
            candidate.generatedAt = new Date().toISOString(); candidate.patch.baseRevision = show.revision;
            candidate.approvals = candidate.approvals.map(requirement => ({ ...requirement, grantedBy: null }));
            candidate.patch.changedPeople = [...new Set([...candidate.patch.changedPeople, ...proposed.assignments.flatMap(assignment => [...assignment.resourceIds, ...(original.patch.tasks.find(task => task.id === assignment.taskId)?.resources ?? [])])])];
            candidate.digest = digest({ patch: candidate.patch, approvals: candidate.approvals, cost: candidate.cost });
            candidate.report = validatePatch(show, candidate.patch, offer);
            candidate.report.engine = await commitEngine(candidate);
            if (candidate.report.engine.status !== "passed") {
              candidate.report.issues.push({ code: "ENGINE_" + candidate.report.engine.status.toUpperCase(), stage: "temporal", severity: candidate.report.engine.status === "rejected" ? "hard" : "unknown", message: candidate.report.engine.reason ?? "Native engine verification is unavailable.", resourceId: null, taskId: null, sourceId: candidate.report.engine.inputDigest });
              candidate.report.status = candidate.report.engine.status === "rejected" ? "infeasible" : "unknown_pending_evidence";
            }
            await requirePlanningAuthority(db, authority);
            const row = (await db.query<ProposalRow>("INSERT INTO on_intelligence_proposals(id,tenant_id,actor_id,run_id,call_id,base_revision,source_digest,payload_digest,candidate_cipher) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *", [proposalId, actor.tenantId, actor.id, run.id, command.callId, show.revision, run.source_digest, digest(candidate), sealIntelligence(actor.tenantId, `proposal:${proposalId}`, candidate)])).rows[0]!;
            data = { proposal: proposalView(row), activePlanChanged: false, producerReviewRequired: true, commercialApprovalGranted: false }; break;
          }
          case "askUser": data = { ...intelligenceTools.askUser.parse(args), approvalGranted: false }; break;
          case "createPlan": {
            const value = intelligenceTools.createPlan.parse(args);
            data = { plan: { goal: value.goal, steps: value.steps.map((description, index) => ({ id: index + 1, description, completed: false })) } }; break;
          }
          case "completePlanSteps": {
            const saved = await canonicalConversation(db, actor, run.conversation_id), requested = intelligenceTools.completePlanSteps.parse(args);
            const planIndex = saved.receipts.findLastIndex(row => row.name === "createPlan" && receiptResult(row)?.ok);
            const planReceipt = saved.receipts[planIndex];
            if (!planReceipt) planningFail("PLANNING_CHECKLIST_MISSING", "Create a visible plan before completing its steps.");
            let plan = (receiptResult(planReceipt)!.data as { plan: NonNullable<IntelligenceConversation["plan"]> }).plan;
            const subsequent = saved.receipts.slice(planIndex + 1).filter(receipt => saved.runs.some(item => item.id === receipt.run_id && item.revision === run.revision && item.source_digest === run.source_digest));
            for (const row of subsequent) if (row.name === "completePlanSteps" && receiptResult(row)?.ok) plan = (receiptResult(row)!.data as { plan: typeof plan }).plan;
            for (const stepId of requested.stepIds) {
              const step = plan.steps.find(item => item.id === stepId), tool = step && intelligenceStepTools[step.description as keyof typeof intelligenceStepTools];
              if (!step || !tool || !subsequent.some(row => row.name === tool && receiptResult(row)?.ok && (tool !== "proposeRecovery" || ["feasible", "feasible_with_approval"].includes((receiptResult(row)!.data as { proposal: { candidate: Candidate } }).proposal.candidate.report.status)))) planningFail("PLANNING_STEP_EVIDENCE", "A checklist step needs its matching successful current tool receipt.");
              step.completed = true;
            }
            data = { plan }; break;
          }
        }
        result = response(true, data, command.name === "proposeRecovery" ? "The alternative is saved for review. Active calls, commitments and crew evidence are unchanged." : "The exact planning result has been saved.");
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        result = response(false, { code: error.code }, error.message);
      }
    }
    await db.query("INSERT INTO on_intelligence_tool_receipts(id,tenant_id,run_id,call_id,name,args_hash,state,result_cipher,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())", [id, actor.tenantId, run.id, command.callId, command.name, digest(args), result.ok ? "completed" : "failed", sealIntelligence(actor.tenantId, `tool:${id}`, result)]);
    return result;
  });
}

export async function intelligenceWorkspace(authority: IntelligenceAuthority): Promise<IntelligenceWorkspace> {
  return withPlanningTransaction(async db => {
    await requirePlanningAuthority(db, authority); const actor = authority.actor;
    const conversations = (await db.query<{ id: string; created_at: Date }>("SELECT id,created_at FROM on_intelligence_conversations WHERE tenant_id=$1 AND actor_id=$2 ORDER BY created_at DESC LIMIT 100", [actor.tenantId, actor.id])).rows;
    const proposals = (await db.query<ProposalRow>("SELECT * FROM on_intelligence_proposals WHERE tenant_id=$1 AND actor_id=$2 ORDER BY created_at DESC LIMIT 100", [actor.tenantId, actor.id])).rows;
    const provider = planningProvider();
    return { conversations: conversations.map(row => ({ id: row.id, createdAt: row.created_at.toISOString() })), proposals: proposals.map(proposalView), providerAvailable: provider.configured, providerMode: provider.configured ? provider.mode : "unavailable" };
  });
}
export const reviewIntelligenceSchema = z.strictObject({ proposalId: z.string().uuid(), proposalDigest: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: z.number().int().positive(), commandId: z.string().uuid(), reviewed: z.literal(true) });
export async function reviewIntelligenceProposal(authority: IntelligenceAuthority, command: z.infer<typeof reviewIntelligenceSchema>) {
  let prepared: Candidate | undefined;
  const result = await transactCommand(authority.actor, command.commandId, command.expectedRevision, { type: "review_intelligence_proposal", ...command }, show => {
    if (!prepared) planningFail("PROPOSAL_NOT_READY", "The saved proposal could not be reviewed.");
    return recordRescueRun(show, authority.actor, [prepared], undefined, "model_assisted_proposal");
  }, async db => {
    await requirePlanningAuthority(db, authority);
    if (!authority.actor.roles.includes("producer")) planningFail("PROPOSAL_PRODUCER_REQUIRED", "A producer reviews an alternative before it enters the recovery workbench.", 403);
    const row = (await db.query<ProposalRow>("SELECT * FROM on_intelligence_proposals WHERE id=$1 AND tenant_id=$2 AND actor_id=$3 FOR UPDATE", [command.proposalId, authority.actor.tenantId, authority.actor.id])).rows[0];
    if (!row) planningFail("PROPOSAL_NOT_FOUND", "This proposal is not in your current workspace.", 404);
    const proposal = proposalView(row);
    if (proposal.digest !== command.proposalDigest) planningFail("PROPOSAL_CHANGED", "Review the exact saved alternative.");
    // A replay of the same durable command returns current state in transactCommand.
    const already = await db.query("SELECT command_id FROM on_commands WHERE tenant_id=$1 AND command_id=$2", [authority.actor.tenantId, command.commandId]);
    if (already.rowCount) return;
    const show = await planningShow(db, authority.actor);
    if (row.state !== "proposed" || show.revision !== proposal.baseRevision || intelligenceSourceDigest(show) !== proposal.sourceDigest) planningFail("PROPOSAL_SOURCE_CHANGED", "The production changed. Prepare and review a current alternative.");
    const offer = show.offers.find(item => item.id === proposal.candidate.patch.offerId);
    if (!offer || !["feasible", "feasible_with_approval"].includes(validatePatch(show, proposal.candidate.patch, offer).status) || proposal.candidate.report.engine?.status !== "passed") planningFail("PROPOSAL_NOT_FEASIBLE", "Resolve all hard constraints and missing evidence before reviewing this alternative.");
    prepared = proposal.candidate;
  }, async db => {
    await db.query("UPDATE on_intelligence_proposals SET state='reviewed',review_command_id=$1,reviewed_at=now() WHERE id=$2 AND tenant_id=$3 AND state='proposed'", [command.commandId, command.proposalId, authority.actor.tenantId]);
  });
  return result;
}
