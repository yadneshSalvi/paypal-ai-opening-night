import { digest } from "@/domain/hash";
import { WRITER_PROMPT_VERSION, WRITER_SCHEMA_NAME, writerInstructions, writerOutputJsonSchema, writerPurposes, writerSegments, type WriterFacts, type WriterPurpose, type WriterSegment } from "@/domain/audience/writer";
import type { StructuredRequest } from "./strategy-agent";
import recordedWriter from "./recorded/writer-vip-notice.v1.json";

/** The communications writer receives only the approved-fact document. It has no tools and can send nothing. */
export function writerAgentRequest(facts: WriterFacts, runId: string, model: string, actor: { tenantId: string; id: string }): StructuredRequest {
  return { runId, agent: "writer", model, instructions: writerInstructions, input: facts, schemaName: WRITER_SCHEMA_NAME, schema: writerOutputJsonSchema, safetyIdentifier: digest({ tenant: actor.tenantId, actor: actor.id }), maxOutputTokens: 3000 };
}
/** One real writer response for the fixture VIP notice, checked in. Only its structured output and metadata are stored. */
export interface RecordedWriterOutput { version: 1; kind: "writer"; label: string; recordedAt: string; model: string; responseId: string | null; promptVersion: string; factsDigest: string; outputDigest: string; fixture: string; purpose: WriterPurpose; segment: WriterSegment; output: unknown }
export function recordedWriterOutput(): RecordedWriterOutput | null {
  try {
    const value = structuredClone(recordedWriter) as unknown as RecordedWriterOutput;
    if (value.version !== 1 || value.kind !== "writer" || value.promptVersion !== WRITER_PROMPT_VERSION || !Number.isFinite(Date.parse(value.recordedAt)) || typeof value.model !== "string" || digest(value.output) !== value.outputDigest || !writerPurposes.includes(value.purpose) || !writerSegments.includes(value.segment)) return null;
    return value;
  } catch { return null; }
}
