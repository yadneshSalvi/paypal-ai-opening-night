/** Actual installed8 widgets and lifecycle; geometry is a controlled DOM model, not browser acceptance. */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dom, pause, viewport } from "./intelligence-presentation-dom";
const { nativeProductionAssistant } = await import("../src/components/intelligence/native-assistant");
const { default: ChatButton } = await import("@bryntum/core-enterprise/lib/Core/widget/chat/ChatButton.js");
const { Gantt, ProjectModel } = await import("@bryntum/gantt-enterprise");
const { AjaxHelper } = await import("@bryntum/core-enterprise");
const { default: Promissory } = await import("@bryntum/core-enterprise/lib/Core/helper/util/Promissory.js");
let button: any = null, gantt: any = null, project: any = null, dispatches = 0, controlledAudioRequests = 0;
const originalAjax = AjaxHelper.fetch, originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices"), originalContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext"), originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
async function open(width = 390, height = 844) {
  viewport(width, height);
  const config = nativeProductionAssistant({ tenantId: "10000000-0000-4000-8000-000000000010", initial: null, sessionExpiresAt: "2030-01-01T00:00:00.123456Z", sessionAccessId: "d".repeat(64), onRun: () => { dispatches++; }, onTool: () => { dispatches++; } }) as any;
  project = new ProjectModel({ timeZone: "America/Chicago", startDate: "2026-11-14T16:00:00Z", calendars: [{ id: "all-hours", unspecifiedTimeIsWorking: true }], calendar: "all-hours", tasks: [{ id: "synthetic-control-call", name: "Controlled display fixture only", startDate: "2026-11-14T16:00:00Z", duration: 30, durationUnit: "minute", manuallyScheduled: true }] }); await project.commitAsync();
  gantt = new Gantt({ appendTo: document.body, width, height: 480, readOnly: true, detectCSSCompatibilityIssues: false, project, columns: [{ type: "name", width: 150 }], features: { ai: config } });
  button = gantt.features.ai.chatButton; assert.equal(button.constructor, ChatButton); button.element.focus(); await button.open(); await pause(); assert.ok(button.chatPanel.audioController); return button.chatPanel as any;
}
async function escape(popup: any) { popup.messageField.focus(); popup.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); await pause(); }
function actualControls(popup: any) {
  return [ ["Close", popup.tools.close], ["Send", popup.messageField.triggers.send], ["Microphone", popup.messageField.triggers.mic] ] as const;
}
afterEach(async () => { gantt?.destroy(); gantt = null; button = null; if (project && !project.isDestroyed) project.destroy(); project = null; await pause(); document.body.replaceChildren(); sessionStorage.clear(); Object.defineProperty(document, "hidden", { configurable: true, value: false }); AjaxHelper.fetch = originalAjax; for (const [target, name, descriptor] of [[navigator, "mediaDevices", originalMedia], [globalThis, "AudioContext", originalContext], [globalThis, "MediaRecorder", originalRecorder]] as const) { if (descriptor) Object.defineProperty(target, name, descriptor); else Reflect.deleteProperty(target, name); } assert.equal(dispatches, 0); const guard = (globalThis as any).openingModelPresentationGuard; assert.equal(guard.counts.blocked, 0, JSON.stringify(guard.events)); });
after(() => { console.log(JSON.stringify({ qualification: "installed_chat_control_and_lifecycle", browserHitBounds: "requires_root_native", providerCalls: dispatches, controlledInMemoryAudioRequests: controlledAudioRequests, network: (globalThis as any).openingModelPresentationGuard.counts })); dom.window.close(); });

