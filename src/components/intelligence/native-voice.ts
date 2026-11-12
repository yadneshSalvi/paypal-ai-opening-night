"use client";
import { EventHelper, StringHelper } from "@bryntum/core-enterprise";
import AudioManager from "@bryntum/core-enterprise/lib/Core/util/AudioManager.js";
import AIChatPopup from "@bryntum/core-enterprise/lib/Core/widget/chat/AIChatPopup.js";
import Promissory from "@bryntum/core-enterprise/lib/Core/helper/util/Promissory.js";
import { finishVoicePlayback, transcriptDraft, voiceLimits, voicePlaybackText, type VoicePlaybackState } from "@/domain/voice";

/** Preserve the installed trigger handler, with a real keyboard-operable button. */
export function nativeAudioTrigger(label: string) {
  return { tag: "button", width: 44, height: 44, minWidth: 44, minHeight: 44, ariaLabel: label, compose(this: { ariaLabel?: string; disabled?: boolean }, config: { tag?: string; type?: string; title?: string; tabIndex?: number; disabled?: boolean | null; listeners: Record<string, unknown>; "aria-hidden"?: boolean; "aria-label"?: string }) {
    delete config["aria-hidden"]; delete config.listeners.keypress;
    config.tag = "button"; config.type = "button"; config.tabIndex = 0;
    // DomSync serializes attributes, so disabled=false still disables an HTML button.
    config.disabled = this.disabled ? true : null;
    config["aria-label"] = config.title = this.ariaLabel || label;
    // The textarea's Enter keymap must not also send while a trigger has focus.
    config.listeners.keydown = (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); };
  } };
}

/** Keeps native analysis/recording/playback; guards its asynchronous permission and file-player seams. */
class ReviewedAudioManager extends AudioManager {
  static $name = "OpeningNightAudioManager";
  private generation = 0;
  private playbackGeneration = 0;
  private recordingLimit: ReturnType<typeof setTimeout> | null = null;
  private context: AudioContext | null = null;
  override async startRecording({ silenceTimeout, noSpeechTimeout }: { silenceTimeout?: number; noSpeechTimeout?: number } = {}): Promise<Blob | null> {
    const generation = ++this.generation, context = new AudioContext(); this.context = context; this.$cancelled = false;
    let ownedStream: MediaStream | null = null;
    try {
      await context.resume();
      if (generation !== this.generation || this.isDestroyed || document.hidden) return null;
      const stream = ownedStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== this.generation || this.isDestroyed || document.hidden) { stream.getTracks().forEach(track => track.stop()); return null; }
      const analyser = context.createAnalyser(), source = context.createMediaStreamSource(stream), recorder = new MediaRecorder(stream);
      this.$recordingStream = stream; this.$mediaRecorder = recorder; this.$audioChunks = []; this.$speechDetected = false;
      this.$recordingPromise = new Promissory<Blob | null>();
      source.connect(analyser);
      EventHelper.on({ element: recorder, dataavailable: this.onMediaRecorderDataAvailable, stop: this.onMediaRecorderStop, thisObj: this });
      recorder.addEventListener("error", () => { this.stopRecording(true); this.$recordingPromise?.reject(new Error("The native microphone recorder stopped unexpectedly.")); }, { once: true });
      recorder.start();
      this.recordingLimit = setTimeout(() => this.stopRecording(false), voiceLimits.recordingMs);
      this.checkForSilence(analyser, silenceTimeout, noSpeechTimeout);
      return await this.$recordingPromise.promise;
    } finally {
      if (this.recordingLimit) clearTimeout(this.recordingLimit); this.recordingLimit = null;
      ownedStream?.getTracks().forEach(track => track.stop()); if (this.$recordingStream === ownedStream) this.$recordingStream = null;
      if (context.state !== "closed") await context.close().catch(() => undefined);
      if (this.context === context) this.context = null;
    }
  }
  override stopRecording(cancel = false) {
    if (cancel) this.generation++;
    // Native MediaRecorder.stop throws after it has already stopped.
    if (this.$mediaRecorder?.state === "inactive") this.$mediaRecorder = null;
    super.stopRecording(cancel);
  }
  override async startBufferedPlayback(response: Response) {
    const generation = this.playbackGeneration, blob = await response.blob();
    if (generation !== this.playbackGeneration || this.isDestroyed || document.hidden) return;
    if (blob.size > voiceLimits.outputBytes + 44) throw new Error("This read-aloud exceeds its audio limit.");
    const url = URL.createObjectURL(blob);
    // Bryntum's buffered path hardcodes audio/mpeg. Its native file player supports the bounded WAV bridge.
    try { await this.internalStartPlayback(url); }
    catch (error) { this.$playbackPromise?.resolve(undefined); this.$playbackPromise = null; this.$audioElement?.pause(); throw error; }
    finally { URL.revokeObjectURL(url); }
  }
  cancelPlayback() {
    this.playbackGeneration++;
    if (this.isPlaying) void this.stopPlayback();
  }
  cancelAll() { this.stopRecording(true); this.cancelPlayback(); }
  override doDestroy() { this.cancelAll(); void this.context?.close().catch(() => undefined); super.doDestroy(); }
}

