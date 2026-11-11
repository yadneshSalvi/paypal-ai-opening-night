import { z } from "zod";

export const voiceLimits = { inputBytes: 4 * 1024 * 1024, speechCharacters: 6000, transcriptCharacters: 12000, outputBytes: 8 * 1024 * 1024, recordingMs: 60000 } as const;
export const voiceModels = { transcribe: "gpt-transcribe", speak: "gpt-realtime-2.1-mini", voice: "marin" } as const;
export const voiceScopeSchema = z.object({ production: z.uuid(), scope: z.uuid() }).strict();
export const speechInputSchema = z.object({ text: z.string().trim().min(1).max(voiceLimits.speechCharacters) }).strict();
export type VoiceKind = "transcribe" | "speak";
export type VoiceState = "connecting" | "dispatching" | "streaming" | "completed" | "failed" | "indeterminate";
export interface VoiceRunView {
  id: string; scope: string; kind: VoiceKind; state: VoiceState; createdAt: string;
  model: string; resolvedModel: string | null; provenance: "live_model" | "controlled_fixture";
  text: string | null; message: string; byteLength: number | null; durationSeconds: number | null;
}
export interface VoiceWorkspace { available: boolean; mode: "live_model" | "controlled_fixture"; runs: VoiceRunView[] }
export const voiceStateText: Record<VoiceState, string> = {
  connecting: "Preparing the original audio request.",
  dispatching: "The original audio request is saved and processing.",
  streaming: "Saving the original AI voice recording.",
  completed: "Original audio result saved. A transcript stays a draft until you send it.",
  failed: "The provider could not complete this request. The original attempt is retained.",
  indeterminate: "The original audio result is uncertain. It is held for review and has not been regenerated.",
};

/** Pure draft behavior used by the inspected native transcription hook. */
export function transcriptDraft(current: string, transcript: string) {
  const text = transcript.trim();
  if (!text || text.length > voiceLimits.transcriptCharacters) throw new Error("The transcript is empty or exceeds its bound.");
  return current.trim() ? `${current.trimEnd()}\n${text}` : text;
}
