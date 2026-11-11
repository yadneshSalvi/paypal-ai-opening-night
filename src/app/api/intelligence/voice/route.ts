import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { planningError, planningJson } from "@/server/intelligence/http";
import { readVoiceAudio, voiceWorkspace } from "@/server/intelligence/voice";
import { nativeVoiceAuthority, savedWaveResponse } from "@/server/intelligence/voice-http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const { authority } = await nativeVoiceAuthority(request, false), runId = new URL(request.url).searchParams.get("runId");
    if (!runId) return planningJson(await voiceWorkspace(authority));
    if (!z.uuid().safeParse(runId).success) throw new DomainError("VOICE_REQUEST_INVALID", "Choose a saved audio request.", 400);
    const result = await readVoiceAudio(authority, runId);
    return savedWaveResponse(result.run.id, result.bytes);
  } catch (error) { return planningError(error); }
}
