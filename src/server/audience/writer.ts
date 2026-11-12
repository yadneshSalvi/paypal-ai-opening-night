import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError } from "@/domain/contracts";
import type { AudienceCommand, AudienceDraft, AudienceEvent } from "@/domain/audience/contracts";
import { audienceCanDraft, audienceEvent } from "@/domain/audience/policy";
import { WRITER_DRAFT_LABEL, checkWriterDraft, checkWriterText, writerBlockers, writerDraftSchema, writerFacts, writerFactsDigest, writerPurposeKind, writerPurposes, writerRequestSchema, writerSegments, type WriterCheckResult, type WriterDraft, type WriterFacts, type WriterFailureCode, type WriterPurpose, type WriterRequest, type WriterRunView, type WriterSegment, type WriterWorkspace } from "@/domain/audience/writer";
import { agentAvailability, dispatchStructured, modelFailureMessages } from "../intelligence/strategy-agent";
import { recordedWriterOutput, writerAgentRequest } from "../intelligence/writer-agent";
import { claimModelAgentRun, completeModelAgentRun, modelAgentRun, modelAgentUsage, openModelAgentDocument, type ModelAgentRunRow } from "../intelligence/model-limits";
import { planningProvider, type PlanningProvider } from "../intelligence/provider";
import { audienceFingerprint, audienceReceipts, audienceReceiptSource, audienceTransaction, readAudienceRecord, type AudienceAuthority, type AudienceContext, type DraftRecord } from "./store";

/**
 * Communications writer inside the existing audience workflow. It drafts words; it cannot save, approve or deliver.
 * A draft reaches the immutable message history only through the producer's ordinary draft, approval and delivery steps.
 */
interface WriterDocument { purpose: WriterPurpose; segment: WriterSegment; sourceDigest: string; facts: WriterFacts; provenance: "model" | "recorded_model"; generatedAt: string | null; recordedAt: string | null; draft: WriterDraft | null; check: WriterCheckResult | null; failure: { code: WriterFailureCode; message: string } | null }
const RECORDED_HINT = "Load the labeled recorded draft instead; its fact check still runs live here. You can also write the note yourself.";
const failureMessage = (code: WriterFailureCode) => code === "RUN_INTERRUPTED" ? "This run did not finish. Its outcome is unknown and no draft was produced." : modelFailureMessages[code];
async function current(context: AudienceContext) {
  const receipts = await audienceReceipts(context.db, context.show), event = audienceEvent(context.show);
  return { receipts: [...receipts.values()], event, sourceDigest: audienceReceiptSource(context.show, receipts) };
}
function view(row: ModelAgentRunRow, sourceDigest: string, now: number): WriterRunView {
  const document = openModelAgentDocument<WriterDocument>(row)!, stale = row.state === "dispatching" && now - row.created_at.getTime() > 120000;
  const failure = stale ? { code: "RUN_INTERRUPTED" as const, message: failureMessage("RUN_INTERRUPTED") } : document.failure;
  return { id: row.id, commandId: row.command_id, createdAt: row.created_at.toISOString(), mode: row.mode, provenance: document.provenance, state: failure ? "failed" : row.state === "dispatching" ? "working" : document.check?.passed ? "draft_ready" : "fact_check_failed", purpose: document.purpose, segment: document.segment, kind: writerPurposeKind(document.purpose), model: row.model, generatedAt: document.generatedAt, recordedAt: document.recordedAt, responseId: row.response_id, sourceDigest: document.sourceDigest, sourceIsCurrent: document.sourceDigest === sourceDigest, facts: document.facts, draft: document.draft, check: document.check, failure, label: WRITER_DRAFT_LABEL };
}
const ready = async (db: Pick<PoolClient, "query">) => Boolean((await db.query<{ ready: string | null }>("SELECT to_regclass('on_model_agent_runs')::text AS ready")).rows[0]?.ready);

