import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { transcriptDraft, voiceLimits, voiceModels } from "../src/domain/voice";
import { audioInput, byteHash, pcmWave } from "../src/server/intelligence/voice";
import { OpenAIRealtimeSpeechGateway, type SpeechObserver, type SpeechRequest } from "../src/server/intelligence/realtime-speech";

test("native transcript augments an editable draft without a planning dispatch", () => {
  assert.equal(transcriptDraft("", "  Ask for a qualified programmer. "), "Ask for a qualified programmer.");
  assert.equal(transcriptDraft("Keep doors at seven. ", "Check Priya."), "Keep doors at seven.\nCheck Priya.");
  assert.throws(() => transcriptDraft("kept", " "));
  assert.throws(() => transcriptDraft("kept", "x".repeat(voiceLimits.transcriptCharacters + 1)));
});
test("native input sniffing corrects misleading WAV labels with actual container metadata", () => {
  const wav = pcmWave(Buffer.alloc(24000)); assert.equal(audioInput(wav).name, "recording.wav");
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(30)]);
  assert.equal(audioInput(webm).mime, "audio/webm"); assert.equal(audioInput(webm).name, "recording.webm");
  const mp4 = Buffer.alloc(30); mp4.write("ftyp", 4); assert.equal(audioInput(mp4).mime, "audio/mp4");
  assert.throws(() => audioInput(Buffer.from("not an audio file of any kind")), /container could not be identified/);
  assert.throws(() => audioInput(Buffer.alloc(voiceLimits.inputBytes + 1)), /4 MB/);
});
test("WAV bridge has exact PCM format, size and bounded output", () => {
  const pcm = Buffer.from([1, 2, 3, 4]), wav = pcmWave(pcm);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF"); assert.equal(wav.readUInt32LE(4), 40); assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readUInt16LE(34), 16); assert.equal(wav.readUInt32LE(40), 4); assert.deepEqual(wav.subarray(44), pcm);
  assert.throws(() => pcmWave(Buffer.alloc(3))); assert.throws(() => pcmWave(Buffer.alloc(0)));
});

function speechWire(options: { wrongModel?: boolean; toolEnabled?: boolean; foreignChunk?: boolean; duplicateChunk?: boolean; disconnected?: boolean } = {}) {
  const id = randomUUID(), pcm = Buffer.alloc(4800, 3), request: SpeechRequest = { operationId: id, model: voiceModels.speak, voice: "marin", locale: "en", text: "Review the next safe move.", instructions: "Read the supplied text.", safetyIdentifier: "f".repeat(64) };
  const sent: Record<string, any>[] = [], socket = new EventEmitter() as EventEmitter & { readyState: number; send: (raw: string) => void; close: () => void; terminate: () => void };
  socket.readyState = 1; socket.close = () => { socket.readyState = 3; }; socket.terminate = socket.close;
  const emit = (event: unknown) => socket.emit("message", Buffer.from(JSON.stringify(event)), false);
  const metadata = { opening_operation: id };
  socket.send = raw => {
    const event = JSON.parse(raw); sent.push(event);
    queueMicrotask(() => {
      if (event.type === "session.update") emit({ type: "session.updated", session: { ...event.session, id: "sess_fixture", tools: options.toolEnabled ? [{ type: "function", name: "approvePlan" }] : [] } });
      if (event.type === "response.create") {
        emit({ type: "response.created", response: { id: "resp_fixture", metadata } });
        const chunk = { type: "response.output_audio.delta", event_id: "event_audio", response_id: options.foreignChunk ? "resp_other" : "resp_fixture", output_index: 0, content_index: 0, item_id: "item_voice", delta: pcm.toString("base64") };
        emit(chunk); if (options.duplicateChunk) emit(chunk);
        if (options.disconnected) { socket.emit("close"); return; }
        emit({ type: "response.output_audio.done", response_id: "resp_fixture", output_index: 0, content_index: 0, item_id: "item_voice" });
        emit({ type: "response.output_audio_transcript.done", response_id: "resp_fixture", output_index: 0, content_index: 0, item_id: "item_voice", transcript: request.text });
        emit({ type: "response.done", response: { id: "resp_fixture", status: "completed", metadata, output: [{ type: "message", role: "assistant", id: "item_voice", content: [{ type: "audio", transcript: request.text }] }], usage: { output_tokens: 12 } } });
      }
    });
  };
  const gateway = new OpenAIRealtimeSpeechGateway(() => { queueMicrotask(() => emit({ type: "session.created", session: { id: "sess_fixture", model: options.wrongModel ? "unapproved-voice" : voiceModels.speak } })); return socket as never; }, 1000);
  const observed: string[] = [], observer: SpeechObserver = { session: async () => { observed.push("session"); }, dispatch: async () => { observed.push("dispatch"); }, response: async () => { observed.push("response"); }, chunk: async () => { observed.push("chunk"); }, complete: async () => { observed.push("complete"); } };
  return { gateway, request, observer, observed, sent, pcm };
}
test("Realtime speech saves ordered identities and verifies the completed stream", async () => {
  const wire = speechWire(), result = await wire.gateway.generate(wire.request, wire.observer);
  assert.deepEqual(wire.observed, ["session", "dispatch", "response", "chunk", "complete"]); assert.deepEqual(result.pcm, wire.pcm); assert.equal(result.receipt.contentHash, byteHash(wire.pcm));
  assert.equal(wire.sent.filter(event => event.type === "response.create").length, 1); assert.deepEqual(wire.sent[1]!.response.tools, []); assert.equal(wire.sent[1]!.response.tool_choice, "none"); assert.equal(wire.sent[1]!.response.conversation, "none");
});
test("Realtime rejects a different model and an enabled tool before response dispatch", async () => {
  for (const options of [{ wrongModel: true }, { toolEnabled: true }]) { const wire = speechWire(options); await assert.rejects(wire.gateway.generate(wire.request, wire.observer)); assert.equal(wire.sent.filter(event => event.type === "response.create").length, 0); }
});
test("Realtime refuses foreign and duplicate chunks; lost streams never reconnect", async () => {
  for (const options of [{ foreignChunk: true }, { duplicateChunk: true }, { disconnected: true }]) { const wire = speechWire(options); await assert.rejects(wire.gateway.generate(wire.request, wire.observer)); assert.equal(wire.sent.filter(event => event.type === "response.create").length, 1); assert.ok(!wire.observed.includes("complete")); }
});
test("actual Realtime adapter refuses provider transport in disabled QA", async () => {
  const request = speechWire().request;
  await assert.rejects(new OpenAIRealtimeSpeechGateway().generate(request, { dispatch: async () => assert.fail("No actual dispatch") }), error => (error as { code: string }).code === "SPEECH_QA_DISABLED");
});
