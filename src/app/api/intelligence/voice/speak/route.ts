import { speechInputSchema } from "@/domain/voice";
import { assertSameOrigin } from "@/server/http";
import { planningBody, planningError } from "@/server/intelligence/http";
import { speakVoice } from "@/server/intelligence/voice";
import { nativeVoiceAuthority, savedWaveResponse } from "@/server/intelligence/voice-http";
export const runtime = "nodejs";
export const maxDuration = 180;
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const { authority, scope } = await nativeVoiceAuthority(request), input = await planningBody(request, speechInputSchema);
    const result = await speakVoice(authority, scope, input.text);
    return savedWaveResponse(result.run.id, result.bytes);
  } catch (error) { return planningError(error); }
}