export async function readWriterWorkspace(authority: AudienceAuthority, provider: PlanningProvider = planningProvider()): Promise<WriterWorkspace> {
  return audienceTransaction(authority, false, async context => {
    const { db, show } = context, tenantId = show.tenantId, recorded = recordedWriterOutput(), demonstration = Boolean(show.demonstration);
    const recordedStatus = { available: Boolean(recorded), recordedAt: recorded?.recordedAt ?? null, model: recorded?.model ?? null, purpose: recorded?.purpose ?? null, segment: recorded?.segment ?? null };
    // A process started before migration 24 reads as unavailable rather than failing the audience desk.
    if (!await ready(db)) return { live: { available: false, reason: "Model agent storage is not ready in this running process.", model: null, used: 0, limit: 0 }, recorded: { ...recordedStatus, available: false }, purposes: [], runs: [], drafts: [], demonstration };
    const { receipts, event, sourceDigest } = await current(context), availability = agentAvailability(provider, "writer"), usage = await modelAgentUsage(db, tenantId, "writer");
    const reason = availability.reason ?? (usage.used >= usage.limit ? `This production has used its ${usage.limit} live writer runs.` : usage.globalUsed >= usage.globalLimit ? "Live model runs are at today's shared limit for this public rehearsal site." : null);
    const purposes = writerPurposes.flatMap(purpose => writerSegments.map(segment => ({ purpose, segment, blockers: writerBlockers(writerFacts(show, event, receipts, purpose, segment), event) })));
    const rows = (await db.query<ModelAgentRunRow>("SELECT * FROM on_model_agent_runs WHERE tenant_id=$1 AND agent='writer' AND session_hash=$2 ORDER BY created_at DESC LIMIT 6", [tenantId, authority.sessionHash])).rows, now = Date.now();
    const drafts: WriterWorkspace["drafts"] = [];
    for (const row of (await db.query<{ id: string }>("SELECT id FROM on_audience_drafts WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 20", [tenantId])).rows) { const record = await readAudienceRecord<DraftRecord>(db, tenantId, "draft", row.id); if (record?.writer) drafts.push({ draftId: row.id, runId: record.writer.runId, provenance: record.writer.provenance, model: record.writer.model, generatedAt: record.writer.generatedAt, recordedAt: record.writer.recordedAt, edited: record.writer.edited }); }
    return { live: { available: !reason, reason, model: availability.model, used: usage.used, limit: usage.limit }, recorded: recordedStatus, purposes, runs: rows.map(row => view(row, sourceDigest, now)), drafts, demonstration };
  });
}

/** "Draft with the writer": reserve, one model request (or the recorded response), deterministic fact check, retained result. */
export async function draftWithWriter(authority: AudienceAuthority, raw: unknown, provider: PlanningProvider = planningProvider()): Promise<WriterRunView> {
  const parsed = writerRequestSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError("AUDIENCE_WRITER_INVALID", "Choose a supported message purpose and audience segment.", 400);
  const input: WriterRequest = parsed.data, tenantId = authority.actor.tenantId;
  const prepared = await audienceTransaction(authority, false, async context => {
    if (input.sessionFingerprint !== audienceFingerprint(context.authority.sessionHash) || input.sessionExpiresAt !== context.expiresAt) throw new DomainError("AUDIENCE_ORIGINAL_SESSION_REQUIRED", "This instruction belongs to different exact producer access or its fixed expiry.", 403);
    const { receipts, event, sourceDigest } = await current(context);
    const earlier = await modelAgentRun(context.db, tenantId, "writer", input.commandId);
    if (earlier) { if (earlier.session_hash !== authority.sessionHash) throw new DomainError("AUDIENCE_WRITER_RUN", "That writer run belongs to different producer access.", 404); return { replay: view(earlier, sourceDigest, Date.now()) }; }
    if (!audienceCanDraft(context.show).ready || input.sourceDigest !== sourceDigest) throw new DomainError("AUDIENCE_SOURCE_CHANGED", "Review the current approved event and original remedy sources before drafting from them.");
    const facts = writerFacts(context.show, event, receipts, input.purpose, input.segment), blockers = writerBlockers(facts, event);
    if (blockers.length) throw new DomainError("AUDIENCE_WRITER_PURPOSE", `${blockers[0]} The writer drafts only from the approved plan and ledger.`);
    const availability = agentAvailability(provider, "writer"), recorded = input.mode === "recorded" ? recordedWriterOutput() : null;
    if (input.mode === "live" && !availability.available) throw new DomainError("MODEL_AGENT_UNAVAILABLE", `${availability.reason} No request was made. ${RECORDED_HINT}`);
    if (input.mode === "recorded" && (!recorded || recorded.purpose !== input.purpose || recorded.segment !== input.segment)) throw new DomainError("RECORDED_OUTPUT_UNAVAILABLE", "A recorded draft exists only for the VIP soundcheck refund notice to VIP ticket holders.");
    const runId = randomUUID(), document: WriterDocument = { purpose: input.purpose, segment: input.segment, sourceDigest, facts, provenance: input.mode === "live" ? "model" : "recorded_model", generatedAt: null, recordedAt: recorded?.recordedAt ?? null, draft: null, check: null, failure: null };
    await claimModelAgentRun(context.db, { id: runId, tenantId, agent: "writer", mode: input.mode, commandId: input.commandId, actorId: authority.actor.id, sessionHash: authority.sessionHash, baseRevision: context.show.revision, inputDigest: writerFactsDigest(facts), document });
    return { runId, document, recorded, model: availability.model ?? "unconfigured", sourceDigest };
  });
  if ("replay" in prepared) return prepared.replay!;
  const { runId, document, recorded } = prepared;
  let model: string | null = prepared.model, responseId: string | null = null;
  try {
    const outcome = recorded ? { ok: true as const, output: recorded.output, model: recorded.model, responseId: recorded.responseId, at: new Date().toISOString() } : await dispatchStructured(provider, writerAgentRequest(document.facts, runId, prepared.model, authority.actor));
    document.generatedAt = outcome.at;
    if (!outcome.ok) document.failure = { code: outcome.code, message: outcome.message };
    else {
      model = outcome.model; responseId = outcome.responseId;
      const draft = writerDraftSchema.safeParse(outcome.output);
      if (!draft.success) document.failure = { code: "MODEL_OUTPUT_SHAPE", message: modelFailureMessages.MODEL_OUTPUT_SHAPE };
      // The recorded words are checked against this production's current facts, exactly like a live draft.
      else { document.draft = draft.data; document.check = checkWriterDraft(document.facts, draft.data); }
    }
  } catch (error) {
    await completeModelAgentRun(null, { id: runId, tenantId }, { state: "failed", failureCode: "RUN_INTERRUPTED", model: null, responseId: null, document: { ...document, failure: { code: "RUN_INTERRUPTED", message: failureMessage("RUN_INTERRUPTED") } } });
    throw error;
  }
  await completeModelAgentRun(null, { id: runId, tenantId }, { state: document.failure ? "failed" : "completed", failureCode: document.failure?.code ?? (document.check?.passed ? null : "FACT_CHECK_FAILED"), model, responseId, document });
  return audienceTransaction(authority, false, async context => { const row = await modelAgentRun(context.db, tenantId, "writer", input.commandId); if (!row) throw new DomainError("AUDIENCE_WRITER_RUN", "The writer run was not retained.", 503); return view(row, (await current(context)).sourceDigest, Date.now()); });
}

