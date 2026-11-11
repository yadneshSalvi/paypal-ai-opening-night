import { assertSameOrigin } from "@/server/http";
import { planningError } from "@/server/intelligence/http";
import { transcribeVoice } from "@/server/intelligence/voice";
import { nativeAudioFile, nativeVoiceAuthority, voiceHeaders } from "@/server/intelligence/voice-http";
export const runtime = "nodejs";
export const maxDuration = 180;
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const { authority, scope } = await nativeVoiceAuthority(request);
    const result = await transcribeVoice(authority, scope, await nativeAudioFile(request));
    return new Response(result.text, { headers: { ...voiceHeaders(result.run.id), "Content-Type": "text/plain; charset=utf-8" } });
  } catch (error) { return planningError(error); }
}
