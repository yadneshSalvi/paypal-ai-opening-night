// Narrow declarations for inspected, pinned Enterprise 8.0.0 experimental hooks.
declare module "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/agents/DefaultGanttAgent.js" {
  export interface NativeToolInput { args: unknown; toolCall?: { id: string }; promptContext?: Record<string, unknown> }
  export interface NativeTool { fn: (input: NativeToolInput) => unknown; [key: string]: unknown }
  export default class DefaultGanttAgent {
    constructor(config: Record<string, unknown>);
    static $name: string;
    get agentTools(): Record<string, NativeTool>;
    beforePost?: (body: Record<string, unknown>) => void;
    client: { features: { ai: { chatPanel?: { widgetMap: { openingPlan?: { html: string; hidden: boolean; element?: HTMLElement } } } } } };
    $plan?: { goal?: string; steps: { id: number; description: string; completed: boolean }[] };
    processResponse(response: unknown, context: Record<string, unknown>): Promise<unknown>;
  }
}
declare module "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/toolhosts/GanttToolHost.js" {
  import type { NativeTool } from "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/agents/DefaultGanttAgent.js";
  export default class GanttToolHost {
    constructor(config: Record<string, unknown>);
    static $name: string;
    _configuredTools: Record<string, NativeTool>;
    get tools(): Record<string, NativeTool>;
  }
}
declare module "@bryntum/core-enterprise/lib/Core/helper/util/Promissory.js" {
  export default class Promissory<T = unknown> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
}
declare module "@bryntum/core-enterprise/lib/Core/util/AudioManager.js" {
  import Promissory from "@bryntum/core-enterprise/lib/Core/helper/util/Promissory.js";
  export default class AudioManager {
    constructor(config?: Record<string, unknown>);
    static $name: string;
    isDestroyed: boolean; isPlaying: boolean;
    $cancelled: boolean; $recordingStream: MediaStream | null; $mediaRecorder: MediaRecorder | null;
    $audioChunks: Blob[]; $speechDetected: boolean; $recordingPromise: Promissory<Blob | null>;
    $playbackPromise: Promissory | null; $audioElement: HTMLAudioElement | null;
    startRecording(options?: { silenceTimeout?: number; noSpeechTimeout?: number }): Promise<Blob | null>;
    stopRecording(cancel?: boolean): void;
    onMediaRecorderDataAvailable(event: BlobEvent): void; onMediaRecorderStop(): void;
    checkForSilence(analyser: AnalyserNode, silenceTimeout?: number, noSpeechTimeout?: number): void;
    startBufferedPlayback(response: Response): Promise<void>; internalStartPlayback(url: string): Promise<void>;
    stopPlayback(): Promise<void>; destroy(): void; doDestroy(): void;
  }
}
declare module "@bryntum/core-enterprise/lib/Core/widget/chat/AIChatPopup.js" {
  import AudioManager from "@bryntum/core-enterprise/lib/Core/util/AudioManager.js";
  interface NativeAudioController {
    $audioManager: AudioManager; isRecording: boolean; isSpeaking: boolean; isWaitingForAudio: boolean;
    startRecording(): Promise<string | null>; stopRecording(cancel?: boolean): void; stopAll(cancel?: boolean): void; stopSpeaking(): void;
    ion(config: Record<string, unknown>): void;
  }
  interface NativeMessageField { value: string | null; maxHeight: number | string; element: HTMLElement; clear(): void; focus(): void }
  export default class AIChatPopup {
    constructor(config?: Record<string, unknown>);
    static $name: string; static type: string; static configurable: Record<string, unknown>; static initClass(): void;
    isDestroyed: boolean; isVisible: boolean; type: string; drawer: unknown; showAnimation: boolean | object; x: number; y: number; audioController: NativeAudioController | null;
    element: HTMLElement; width: number | string; height: number | string; minHeight: number | string; maxHeight: number | string;
    setConfig(config: Record<string, unknown>): void; setXY(x?: number, y?: number): void; alignTo(spec?: unknown): void;
    showBy(alignment: unknown): Promise<unknown>; hide(): Promise<void>;
    widgetMap: Record<string, { hidden: boolean; html: string; element: HTMLElement }>;
    addMessage(message: Record<string, unknown> | Promise<Record<string, unknown>>): Promise<void>;
    messageField: NativeMessageField;
    micButton: { ariaLabel: string };
    updateAudioController(controller: NativeAudioController): void;
    onControllerTranscription(event: { text: string }): void;
    onControllerRecordingStart(): void; onControllerRecordingStop(): void;
    onControllerSpeakStart(): void; onControllerSpeakEnd(): void;
    onBeforeRenderMessage(event: { messageTools: Record<string, Record<string, unknown>> }): void;
    onMessageEnter(...args: unknown[]): void; onTextFieldInput(event: { source: NativeMessageField }): void;
    onStopClick(): void; toggleRecording(): void; show(): Promise<void>;
    afterHide(...args: unknown[]): void; doDestroy(): void;
  }
}
declare module "@bryntum/core-enterprise/lib/Core/widget/chat/ChatButton.js" {
  import { Button } from "@bryntum/core-enterprise";
  export default class ChatButton extends Button {
    constructor(config?: Record<string, unknown>);
    static $name: string; static type: string; static initClass(): void;
    changeChatPanel(config: Record<string, unknown> | null, old: unknown): unknown;
    open(): Promise<void>;
  }
}
