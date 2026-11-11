// Controlled local native qualification only. Import the credential guard before dotenv or application code.
import "./disabled-providers.mjs";
import "./intelligence-fixture-provider.mjs";
import { createHash, randomUUID } from "node:crypto";
if (process.env.VERCEL || process.env.OPENING_NIGHT_AI_QA !== "1" || ["OPENAI_API_KEY", "GEMINI_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"].some(key => process.env[key])) throw new Error("Voice/source QA requires disabled actual providers");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
globalThis.openingNightVoiceQa = {
  configured: true, mode: "controlled_fixture",
  fetch: async (url, init) => {
    if (String(url) !== "https://api.openai.com/v1/audio/transcriptions" || init?.method !== "POST" || !(init.body instanceof FormData)) throw new Error("Unexpected controlled transcription request");
    return Response.json({ text: "Can Tom take LX programming? Check the qualification before proposing a change.", languages: [{ code: "en" }] }, { headers: { "x-request-id": `req_qa_${randomUUID().replaceAll("-", "")}` } });
  },
  speech: { generate: async (input, observer) => {
    const suffix = randomUUID().replaceAll("-", ""), sessionId = `sess_qa_${suffix}`, responseId = `resp_qa_${suffix}`, pcm = Buffer.alloc(48000);
    // One second of generated tones, explicitly a controlled audio fixture, never a real speaker or microphone result.
    for (let index = 0; index < 24000; index++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * (index < 12000 ? 440 : 660) * index / 24000) * 2400 * Math.min(1, index / 500, (24000 - index) / 500)), index * 2);
    await observer.session?.(sessionId, "gpt-realtime-2.1-mini"); await observer.dispatch(); await observer.response?.(responseId);
    await observer.chunk?.(0, `event_qa_${suffix}`, pcm);
    const receipt = { model: "gpt-realtime-2.1-mini", voice: "marin", sessionId, responseId, transcript: input.text, sampleRate: 24000, byteLength: pcm.length, contentHash: sha(pcm), latencyMs: 1, usage: { controlled_fixture: true } };
    await observer.complete?.(receipt); return { pcm, receipt };
  } },
};
globalThis.openingNightSourceQa = {
  configured: true, mode: "controlled_fixture",
  fetch: async (url, init) => {
    if (String(url) !== "https://api.openai.com/v1/responses" || init?.method !== "POST") throw new Error("Unexpected controlled source request");
    const request = JSON.parse(String(init.body)), input = JSON.parse(request.input[0].content[0].text), source = input.sources[0], base = input.selectedProduction;
    const prefixes = ["Production: The Night Ferries.", "Lighting paperwork review:", "Priya Shah is a person", "Hard amplified audio curfew:", "The paperwork call may start"];
    const units = prefixes.map(prefix => source?.extraction?.units.find(unit => unit.text.startsWith(prefix)));
    if (input.sources.length !== 1 || units.some(unit => !unit)) return Response.json({ error: { message: "This controlled provider accepts only the owned five-line lighting addendum fixture." } }, { status: 422 });
    const fact = (value, index = 0) => ({ value, citations: [{ sourceId: source.id, unitId: units[index].id, quote: units[index].text }], assumption: null });
    const priya = base.resources.find(item => item.id === "priya");
    const graph = {
      schemaVersion: 2, baselineRetention: input.compilationContract.baselineRetention, summary: "Add a sourced lighting paperwork review between existing programming and later calls. This proposal uses controlled model output and still requires producer review.",
      production: { title: fact(base.title), venue: fact(base.venue), zone: fact(base.zone), showDate: fact(base.showDate) },
      policy: { curfewAt: fact(base.curfewAt, 3), accessUntil: fact(base.accessUntil, 3), minimumRestMinutes: fact(base.policy.minimumRestMinutes, 3) },
      resources: [{ key: "priya", targetId: "priya", name: fact("Priya Shah", 2), kind: fact("person", 2), department: fact("lighting", 2), skills: fact(priya.skills, 2), availableFrom: fact(priya.availableFrom, 2), availableUntil: fact(priya.availableUntil, 2), capacity: fact(1, 2), hourlyRateMinor: fact(3500, 2) }],
      tasks: [{ key: "paperwork", targetId: null, name: fact("Lighting paperwork review", 1), lane: fact("lighting", 1), start: fact("2026-11-14T16:40:00-06:00", 1), durationMinutes: fact(20, 1), resources: fact(["priya"], 1), requiredSkill: fact("lx_programming", 1), amplified: { value: false, citations: [], assumption: "Treat this paperwork review as an unamplified desk call, as described in the addendum." }, earliestStart: fact("2026-11-14T16:35:00-06:00", 4), latestEnd: fact("2026-11-14T17:15:00-06:00", 4) }],
      dependencies: [], unknowns: [], conflicts: [], unsupportedRequirements: [],
    };
    if (source.extraction.units.some(unit => /CONTROLLED_CONFLICT/.test(unit.text))) graph.conflicts.push({ field: "policy.curfewAt", message: "Controlled conflict fixture: a second source note disputes the curfew. The proposed graph cannot be applied until the source is corrected.", citations: fact(null, 3).citations });
    return Response.json({ id: `resp_qa_source_${randomUUID().replaceAll("-", "")}`, status: "completed", model: "gpt-6.1-sol", store: false, metadata: request.metadata, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(graph) }] }], usage: { controlled_fixture: true } }, { headers: { "x-request-id": `req_qa_${randomUUID().replaceAll("-", "")}` } });
  },
};
