import { cookies } from "next/headers";
import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { voiceScopeSchema, voiceLimits } from "@/domain/voice";
import { boundedBytes } from "../bounded-body";
import { currentActor, SESSION_COOKIE } from "../http";
import { sessionTokenHash } from "../session-records";
import { requirePlanningAuthority, withPlanningTransaction, type IntelligenceAuthority } from "./ledger";

/** Native AjaxHelper has no custom scope header. Its fixed URL names the displayed production. */
export async function nativeVoiceAuthority(request: Request, scoped = true) {
  const params = new URL(request.url).searchParams;
  const production = params.get("production"), scope = params.get("scope");
  if (!z.uuid().safeParse(production).success || (scoped && !voiceScopeSchema.safeParse({ production, scope }).success)) throw new DomainError("VOICE_SCOPE_REQUIRED", "Open audio from the current production desk.", 400);
  const actor = await currentActor(request);
  if (!actor) throw new DomainError("SESSION_REQUIRED", "Open your current production session.", 401);
  if (actor.tenantId !== production) throw new DomainError("PRODUCTION_CHANGED", "This audio control belongs to another rehearsal. Reload the current production before using it.", 409);
  const authorization = request.headers.get("authorization"), token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new DomainError("SESSION_REQUIRED", "Open your current production session.", 401);
  const authority: IntelligenceAuthority = { actor, sessionHash: sessionTokenHash(token) };
  await withPlanningTransaction(db => requirePlanningAuthority(db, authority));
  return { authority, scope: scope! };
}
export async function nativeAudioFile(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data;")) throw new DomainError("VOICE_MULTIPART_REQUIRED", "The native microphone sends a recorded audio file.", 415);
  const bytes = await boundedBytes(request, voiceLimits.inputBytes + 32768);
  let form: FormData;
  try { form = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": type } }).formData(); }
  catch { throw new DomainError("VOICE_MULTIPART_INVALID", "The recording upload could not be read.", 400); }
  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0]![0] !== "audio" || typeof entries[0]![1] === "string") throw new DomainError("VOICE_AUDIO_REQUIRED", "Send one audio recording from the production desk.", 400);
  const file = entries[0]![1] as File;
  if (file.size > voiceLimits.inputBytes) throw new DomainError("VOICE_AUDIO_SIZE", "The recording exceeds the 4 MB audio limit.", 413);
  return Buffer.from(await file.arrayBuffer());
}
export function voiceHeaders(id?: string) { return { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...(id ? { "X-Opening-Voice-Request": id } : {}) }; }
/** Serve only a fully verified retained WAV. Streaming avoids a buffered serverless response limit. */
export function savedWaveResponse(id: string, bytes: Buffer) {
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { if (offset >= bytes.length) { controller.close(); return; } const end = Math.min(offset + 65536, bytes.length); controller.enqueue(new Uint8Array(bytes.subarray(offset, end))); offset = end; } });
  return new Response(body, { headers: { ...voiceHeaders(id), "Content-Type": "audio/wav", "X-Opening-Audio-Bytes": String(bytes.length) } });
}