/**
 * Called while an ordinary draft_message command is being applied. The exact words being saved (the producer may have
 * edited them) are fact-checked again against the current plan and ledger. A failing note is refused; nothing is repaired.
 */
export async function writerDraftBinding(context: AudienceContext, command: Extract<AudienceCommand, { type: "draft_message" }>, recipients: AudienceDraft["recipients"], event: AudienceEvent, at: string): Promise<DraftRecord["writer"] | undefined> {
  if (!command.writer) return undefined;
  const { db, show } = context, row = (await db.query<ModelAgentRunRow>("SELECT * FROM on_model_agent_runs WHERE tenant_id=$1 AND agent='writer' AND id=$2", [show.tenantId, command.writer.runId])).rows[0];
  const document = row ? openModelAgentDocument<WriterDocument>(row) : null;
  if (!row || row.session_hash !== context.authority.sessionHash || row.actor_id !== context.authority.actor.id || row.state !== "completed" || !document?.draft) throw new DomainError("AUDIENCE_WRITER_RUN", "This writer draft is not available to this producer access. Draft again or write the note yourself.");
  if (writerPurposeKind(document.purpose) !== command.kind) throw new DomainError("AUDIENCE_WRITER_RUN", "This writer draft was prepared for a different message purpose.", 400);
  if (!command.note) throw new DomainError("AUDIENCE_WRITER_RUN", "An AI draft needs its reviewed words in the note.", 400);
  if (document.segment !== "all" && recipients.some(item => item.receipt.tier !== document.segment)) throw new DomainError("AUDIENCE_WRITER_SEGMENT", "This draft was written for a different audience segment than the selected inboxes.", 400);
  const receipts = [...(await audienceReceipts(db, show)).values()], facts = writerFacts(show, event, receipts, document.purpose, document.segment), blockers = writerBlockers(facts, event);
  if (blockers.length) throw new DomainError("AUDIENCE_WRITER_FACT_CHECK", `${blockers[0]} The AI draft was not saved.`);
  const check = checkWriterText(facts, command.note), failed = check.checks.find(item => item.status === "fail");
  if (failed) throw new DomainError("AUDIENCE_WRITER_FACT_CHECK", `The AI draft was not saved because it does not match the approved plan or ledger. ${failed.label}: ${failed.detail}`);
  return { runId: row.id, provenance: document.provenance, model: row.model, generatedAt: document.generatedAt, recordedAt: document.recordedAt, edited: command.note !== document.draft.body.trim(), factsDigest: writerFactsDigest(facts), checkedAt: at, checks: check.checks };
}