export class ReviewedNativeChatPopup extends AIChatPopup {
  static $name = "OpeningNightReviewedChat";
  static type = "openingnightreviewedchat";
  static configurable = { onVoiceSaved: null, voiceProduction: null };
  declare onVoiceSaved: (() => void) | null;
  declare voiceProduction: string | null;
  private declare visibilityChanged: (() => void) | undefined;
  private declare receiveDraft: ((event: Event) => void) | undefined;
  private declare discardTranscript: boolean | undefined;
  private declare recordingActive: boolean | undefined;
  private declare playbackState: VoicePlaybackState | undefined;
  override updateAudioController(controller: NonNullable<AIChatPopup["audioController"]>) {
    if (controller && !(controller.$audioManager instanceof ReviewedAudioManager)) { controller.$audioManager.destroy(); controller.$audioManager = new ReviewedAudioManager({ debugMode: false }); }
    super.updateAudioController(controller);
    controller?.ion({ transcriptionError: () => this.notice("Transcription could not finish. Its saved request remains in the audio record. You can continue by typing."), playbackStart: () => this.showPlayback("playing"), speakError: () => this.showPlayback("failed"), noAudioDetected: () => this.notice("No speech was detected. Type your request or choose Record to try another recording."), thisObj: this });
    this.visibilityChanged ??= () => { if (document.hidden) this.cancelVoice(); };
    this.receiveDraft ??= (event: Event) => {
      const value = (event as CustomEvent<{ production: string; text: string }>).detail;
      if (value?.production !== this.voiceProduction || typeof value.text !== "string") return;
      void this.show().then(() => { this.discardTranscript = false; this.onControllerTranscription({ text: value.text }); });
    };
    document.addEventListener("visibilitychange", this.visibilityChanged); window.addEventListener("opening-night-voice-draft", this.receiveDraft);
  }
  private notice(text: string) {
    const widget = this.widgetMap.openingVoiceStatus;
    if (widget && !this.isDestroyed) widget.html = `<p role="status" aria-live="polite">${StringHelper.encodeHtml(text)}</p>`;
    this.onVoiceSaved?.();
  }
  private showPlayback(state: VoicePlaybackState) {
    this.playbackState = state;
    const control = this.widgetMap.openingStopReadAloud;
    if (control) control.hidden = !["preparing", "playing"].includes(state);
    this.notice(voicePlaybackText[state]);
  }
  override onBeforeRenderMessage(event: { messageTools: Record<string, Record<string, unknown>> }) {
    super.onBeforeRenderMessage(event);
    if (event.messageTools.readAloud) Object.assign(event.messageTools.readAloud, { type: "button", "aria-label": "Read this message aloud with an AI-generated voice", title: "Read this message aloud with an AI-generated voice" });
  }
  override onControllerTranscription({ text }: { text: string }) {
    if (this.discardTranscript || this.isDestroyed || !this.isVisible || document.hidden) { this.onVoiceSaved?.(); return; }
    this.messageField.value = transcriptDraft(this.messageField.value ?? "", text);
    this.onTextFieldInput({ source: this.messageField }); this.messageField.focus();
    this.notice("Transcript added to your editable draft. Review the words and choose Send when ready. Nothing has been sent to the planning assistant.");
  }
  override onControllerRecordingStart() {
    this.recordingActive = true;
    this.discardTranscript = false;
    super.onControllerRecordingStart(); this.widgetMap.openingCancelRecording.hidden = false; this.micButton.ariaLabel = "Finish recording and review transcript";
    this.notice("Recording · up to one minute. Choose the microphone again to finish, or Cancel recording to discard it.");
  }
  override onControllerRecordingStop() {
    this.recordingActive = false;
    super.onControllerRecordingStop(); this.widgetMap.openingCancelRecording.hidden = true; this.micButton.ariaLabel = "Record a planning draft";
  }
  override async toggleRecording() {
    if (!this.audioController || this.isDestroyed) return;
    if (this.audioController.isRecording) { this.audioController.stopRecording(); this.notice("Preparing a transcript for your review…"); return; }
    if (!this.isVisible || document.hidden) return;
    try { await this.audioController.startRecording(); }
    catch (error) { this.notice(error instanceof DOMException && ["NotAllowedError", "PermissionDeniedError"].includes(error.name) ? "Microphone access was not granted. You can type the same planning request." : "The microphone could not open. Your typed draft is still available."); }
  }
  private hasVoiceActivity() {
    const controller = this.audioController;
    return Boolean(this.recordingActive || controller?.isRecording || controller?.isSpeaking || controller?.isWaitingForAudio || ["preparing", "playing"].includes(this.playbackState ?? "idle"));
  }
  cancelVoice(announce = this.hasVoiceActivity()) {
    this.discardTranscript = true;
    this.recordingActive = false;
    if (["preparing", "playing"].includes(this.playbackState ?? "idle")) this.playbackState = "stopped";
    this.audioController?.stopAll(true); (this.audioController?.$audioManager as ReviewedAudioManager | undefined)?.cancelAll();
    if (this.widgetMap.openingStopReadAloud) this.widgetMap.openingStopReadAloud.hidden = true;
    if (announce) this.notice("Audio stopped. Your editable text remains available; no transcript was automatically sent.");
  }
  clearVoiceDraft() { this.discardTranscript = true; this.messageField.clear(); this.onTextFieldInput({ source: this.messageField }); this.notice("Draft cleared. Type a request or choose Record when ready."); }
  stopReadAloud() { this.showPlayback("stopped"); (this.audioController?.$audioManager as ReviewedAudioManager | undefined)?.cancelPlayback(); this.audioController?.stopSpeaking(); }
  override onControllerSpeakStart() { super.onControllerSpeakStart(); this.showPlayback("preparing"); }
  override onControllerSpeakEnd() { super.onControllerSpeakEnd(); this.showPlayback(finishVoicePlayback(this.playbackState ?? "idle")); }
  override onStopClick() { if (this.audioController?.isSpeaking || this.audioController?.isWaitingForAudio) this.stopReadAloud(); else super.onStopClick(); }
  override onMessageEnter(...args: unknown[]) { super.onMessageEnter(...args); if (!this.messageField.value) this.notice("Request sent for planning. Any resulting proposal still needs its separate review."); }
  override afterHide(...args: unknown[]) {
    // Native afterHide may clear controller flags synchronously. Preserve the
    // actual pre-hide activity, while an untouched dialog keeps its guidance.
    const active = this.hasVoiceActivity(); super.afterHide(...args); this.cancelVoice(active);
  }
  override doDestroy() { if (this.visibilityChanged) document.removeEventListener("visibilitychange", this.visibilityChanged); if (this.receiveDraft) window.removeEventListener("opening-night-voice-draft", this.receiveDraft); this.audioController?.stopAll(true); super.doDestroy(); }
}
ReviewedNativeChatPopup.initClass();