for (const [width, height] of [[1280, 720], [390, 844], [320, 780]]) test(`installed interactive control widgets have explicit44px bounds at${width}`, async () => {
  const popup = await open(width, height); popup.messageField.value = "Controlled unsent draft"; popup.onTextFieldInput({ source: popup.messageField });
  const measured = actualControls(popup).map(([label, widget]) => ({ label, width: widget.width, height: widget.height, tag: widget.element.tagName }));
  for (const [label, widget] of actualControls(popup)) { assert.equal(widget.element.tagName, "BUTTON", label + " must be the actual button"); assert.equal(widget.element.style.width, "44px", label + " actual interactive element needs an explicit44px width, distinct from geometry shims: " + JSON.stringify(measured)); assert.equal(widget.element.style.height, "44px", label + " actual interactive element height"); assert.ok(widget.element.matches("button")); }
});
test("inactive Escape and reopen preserve original voice guidance and exact unsent text", async () => {
  const popup = await open(), original = popup.widgetMap.openingVoiceStatus.html, draft = "Editable text stays exactly here.\nNo planning request.";
  popup.messageField.value = draft; popup.onTextFieldInput({ source: popup.messageField }); await escape(popup); assert.equal(popup.isVisible, false); assert.equal(document.activeElement, button.element);
  await button.open(); await pause(); assert.equal(popup.widgetMap.openingVoiceStatus.html, original); assert.equal(popup.messageField.value, draft); assert.doesNotMatch(popup.widgetMap.openingVoiceStatus.element.textContent, /Audio stopped/);
});
test("inactive actual Close click keeps collapsed guidance without a false stop receipt", async () => {
  const popup = await open(), original = popup.widgetMap.openingVoiceStatus.html; popup.tools.close.element.click(); await pause(); assert.equal(popup.isVisible, false); await button.open(); await pause(); assert.equal(popup.widgetMap.openingVoiceStatus.html, original); assert.ok(popup.element.querySelector(".opening-native-voice-help"));
});
test("mic and Send remain separate keyboard-operable buttons without textarea Enter propagation", async () => {
  const popup = await open(), text = "Exact unsent keyboard draft"; popup.messageField.value = text; popup.onTextFieldInput({ source: popup.messageField }); let bubbled = 0;
  popup.messageField.element.addEventListener("keydown", () => { bubbled++; });
  for (const trigger of [popup.messageField.triggers.mic, popup.messageField.triggers.send]) { trigger.element.focus(); assert.equal(document.activeElement, trigger.element); assert.equal(trigger.element.tabIndex, 0); for (const key of ["Enter", " "]) trigger.element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); }
  assert.equal(bubbled, 0); assert.equal(popup.messageField.value, text); assert.equal(dispatches, 0);
});
test("inactive visibility lifecycle preserves a previous permission refusal notice", async () => {
  const popup = await open(); popup.widgetMap.openingVoiceStatus.html = '<p role="status">Controlled permission refusal. Continue by typing.</p>'; const original = popup.widgetMap.openingVoiceStatus.html;
  Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); await pause(); Object.defineProperty(document, "hidden", { configurable: true, value: false });
  assert.equal(popup.widgetMap.openingVoiceStatus.html, original);
});
test("scoped control CSS sizes the actual native buttons without depending on the glyph", async () => {
  const popup = await open(320, 780), css = await readFile(new URL("../src/app/intelligence.css", import.meta.url), "utf8");
  assert.ok(/\.opening-native-planner[^{}]*\.b-tool\[data-ref=["']?close/.test(css), "Scoped close-tool hit-box rule is required");
  for (const [, widget] of actualControls(popup)) { const style = getComputedStyle(widget.element); assert.equal(style.minWidth, "44px"); assert.equal(style.minHeight, "44px"); assert.notEqual(style.flexShrink, "1"); }
});

function controlledHardware(permission: Promise<MediaStream>) {
  const measurements = { contextClosed: 0, recorderStopped: 0 };
  class ControlledContext {
    state = "running"; async resume() {} async close() { this.state = "closed"; measurements.contextClosed++; }
    createAnalyser() { return { fftSize: 32, getByteTimeDomainData(array: Uint8Array) { array.fill(128); } }; }
    createMediaStreamSource() { return { connect() {} }; }
  }
  class ControlledRecorder extends dom.window.EventTarget {
    state = "inactive"; start() { this.state = "recording"; }
    stop() { assert.notEqual(this.state, "inactive", "The reviewed manager must guard repeated stop"); this.state = "inactive"; measurements.recorderStopped++; queueMicrotask(() => this.dispatchEvent(new Event("stop"))); }
  }
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: ControlledContext }); Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: ControlledRecorder }); Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => permission } });
  return measurements;
}
test("pending microphone permission is invalidated on Escape and a late stream is stopped", { timeout: 6000 }, async () => {
  const popup = await open(), permission = deferred<MediaStream>(), measurements = controlledHardware(permission.promise); let tracksStopped = 0;
  const draft = "Original unsent words"; popup.messageField.value = draft; const pending = popup.toggleRecording(); await pause(); assert.equal(popup.audioController.isRecording, true); assert.equal(popup.widgetMap.openingCancelRecording.hidden, false);
  await escape(popup); permission.resolve({ getTracks: () => [{ stop() { tracksStopped++; } }] } as unknown as MediaStream); await pending; await pause(); assert.ok(tracksStopped >= 1); assert.equal(measurements.contextClosed, 1); assert.equal(measurements.recorderStopped, 0); assert.equal(popup.audioController.isRecording, false); assert.equal(popup.messageField.value, draft); await button.open(); assert.match(popup.widgetMap.openingVoiceStatus.element.textContent, /Audio stopped/);
});
test("active recording cancellation still stops the recorder and discards its audio", { timeout: 6000 }, async () => {
  let tracksStopped = 0; const stream = { getTracks: () => [{ stop() { tracksStopped++; } }] } as unknown as MediaStream;
  const measurements = controlledHardware(Promise.resolve(stream)), popup = await open(), pending = popup.toggleRecording(); await pause(); assert.equal(popup.audioController.isRecording, true); assert.equal(popup.widgetMap.openingCancelRecording.hidden, false);
  popup.widgetMap.openingCancelRecording.element.click(); await pending; await pause(); assert.equal(measurements.recorderStopped, 1); assert.ok(tracksStopped >= 1); assert.equal(measurements.contextClosed, 1); assert.equal(popup.audioController.isRecording, false); assert.match(popup.widgetMap.openingVoiceStatus.element.textContent, /Audio stopped/); assert.ok(!popup.messageField.value);
});
test("a transcript already pending at close never becomes an automatic send or editable addition", { timeout: 6000 }, async () => {
  const popup = await open(), transcript = deferred<string>(), controller = popup.audioController; controller.$audioManager.startRecording = async () => new Blob(["controlled audio bytes"]); controller.transcribe = () => transcript.promise;
  popup.messageField.value = "Keep this draft"; const pending = popup.toggleRecording(); await pause(); assert.equal(controller.isRecording, true); await escape(popup); transcript.resolve("Late cancelled transcript"); await pending; await pause(); await button.open(); assert.equal(popup.messageField.value, "Keep this draft"); assert.match(popup.widgetMap.openingVoiceStatus.element.textContent, /Audio stopped/); assert.equal(dispatches, 0);
});
test("pending read-aloud cancellation aborts the exact in-memory request and keeps stopped state", { timeout: 6000 }, async () => {
  const popup = await open(), controller = popup.audioController; let aborted = false;
  AjaxHelper.fetch = ((url: string, options: { signal: AbortSignal }) => { assert.ok(url.startsWith("/api/intelligence/voice/speak?")); controlledAudioRequests++; return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => { aborted = true; reject(new DOMException("Controlled in-memory request cancelled", "AbortError")); }, { once: true })); }) as typeof AjaxHelper.fetch;
  const pending = controller.speak("Controlled read-aloud lifecycle, never a provider request"); await pause(); assert.equal(controller.isWaitingForAudio, true); await escape(popup); await pending; await pause(); assert.equal(aborted, true); assert.equal(controller.isWaitingForAudio, false); await button.open(); assert.match(popup.widgetMap.openingVoiceStatus.element.textContent, /stopped/i); assert.doesNotMatch(popup.widgetMap.openingVoiceStatus.element.textContent, /Playback complete/);
});
test("active read-aloud still stops its controlled native player on close", { timeout: 6000 }, async () => {
  const popup = await open(), controller = popup.audioController, playback = new Promissory<void>(); let paused = 0;
  AjaxHelper.fetch = (async (url: string) => { assert.ok(url.startsWith("/api/intelligence/voice/speak?")); controlledAudioRequests++; return new Response(new Blob(["controlled WAV fixture"])); }) as typeof AjaxHelper.fetch;
  controller.$audioManager.startBufferedPlayback = async () => { controller.$audioManager.$playbackPromise = playback; controller.$audioManager.$audioElement = { pause() { paused++; playback.resolve(); controller.$audioManager.$playbackPromise = null; } }; await playback.promise; };
  const pending = controller.speak("Controlled in-memory playback"); await pause(); assert.equal(controller.isSpeaking, true); await escape(popup); await pending; await pause(); assert.ok(paused >= 1); assert.equal(controller.isSpeaking, false); await button.open(); assert.match(popup.widgetMap.openingVoiceStatus.element.textContent, /stopped/i); assert.doesNotMatch(popup.widgetMap.openingVoiceStatus.element.textContent, /Playback complete/);
});
test("an actual permission refusal remains visible after inactive close and reopen", { timeout: 6000 }, async () => {
  const popup = await open(); controlledHardware(Promise.reject(new DOMException("Controlled refusal", "NotAllowedError"))); await popup.toggleRecording(); await pause(); assert.match(popup.widgetMap.openingVoiceStatus.element.textContent, /Microphone access was not granted/); const original = popup.widgetMap.openingVoiceStatus.html; await escape(popup); await button.open(); await pause(); assert.equal(popup.widgetMap.openingVoiceStatus.html, original);
});
